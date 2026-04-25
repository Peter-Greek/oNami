import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
import { safeStorage } from 'electron'
import { z } from 'zod'

import { ApkgImporter } from './apkgImporter'
import { OnamiDatabase } from './database'
import { SchedulerService, selectCardsForMode, type StudySessionRuntime } from './scheduler'
import type {
  AiGenerationOptions,
  AiGenerationResult,
  AiSettings,
  AppSettings,
  AnswerInput,
  AnswerResult,
  AppStats,
  CreateCardInput,
  CreateDeckInput,
  DeckDetail,
  DeckSummary,
  ImportApkgOptions,
  ImportResult,
  SaveAiSettingsInput,
  SaveAppSettingsInput,
  StatsFilterInput,
  StudyMode,
  StudySession,
  StudySessionSettings,
  ThemeMode,
  UpdateCardInput,
} from '../../src/shared/types'

interface StoredAiSettings {
  encryptedApiKey: string | null
  model: string
}

const AI_SETTINGS_KEY = 'ai.settings'
const APP_SETTINGS_KEY = 'app.settings'
const DEFAULT_AI_MODEL = 'gpt-4o-mini'
const DEFAULT_APP_SETTINGS: AppSettings = {
  audioVolume: 0.8,
  themeMode: 'system',
}

const clampAudioVolume = (value: unknown): number => {
  const volume = Number(value)
  return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : DEFAULT_APP_SETTINGS.audioVolume
}

const normalizeThemeMode = (value: unknown): ThemeMode =>
  value === 'light' || value === 'dark' || value === 'system' ? value : DEFAULT_APP_SETTINGS.themeMode

const aiDraftSchema = z.object({
  cards: z.array(
    z.object({
      frontHtml: z.string().min(1),
      backHtml: z.string().min(1),
      tags: z.array(z.string()).default([]),
      noteType: z.enum(['basic', 'cloze', 'imported']).default('basic'),
      rationale: z.string().optional(),
    })
  ),
})

export class AppServices {
  private readonly importer = new ApkgImporter()
  private readonly scheduler: SchedulerService
  private readonly sessions = new Map<string, StudySessionRuntime>()

  constructor(private readonly database: OnamiDatabase) {
    this.scheduler = new SchedulerService(database)
  }

  getMediaPath(mediaId: string): string | null {
    return this.database.getMediaPath(mediaId)
  }

  createDeck(input: CreateDeckInput): DeckSummary {
    return this.database.createDeck(input)
  }

  deleteDeck(deckId: string): void {
    this.database.deleteDeck(deckId)
  }

  resetDeckScheduling(deckId: string): void {
    this.database.resetDeckScheduling(deckId)
    this.sessions.clear()
  }

  listDecks(): DeckSummary[] {
    return this.database.listDecks()
  }

  getDeck(deckId: string): DeckDetail {
    return this.database.getDeck(deckId)
  }

  createCard(input: CreateCardInput) {
    return this.database.createCard(input)
  }

  updateCard(input: UpdateCardInput) {
    return this.database.updateCard(input)
  }

  deleteCard(cardId: string): void {
    this.database.deleteCard(cardId)
  }

  importApkg(filePath: string, options: ImportApkgOptions): ImportResult {
    const parsed = this.importer.parse(filePath)
    const source = 'anki'
    const mediaIdByName = new Map<string, string>()
    const warnings = [...parsed.warnings]

    try {
      for (const media of parsed.media) {
        const record = this.database.upsertMediaFromFile(media.originalName, media.tempPath)
        mediaIdByName.set(media.originalName, record.id)
      }

      let importedNotes = 0
      let updatedNotes = 0
      let importedCards = 0
      let firstDeckId = ''
      let fallbackDeckId = ''
      let firstCardDeckId = ''

      this.database.importTransaction(() => {
        const deckIdByAnkiId = new Map<string, string>()
        const deckByAnkiId = new Map(parsed.decks.map((deck) => [deck.ankiId, deck]))
        const depthOf = (deck: { parentAnkiId: string | null }): number =>
          deck.parentAnkiId && deckByAnkiId.has(deck.parentAnkiId)
            ? 1 + depthOf(deckByAnkiId.get(deck.parentAnkiId)!)
            : 0
        const sortedDecks = [...parsed.decks].sort((a, b) => depthOf(a) - depthOf(b) || a.name.localeCompare(b.name))

        for (const deck of sortedDecks) {
          const parentId = deck.parentAnkiId ? deckIdByAnkiId.get(deck.parentAnkiId) ?? null : null
          const summary = this.database.upsertImportedDeck({
            name: deck.name,
            parentId,
            source,
            sourceId: `deck:${deck.name}:${deck.ankiId}`,
          })
          deckIdByAnkiId.set(deck.ankiId, summary.id)
          if (!fallbackDeckId) fallbackDeckId = summary.id
          if (!firstDeckId && deck.ankiId !== '1') firstDeckId = summary.id
        }

        if (deckIdByAnkiId.size === 0) {
          const fallback = this.database.upsertImportedDeck({
            name: parsed.rootDeckName || path.basename(filePath, '.apkg'),
            parentId: null,
            source,
            sourceId: `deck:${parsed.rootDeckName || path.basename(filePath, '.apkg')}`,
          })
          deckIdByAnkiId.set('1', fallback.id)
          firstDeckId = fallback.id
          fallbackDeckId = fallback.id
        }

        const noteIdByAnkiId = new Map<string, string>()
        for (const note of parsed.notes) {
          const deckId = deckIdByAnkiId.get(note.deckAnkiId) ?? firstDeckId
          const result = this.database.upsertImportedNote({
            deckId,
            noteType: note.modelName,
            fields: note.fields,
            tags: note.tags,
            sourceGuid: `anki:${note.guid}`,
          })
          noteIdByAnkiId.set(note.ankiId, result.id)
          if (result.updated) updatedNotes += 1
          else importedNotes += 1
        }

        for (const card of parsed.cards) {
          const note = parsed.notes.find((candidate) => candidate.ankiId === card.noteAnkiId)
          const noteId = noteIdByAnkiId.get(card.noteAnkiId)
          if (!note || !noteId) {
            warnings.push(`Card ${card.ankiId} could not be imported because its note was missing.`)
            continue
          }
          const deckId = deckIdByAnkiId.get(card.deckAnkiId) ?? firstDeckId
          if (!firstCardDeckId) firstCardDeckId = deckId
          const frontHtml = this.rewriteMedia(card.frontHtml, mediaIdByName)
          const backHtml = this.rewriteMedia(card.backHtml, mediaIdByName)
          const mediaRefs = card.mediaNames
            .map((name) => mediaIdByName.get(name))
            .filter((id): id is string => Boolean(id))
          this.database.upsertImportedCard(
            {
              noteId,
              deckId,
              templateOrd: card.templateOrd,
              frontHtml,
              backHtml,
              mediaRefs,
              sourceCardId: `anki:${note.guid}:${card.templateOrd}`,
              reviewState: card.reviewState,
            },
            options.preserveScheduling
          )
          importedCards += 1
        }
      })

      const resultDeckId = firstDeckId || firstCardDeckId || fallbackDeckId
      const deckName = resultDeckId ? this.database.getDeckSummary(resultDeckId).name : parsed.rootDeckName
      return {
        deckId: resultDeckId,
        deckName,
        importedNotes,
        importedCards,
        importedMedia: mediaIdByName.size,
        updatedNotes,
        warnings,
      }
    } finally {
      fs.rmSync(parsed.tempDir, { recursive: true, force: true })
    }
  }

  startSession(deckId: string, mode: StudyMode, settings: StudySessionSettings): StudySession {
    const deck = this.database.getDeck(deckId)
    const selected = selectCardsForMode(deck.cards, mode, settings)
    const id = randomUUID()
    const unitTestThreshold = settings.unitTestThreshold ?? 0.8
    this.sessions.set(id, {
      id,
      mode,
      deckId,
      cardIds: selected.map((card) => card.id),
      answered: [],
      unitTestThreshold,
    })
    return {
      id,
      mode,
      deckId,
      cards: selected.map((card) => ({ ...card, backVisible: false })),
      createdAt: new Date().toISOString(),
      unitTestThreshold,
    }
  }

  answer(input: AnswerInput): AnswerResult {
    const session = this.sessions.get(input.sessionId)
    if (!session) throw new Error('Study session not found.')
    return this.scheduler.answer(input, session)
  }

  getAiSettings(): AiSettings {
    const stored = this.getStoredAiSettings()
    return {
      hasApiKey: Boolean(stored.encryptedApiKey),
      model: stored.model,
    }
  }

  saveAiSettings(input: SaveAiSettingsInput): AiSettings {
    const current = this.getStoredAiSettings()
    const next: StoredAiSettings = {
      encryptedApiKey: current.encryptedApiKey,
      model: input.model.trim() || DEFAULT_AI_MODEL,
    }

    if (input.apiKey !== undefined) {
      const trimmed = input.apiKey.trim()
      next.encryptedApiKey = trimmed ? this.encryptApiKey(trimmed) : null
    }

    this.database.setSettingsValue(AI_SETTINGS_KEY, next)
    return this.getAiSettings()
  }

  async generateCards(input: string, options: AiGenerationOptions): Promise<AiGenerationResult> {
    const apiKey = this.getApiKey()
    if (!apiKey) throw new Error('Add an OpenAI API key in Settings before generating cards.')

    const model = options.model?.trim() || this.getStoredAiSettings().model || DEFAULT_AI_MODEL
    const client = new OpenAI({ apiKey })
    const count = Math.min(Math.max(options.count ?? 8, 1), 30)
    const style = options.style

    const completion = await client.chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You create concise, high-quality flashcards. Return strict JSON only with a cards array. Each card needs frontHtml, backHtml, tags, noteType, and optional rationale. Use clean HTML tags only.',
        },
        {
          role: 'user',
          content: `Create ${count} ${style} flashcards from these notes:\n\n${input}`,
        },
      ],
    })

    const raw = completion.choices[0]?.message?.content
    if (!raw) throw new Error('The AI response did not include any card drafts.')
    const parsed = aiDraftSchema.parse(JSON.parse(raw))
    return {
      cards: parsed.cards,
      model,
    }
  }

  getStats(filter?: StatsFilterInput): AppStats {
    return this.database.getStats(filter?.deckId)
  }

  getAppSettings(): AppSettings {
    const stored = this.database.getSettingsValue<Partial<AppSettings>>(APP_SETTINGS_KEY, DEFAULT_APP_SETTINGS)
    return {
      audioVolume: clampAudioVolume(stored.audioVolume),
      themeMode: normalizeThemeMode(stored.themeMode),
    }
  }

  saveAppSettings(input: SaveAppSettingsInput): AppSettings {
    const current = this.getAppSettings()
    this.database.setSettingsValue(APP_SETTINGS_KEY, {
      audioVolume: input.audioVolume === undefined ? current.audioVolume : clampAudioVolume(input.audioVolume),
      themeMode: input.themeMode === undefined ? current.themeMode : normalizeThemeMode(input.themeMode),
    })
    return this.getAppSettings()
  }

  private rewriteMedia(html: string, mediaIdByName: Map<string, string>): string {
    let rewritten = html.replace(/\[sound:([^\]]+)]/g, (_match, name: string) => {
      const id = mediaIdByName.get(name)
      return id ? `<audio controls src="onami-media://${encodeURIComponent(id)}"></audio>` : ''
    })

    rewritten = rewritten.replace(/\bsrc=(["'])([^"']+)\1/g, (match, quote: string, src: string) => {
      if (src.startsWith('http') || src.startsWith('data:') || src.startsWith('onami-media:')) return match
      const id = mediaIdByName.get(src)
      return id ? `src=${quote}onami-media://${encodeURIComponent(id)}${quote}` : match
    })

    return rewritten
  }

  private getStoredAiSettings(): StoredAiSettings {
    return this.database.getSettingsValue<StoredAiSettings>(AI_SETTINGS_KEY, {
      encryptedApiKey: null,
      model: DEFAULT_AI_MODEL,
    })
  }

  private encryptApiKey(apiKey: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure key storage is not available on this system.')
    }
    return safeStorage.encryptString(apiKey).toString('base64')
  }

  private getApiKey(): string | null {
    const stored = this.getStoredAiSettings()
    if (!stored.encryptedApiKey) return null
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64'))
  }
}
