import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import AdmZip from 'adm-zip'
import Database from 'better-sqlite3'
import { decompress } from 'fzstd'

import type { ImportedReviewState } from './database'
import type { ReviewRating, ReviewStateName } from '../../src/shared/types'

type Row = Record<string, unknown>

export interface ParsedAnkiDeck {
  tempDir: string
  rootDeckName: string
  decks: ParsedAnkiDeckItem[]
  notes: ParsedAnkiNote[]
  cards: ParsedAnkiCard[]
  media: ParsedAnkiMedia[]
  warnings: string[]
}

export interface ParsedAnkiDeckItem {
  ankiId: string
  parentAnkiId: string | null
  name: string
}

export interface ParsedAnkiNote {
  ankiId: string
  deckAnkiId: string
  modelName: string
  fields: Record<string, string>
  tags: string[]
  guid: string
}

export interface ParsedAnkiCard {
  ankiId: string
  noteAnkiId: string
  deckAnkiId: string
  templateOrd: number
  frontHtml: string
  backHtml: string
  mediaNames: string[]
  reviewState: ImportedReviewState | null
}

export interface ParsedAnkiMedia {
  originalName: string
  tempPath: string
}

interface AnkiModel {
  id: string
  name: string
  flds: Array<{ name: string; ord?: number }>
  tmpls: Array<{ name?: string; ord?: number; qfmt?: string; afmt?: string }>
  css?: string
  type?: number
}

interface AnkiDeck {
  id: string
  name: string
}

const FIELD_SEPARATOR = '\x1f'
const SQLITE_MAGIC = Buffer.from('SQLite format 3')
const UNICASE_COLLATION = Buffer.from(' COLLATE unicase')
const FURIGANA_PATTERN = new RegExp(
  '([\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー々]+)\\[([^\\[\\]]+)\\]',
  'gu'
)

const toStringValue = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  return String(value)
}

const toNumber = (value: unknown, fallback = 0): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || !value.trim()) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

const stripTags = (tags: string): string[] =>
  tags
    .split(/\s+/)
    .map((tag) => tag.trim())
    .filter(Boolean)

export class ApkgImporter {
  parse(filePath: string): ParsedAnkiDeck {
    if (!filePath.toLowerCase().endsWith('.apkg')) {
      throw new Error('Only .apkg imports are supported in this release.')
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `onami-apkg-${randomUUID()}-`))
    const warnings: string[] = []
    try {
      new AdmZip(filePath).extractAllTo(tempDir, true)

      const collectionPath = this.prepareCollection(tempDir, warnings)
      const db = new Database(collectionPath, { readonly: true, fileMustExist: true })
      try {
        const collection = this.readCollection(db)
        const decks = this.readDecks(db, collection.decks, warnings)
        const models = this.readModels(db, collection.models, warnings)
        const media = this.readMedia(tempDir, warnings)
        const notes = this.readNotes(db, models)
        const cards = this.readCards(db, notes, models, collection.createdAt, warnings)
        const rootDeckName = decks.find((deck) => deck.ankiId !== '1')?.name ?? path.basename(filePath, '.apkg')

        return {
          tempDir,
          rootDeckName,
          decks,
          notes: notes.map((note) => ({
            ankiId: note.ankiId,
            deckAnkiId: note.deckAnkiId,
            modelName: note.modelName,
            fields: note.fields,
            tags: note.tags,
            guid: note.guid,
          })),
          cards,
          media,
          warnings,
        }
      } finally {
        db.close()
      }
    } catch (error) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // The temp folder is best-effort cleanup; import errors should surface first.
      }
      throw error
    }
  }

  private prepareCollection(tempDir: string, warnings: string[]): string {
    const candidates = ['collection.anki21b', 'collection.anki21', 'collection.anki2']
      .map((name) => path.join(tempDir, name))
      .filter((candidate) => fs.existsSync(candidate))

    for (const candidate of candidates) {
      if (this.isSqlite(candidate)) {
        this.normalizeSqliteSchema(candidate)
        return candidate
      }

      try {
        const decompressed = Buffer.from(decompress(fs.readFileSync(candidate)))
        const output = path.join(tempDir, `${path.basename(candidate)}.sqlite`)
        fs.writeFileSync(output, decompressed)
        if (this.isSqlite(output)) {
          this.normalizeSqliteSchema(output)
          return output
        }
      } catch {
        warnings.push(`Could not decompress ${path.basename(candidate)} as zstd.`)
      }
    }

    throw new Error('No readable Anki collection database was found in the package.')
  }

  private normalizeSqliteSchema(filePath: string): void {
    const data = fs.readFileSync(filePath)
    const replacement = Buffer.from(' '.repeat(UNICASE_COLLATION.length))
    let changed = false

    for (
      let offset = data.indexOf(UNICASE_COLLATION);
      offset !== -1;
      offset = data.indexOf(UNICASE_COLLATION, offset + replacement.length)
    ) {
      replacement.copy(data, offset)
      changed = true
    }

    if (changed) fs.writeFileSync(filePath, data)
  }

  private isSqlite(filePath: string): boolean {
    if (!fs.existsSync(filePath)) return false
    const fd = fs.openSync(filePath, 'r')
    try {
      const header = Buffer.alloc(SQLITE_MAGIC.length)
      fs.readSync(fd, header, 0, SQLITE_MAGIC.length, 0)
      return header.equals(SQLITE_MAGIC)
    } finally {
      fs.closeSync(fd)
    }
  }

  private readCollection(db: Database.Database): {
    createdAt: number
    decks: Record<string, unknown>
    models: Record<string, unknown>
  } {
    const row = db.prepare('SELECT * FROM col LIMIT 1').get() as Row | undefined
    if (!row) throw new Error('The Anki collection database is missing the col table.')
    return {
      createdAt: toNumber(row.crt),
      decks: parseJson<Record<string, unknown>>(row.decks, {}),
      models: parseJson<Record<string, unknown>>(row.models, {}),
    }
  }

  private readDecks(
    db: Database.Database,
    legacyDecks: Record<string, unknown>,
    warnings: string[]
  ): ParsedAnkiDeckItem[] {
    const decks: AnkiDeck[] = Object.entries(legacyDecks).map(([id, raw]) => {
      const deck = raw as Record<string, unknown>
      return {
        id,
        name: toStringValue(deck.name || 'Imported'),
      }
    })

    if (decks.length === 0 && this.tableExists(db, 'decks')) {
      const rows = db.prepare('SELECT id, name FROM decks').all() as Row[]
      decks.push(
        ...rows.map((row) => ({
          id: toStringValue(row.id),
          name: toStringValue(row.name || 'Imported'),
        }))
      )
    }

    if (decks.length === 0) {
      warnings.push('No deck metadata was found; cards were placed into an Imported deck.')
      decks.push({ id: '1', name: 'Imported' })
    }

    const expanded = new Map<string, ParsedAnkiDeckItem>()
    const existingDeckIdByPath = new Map(
      decks.map((deck) => [this.splitDeckName(deck.name).join(FIELD_SEPARATOR), deck.id])
    )
    for (const deck of decks) {
      const parts = this.splitDeckName(deck.name)
      let parentAnkiId: string | null = null
      let currentName = ''

      for (let index = 0; index < parts.length; index += 1) {
        currentName = currentName ? `${currentName}${FIELD_SEPARATOR}${parts[index]}` : parts[index]
        const syntheticId =
          index === parts.length - 1
            ? deck.id
            : existingDeckIdByPath.get(currentName) ?? `path:${currentName}`
        if (!expanded.has(syntheticId)) {
          expanded.set(syntheticId, {
            ankiId: syntheticId,
            parentAnkiId,
            name: parts[index],
          })
        }
        parentAnkiId = syntheticId
      }
    }

    return [...expanded.values()]
  }

  private splitDeckName(name: string): string[] {
    return name.replaceAll(FIELD_SEPARATOR, '::').split('::').map((part) => part.trim()).filter(Boolean)
  }

  private readModels(
    db: Database.Database,
    legacyModels: Record<string, unknown>,
    warnings: string[]
  ): Map<string, AnkiModel> {
    const models = new Map<string, AnkiModel>()
    for (const [id, raw] of Object.entries(legacyModels)) {
      const model = raw as AnkiModel
      models.set(id, {
        ...model,
        id,
        name: model.name || 'Imported',
        flds: model.flds || [],
        tmpls: model.tmpls || [],
      })
    }

    if (models.size === 0 && this.tableExists(db, 'notetypes')) {
      try {
        const fieldsByModel = this.readModernFields(db, warnings)
        const templatesByModel = this.readModernTemplates(db, warnings)
        const rows = db.prepare('SELECT id, name, config FROM notetypes').all() as Row[]
        for (const row of rows) {
          const id = toStringValue(row.id)
          const config = this.readModernNoteTypeConfig(row.config)
          models.set(id, {
            id,
            name: toStringValue(row.name || 'Imported'),
            flds: fieldsByModel.get(id) ?? [],
            tmpls: templatesByModel.get(id) ?? [],
            css: config.css,
          })
        }
      } catch (error) {
        warnings.push(
          `Modern note-type metadata could not be read: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    if (models.size === 0 && this.tableExists(db, 'notetypes')) {
      const rows = db.prepare('SELECT id, name FROM notetypes').all() as Row[]
      for (const row of rows) {
        const id = toStringValue(row.id)
        models.set(id, {
          id,
          name: toStringValue(row.name || 'Imported'),
          flds: [],
          tmpls: [],
        })
      }
    }

    if (models.size === 0) {
      warnings.push('No note-type templates were found; cards use raw front/back field rendering.')
    }
    return models
  }

  private readModernFields(db: Database.Database, warnings: string[]): Map<string, AnkiModel['flds']> {
    const fields = new Map<string, AnkiModel['flds']>()
    if (!this.tableExists(db, 'fields')) return fields

    try {
      const rows = db.prepare('SELECT ntid, ord, name FROM fields ORDER BY ntid, ord').all() as Row[]
      for (const row of rows) {
        const ntid = toStringValue(row.ntid)
        const list = fields.get(ntid) ?? []
        list.push({ name: toStringValue(row.name || `Field ${toNumber(row.ord) + 1}`), ord: toNumber(row.ord) })
        fields.set(ntid, list)
      }
    } catch (error) {
      warnings.push(
        `Modern field metadata could not be read: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    return fields
  }

  private readModernTemplates(db: Database.Database, warnings: string[]): Map<string, AnkiModel['tmpls']> {
    const templates = new Map<string, AnkiModel['tmpls']>()
    if (!this.tableExists(db, 'templates')) return templates

    try {
      const rows = db.prepare('SELECT ntid, ord, name, config FROM templates ORDER BY ntid, ord').all() as Row[]
      for (const row of rows) {
        const ntid = toStringValue(row.ntid)
        const config = this.readModernTemplateConfig(row.config)
        const list = templates.get(ntid) ?? []
        list.push({
          name: toStringValue(row.name || `Card ${toNumber(row.ord) + 1}`),
          ord: toNumber(row.ord),
          qfmt: config.qfmt,
          afmt: config.afmt,
        })
        templates.set(ntid, list)
      }
    } catch (error) {
      warnings.push(
        `Modern template metadata could not be read: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    return templates
  }

  private readMedia(tempDir: string, warnings: string[]): ParsedAnkiMedia[] {
    const mediaPath = path.join(tempDir, 'media')
    if (!fs.existsSync(mediaPath)) return []
    const media: ParsedAnkiMedia[] = []
    const manifest = fs.readFileSync(mediaPath)
    const legacyMapping = parseJson<Record<string, string>>(manifest.toString('utf8'), {})
    const entries = Object.keys(legacyMapping).length
      ? Object.entries(legacyMapping).map(([archiveName, originalName]) => ({
          archiveName,
          originalName,
          expectedSha1: null,
          expectedSize: null,
        }))
      : this.readModernMediaManifest(manifest, warnings)

    for (const { archiveName, originalName, expectedSha1, expectedSize } of entries) {
      const tempPath = path.join(tempDir, archiveName)
      if (!fs.existsSync(tempPath)) {
        warnings.push(`Media file ${originalName} was referenced but missing from the package.`)
        continue
      }
      media.push({
        originalName,
        tempPath: this.prepareMediaFile(tempDir, archiveName, originalName, expectedSha1, expectedSize, warnings),
      })
    }

    return media
  }

  private readModernMediaManifest(
    manifest: Buffer,
    warnings: string[]
  ): Array<{ archiveName: string; originalName: string; expectedSha1: string | null; expectedSize: number | null }> {
    let decoded: Buffer
    try {
      decoded = Buffer.from(decompress(manifest))
    } catch {
      return []
    }

    return this.readProtoFields(decoded)
      .filter((field) => field.fieldNumber === 1 && field.bytes)
      .map((field, index) => {
        const mediaFields = this.readProtoFields(field.bytes)
        return {
          archiveName: String(index),
          originalName: mediaFields.find((item) => item.fieldNumber === 1)?.text ?? String(index),
          expectedSize: mediaFields.find((item) => item.fieldNumber === 2)?.value ?? null,
          expectedSha1: mediaFields.find((item) => item.fieldNumber === 3)?.bytes?.toString('hex') ?? null,
        }
      })
      .filter((entry) => {
        if (entry.originalName) return true
        warnings.push(`Media entry ${entry.archiveName} did not include a filename.`)
        return false
      })
  }

  private prepareMediaFile(
    tempDir: string,
    archiveName: string,
    originalName: string,
    expectedSha1: string | null,
    expectedSize: number | null,
    warnings: string[]
  ): string {
    const sourcePath = path.join(tempDir, archiveName)
    let decoded: Buffer
    try {
      decoded = Buffer.from(decompress(fs.readFileSync(sourcePath)))
    } catch {
      return sourcePath
    }

    if (expectedSize !== null && decoded.length !== expectedSize) {
      warnings.push(`Media file ${originalName} had an unexpected decoded size.`)
    }

    if (expectedSha1) {
      const actualSha1 = createHash('sha1').update(decoded).digest('hex')
      if (actualSha1 !== expectedSha1) warnings.push(`Media file ${originalName} failed its checksum check.`)
    }

    const decodedPath = path.join(tempDir, `${archiveName}.decoded`)
    fs.writeFileSync(decodedPath, decoded)
    return decodedPath
  }

  private readNotes(
    db: Database.Database,
    models: Map<string, AnkiModel>
  ): Array<ParsedAnkiNote & { model: AnkiModel | null }> {
    const rows = db.prepare('SELECT id, guid, mid, tags, flds FROM notes').all() as Row[]
    return rows.map((row) => {
      const model = models.get(toStringValue(row.mid)) ?? null
      const fieldValues = toStringValue(row.flds).split(FIELD_SEPARATOR)
      const fields: Record<string, string> = {}
      if (model) {
        const sortedFields = [...model.flds].sort((a, b) => toNumber(a.ord) - toNumber(b.ord))
        sortedFields.forEach((field, index) => {
          fields[field.name] = fieldValues[index] ?? ''
        })
      } else {
        fields.Front = fieldValues[0] ?? ''
        fields.Back = fieldValues[1] ?? ''
      }
      return {
        ankiId: toStringValue(row.id),
        deckAnkiId: '1',
        modelName: model?.name ?? 'Imported',
        fields,
        tags: stripTags(toStringValue(row.tags)),
        guid: toStringValue(row.guid || row.id),
        model,
      }
    })
  }

  private readCards(
    db: Database.Database,
    notes: Array<ParsedAnkiNote & { model: AnkiModel | null }>,
    models: Map<string, AnkiModel>,
    collectionCreatedAt: number,
    warnings: string[]
  ): ParsedAnkiCard[] {
    const noteById = new Map(notes.map((note) => [note.ankiId, note]))
    const revlogStats = this.readRevlogStats(db)
    const rows = db
      .prepare(
        `SELECT id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses
         FROM cards
         ORDER BY due, ord`
      )
      .all() as Row[]

    return rows.flatMap((row) => {
      const note = noteById.get(toStringValue(row.nid))
      if (!note) {
        warnings.push(`Card ${toStringValue(row.id)} references a missing note.`)
        return []
      }

      const model = note.model ?? models.values().next().value ?? null
      const ord = toNumber(row.ord)
      const template = model?.tmpls?.[ord] ?? model?.tmpls?.[0] ?? null
      const isCloze = model?.type === 1 || Object.values(note.fields).some((value) => /{{c\d+::/.test(value))
      const qfmt = template?.qfmt || '{{Front}}'
      const afmt = template?.afmt || '{{Front}}<hr>{{Back}}'
      const frontHtml = isCloze
        ? this.renderClozeCard(note.fields, ord + 1, false)
        : this.renderTemplate(qfmt, note.fields)
      const renderedBackHtml = isCloze
        ? this.renderClozeCard(note.fields, ord + 1, true)
        : this.renderTemplate(afmt, note.fields, frontHtml)
      const backHtml = this.enrichBackHtml(renderedBackHtml, note.fields)
      const deckAnkiId = toStringValue(row.did || note.deckAnkiId || '1')
      note.deckAnkiId = deckAnkiId
      const mediaNames = [...new Set([...this.extractMediaNames(frontHtml), ...this.extractMediaNames(backHtml)])]

      return {
        ankiId: toStringValue(row.id),
        noteAnkiId: note.ankiId,
        deckAnkiId,
        templateOrd: ord,
        frontHtml,
        backHtml,
        mediaNames,
        reviewState: this.mapReviewState(row, revlogStats.get(toStringValue(row.id)), collectionCreatedAt),
      }
    })
  }

  private readRevlogStats(db: Database.Database): Map<string, { total: number; correct: number; last: Row | null }> {
    const stats = new Map<string, { total: number; correct: number; last: Row | null }>()
    if (!this.tableExists(db, 'revlog')) return stats
    const rows = db.prepare('SELECT cid, id, ease FROM revlog ORDER BY id').all() as Row[]
    for (const row of rows) {
      const cid = toStringValue(row.cid)
      const current = stats.get(cid) ?? { total: 0, correct: 0, last: null }
      current.total += 1
      if (toNumber(row.ease) > 1) current.correct += 1
      current.last = row
      stats.set(cid, current)
    }
    return stats
  }

  private mapReviewState(
    cardRow: Row,
    stats: { total: number; correct: number; last: Row | null } | undefined,
    collectionCreatedAt: number
  ): ImportedReviewState | null {
    const type = toNumber(cardRow.type)
    const queue = toNumber(cardRow.queue)
    const reps = toNumber(cardRow.reps)
    if (type === 0 && reps === 0) return null

    const ivl = toNumber(cardRow.ivl)
    const factor = toNumber(cardRow.factor, 2500)
    const state = this.mapAnkiState(type, queue)
    const dueAt = this.mapAnkiDueDate(cardRow, collectionCreatedAt, state)
    const lastEase = stats?.last ? toNumber(stats.last.ease) : 0

    return {
      dueAt,
      state,
      stability: Math.max(0.1, ivl || 0.1),
      difficulty: Math.min(10, Math.max(1, 11 - factor / 250)),
      elapsedDays: 0,
      scheduledDays: Math.max(0, ivl),
      learningSteps: 0,
      reps,
      lapses: toNumber(cardRow.lapses),
      successRate: stats && stats.total > 0 ? stats.correct / stats.total : reps > 0 ? 1 : 0,
      lastRating: this.mapEase(lastEase),
      lastReviewedAt: stats?.last ? new Date(toNumber(stats.last.id)).toISOString() : null,
    }
  }

  private mapAnkiState(type: number, queue: number): ReviewStateName {
    if (type === 0 || queue === 0) return 'New'
    if (type === 1 || queue === 1) return 'Learning'
    if (type === 3 || queue === 3) return 'Relearning'
    return 'Review'
  }

  private mapAnkiDueDate(row: Row, collectionCreatedAt: number, state: ReviewStateName): string | null {
    if (state === 'New') return null
    const queue = toNumber(row.queue)
    const due = toNumber(row.due)
    if (queue === 1 || queue === 3) return new Date(due * 1000).toISOString()
    const collectionStart = new Date(collectionCreatedAt * 1000)
    collectionStart.setHours(0, 0, 0, 0)
    return new Date(collectionStart.getTime() + due * 24 * 60 * 60 * 1000).toISOString()
  }

  private mapEase(ease: number): ReviewRating | null {
    if (!ease) return null
    if (ease <= 1) return 'again'
    if (ease === 2) return 'hard'
    if (ease === 3) return 'good'
    return 'easy'
  }

  private renderTemplate(template: string, fields: Record<string, string>, frontSide = ''): string {
    let html = template
    html = html.replace(/{{#([^}]+)}}([\s\S]*?){{\/\1}}/g, (_, field: string, content: string) =>
      fields[field]?.trim() ? content : ''
    )
    html = html.replace(/{{\^([^}]+)}}([\s\S]*?){{\/\1}}/g, (_, field: string, content: string) =>
      fields[field]?.trim() ? '' : content
    )
    html = html.replace(/{{FrontSide}}/g, frontSide)
    html = html.replace(/{{furigana:([^}]+)}}/g, (_, field: string) =>
      this.renderFurigana(fields[field.trim()] ?? '')
    )
    html = html.replace(/{{kanji:([^}]+)}}/g, (_, field: string) =>
      this.renderKanjiOnly(fields[field.trim()] ?? '')
    )
    html = html.replace(/{{kana:([^}]+)}}/g, (_, field: string) =>
      this.renderKanaOnly(fields[field.trim()] ?? '')
    )
    html = html.replace(/{{type:([^}]+)}}/g, (_, field: string) => fields[field] ?? '')
    html = html.replace(/{{text:([^}]+)}}/g, (_, field: string) => this.textOnly(fields[field] ?? ''))
    html = html.replace(/{{cloze:([^}]+)}}/g, (_, field: string) => this.renderClozeText(fields[field] ?? '', 1, false))
    html = html.replace(/{{([^}]+)}}/g, (_, field: string) => fields[field.trim()] ?? '')
    return this.cleanupHtml(html)
  }

  private renderClozeCard(fields: Record<string, string>, index: number, answer: boolean): string {
    const source = fields.Text ?? fields.Back ?? Object.values(fields).join('<br>')
    return this.cleanupHtml(this.renderClozeText(source, index, answer))
  }

  private renderClozeText(text: string, index: number, answer: boolean): string {
    return text.replace(/{{c(\d+)::(.*?)(?:::.*?)?}}/g, (_, rawIndex: string, content: string) => {
      if (Number(rawIndex) !== index) return content
      return answer ? `<strong>${content}</strong>` : '<span class="cloze">[...]</span>'
    })
  }

  private enrichBackHtml(backHtml: string, fields: Record<string, string>): string {
    const additions = ['RemarksBack', 'Jlab-Translation', 'Other-Back']
      .map((field) => fields[field]?.trim())
      .filter((value): value is string => Boolean(value))
    if (additions.length === 0) return backHtml

    const backText = this.textOnly(backHtml).replace(/\s+/g, ' ').trim()
    const missing = additions.filter((addition) => {
      const additionText = this.textOnly(addition).replace(/\s+/g, ' ').trim()
      return additionText && !backText.includes(additionText)
    })
    if (missing.length === 0) return backHtml

    return this.cleanupHtml(`${backHtml}<hr>${missing.join('<br>')}`)
  }

  private extractMediaNames(html: string): string[] {
    const names = new Set<string>()
    for (const match of html.matchAll(/\[sound:([^\]]+)]/g)) names.add(match[1])
    for (const match of html.matchAll(/\bsrc=["']([^"']+)["']/g)) {
      const src = match[1]
      if (!src.startsWith('http') && !src.startsWith('data:') && !src.startsWith('onami-media:')) {
        names.add(src)
      }
    }
    return [...names]
  }

  private cleanupHtml(html: string): string {
    return html.replace(/{{[^}]+}}/g, '').replace(/\n/g, '<br>')
  }

  private renderFurigana(text: string): string {
    return text.replace(FURIGANA_PATTERN, '<ruby>$1<rt>$2</rt></ruby>')
  }

  private renderKanjiOnly(text: string): string {
    return text.replace(FURIGANA_PATTERN, '$1')
  }

  private renderKanaOnly(text: string): string {
    return text.replace(FURIGANA_PATTERN, '$2')
  }

  private textOnly(html: string): string {
    return html.replace(/<[^>]+>/g, '')
  }

  private tableExists(db: Database.Database, tableName: string): boolean {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as Row | undefined
    return Boolean(row)
  }

  private readModernNoteTypeConfig(value: unknown): { css?: string } {
    const fields = this.readProtoFields(value)
    return {
      css: fields.find((field) => field.fieldNumber === 3)?.text,
    }
  }

  private readModernTemplateConfig(value: unknown): { qfmt?: string; afmt?: string } {
    const fields = this.readProtoFields(value)
    return {
      qfmt: fields.find((field) => field.fieldNumber === 1)?.text,
      afmt: fields.find((field) => field.fieldNumber === 2)?.text,
    }
  }

  private readProtoFields(value: unknown): Array<{ fieldNumber: number; text?: string; bytes?: Buffer; value?: number }> {
    const buffer = this.toBuffer(value)
    if (!buffer || buffer.length === 0) return []

    const fields: Array<{ fieldNumber: number; text?: string; bytes?: Buffer; value?: number }> = []
    let offset = 0

    while (offset < buffer.length) {
      const key = this.readVarint(buffer, offset)
      offset = key.offset
      const fieldNumber = Math.floor(key.value / 8)
      const wireType = key.value % 8

      if (wireType === 0) {
        const decoded = this.readVarint(buffer, offset)
        offset = decoded.offset
        fields.push({ fieldNumber, value: decoded.value })
      } else if (wireType === 1) {
        offset += 8
        fields.push({ fieldNumber })
      } else if (wireType === 2) {
        const length = this.readVarint(buffer, offset)
        offset = length.offset
        const bytes = buffer.subarray(offset, offset + length.value)
        offset += length.value
        fields.push({ fieldNumber, text: bytes.toString('utf8'), bytes })
      } else if (wireType === 5) {
        offset += 4
        fields.push({ fieldNumber })
      } else {
        break
      }
    }

    return fields
  }

  private readVarint(buffer: Buffer, initialOffset: number): { value: number; offset: number } {
    let result = 0
    let shift = 0
    let offset = initialOffset

    while (offset < buffer.length) {
      const byte = buffer[offset]
      result += (byte & 0x7f) * 2 ** shift
      offset += 1
      if ((byte & 0x80) === 0) return { value: result, offset }
      shift += 7
    }

    throw new Error('Invalid protobuf varint.')
  }

  private toBuffer(value: unknown): Buffer | null {
    if (Buffer.isBuffer(value)) return value
    if (value instanceof Uint8Array) return Buffer.from(value)
    if (typeof value === 'string') return Buffer.from(value, 'utf8')
    return null
  }
}
