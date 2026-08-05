import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import DOMPurify from 'dompurify'
import {
  BarChart3,
  BookOpen,
  Brain,
  Bug,
  Check,
  CheckCircle2,
  Clock3,
  CloudCheck,
  CloudOff,
  CloudUpload,
  FileUp,
  Flame,
  Globe2,
  Heart,
  Layers3,
  Minus,
  Moon,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  Square,
  Sun,
  Tags,
  Trash2,
  X,
} from 'lucide-react'

import type {
  AiDraftCard,
  AiSettings,
  AppSettings,
  AppStats,
  CardSummary,
  DeckDetail,
  DeckSummary,
  GlobalDeckSummary,
  HardCardSummary,
  ReviewRating,
  StudyMode,
  StudySession,
  SyncHealthResult,
  SyncPairingMode,
  SyncProgressEvent,
  SyncRunResult,
  SyncStartPairingResult,
  SyncStatus,
  ThemeMode,
} from './shared/types'
import './App.css'

type View = 'study' | 'create' | 'browse' | 'import' | 'stats' | 'settings'

type PairingFlow = 'start' | 'join' | null

type BusyRunner = (fn: () => Promise<void>, label?: string) => void

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))
const AUTO_SYNC_INTERVAL_MS = 15_000

interface DeckRow {
  deck: DeckSummary
  depth: number
  aggregate: {
    totalCards: number
    dueCards: number
    newCards: number
  }
}

const tabs: Array<{ id: View; label: string; icon: typeof BookOpen }> = [
  { id: 'study', label: 'Study', icon: BookOpen },
  { id: 'create', label: 'Create', icon: Plus },
  { id: 'browse', label: 'Browse', icon: Globe2 },
  { id: 'import', label: 'Import', icon: FileUp },
  { id: 'stats', label: 'Stats', icon: BarChart3 },
  { id: 'settings', label: 'Settings', icon: Settings },
]

const formatSyncTimestamp = (value: string | null): string | null => {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

const viewTitle: Record<View, string> = {
  study: 'Study',
  create: 'Create',
  browse: 'Browse',
  import: 'Import',
  stats: 'Stats',
  settings: 'Settings',
}

const emptyStats: AppStats = {
  scopeDeckId: null,
  scopeDeckName: null,
  totalDecks: 0,
  totalCards: 0,
  newCards: 0,
  dueCards: 0,
  reviewedToday: 0,
  reviewedThisWeek: 0,
  reviewedThisMonth: 0,
  totalReviews: 0,
  averageSuccessRate: 0,
  streakDays: 0,
  longestStreakDays: 0,
  studyTime: {
    todayMs: 0,
    weekMs: 0,
    monthMs: 0,
    overallMs: 0,
  },
  completion: {
    completedCards: 0,
    totalCards: 0,
    completionRatio: 0,
    fullyLearned: false,
  },
  averageReviewMs: 0,
  averageRevealMs: 0,
  averageAgainToEasyMs: null,
  unitTestScores: [],
  hardestCards: [],
}

const defaultAppSettings: AppSettings = {
  audioVolume: 0.8,
  themeMode: 'system',
}

const sanitize = (html: string) =>
  DOMPurify.sanitize(html, {
    ADD_TAGS: ['audio', 'source'],
    ADD_ATTR: ['controls', 'src'],
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?|mailto|data|onami-media):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  })

const removeEmptyInlineNodes = (root: ParentNode) => {
  Array.from(root.querySelectorAll('font, span')).forEach((element) => {
    if (element.textContent?.trim() || element.querySelector('img, audio, source')) return
    element.remove()
  })
}

const compactBreaks = (root: ParentNode) => {
  const compact = (parent: ParentNode) => {
    Array.from(parent.childNodes).forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE && node.nodeName !== 'BR') compact(node as Element)
      if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) node.remove()
    })

    let previousWasBreak = false
    Array.from(parent.childNodes).forEach((node) => {
      if (node.nodeName === 'BR') {
        if (previousWasBreak) node.remove()
        previousWasBreak = true
        return
      }
      previousWasBreak = false
    })

    while (parent.firstChild?.nodeName === 'BR') parent.firstChild.remove()
    while (parent.lastChild?.nodeName === 'BR') parent.lastChild.remove()
  }

  compact(root)
}

const extractAudio = (html: string) => {
  const cleanHtml = sanitize(html)
  const template = document.createElement('template')
  template.innerHTML = cleanHtml
  const audioSources = Array.from(template.content.querySelectorAll('audio'))
    .map((audio) => {
      const source = audio.getAttribute('src') ?? audio.querySelector('source')?.getAttribute('src') ?? ''
      audio.remove()
      return source
    })
    .filter(Boolean)
  removeEmptyInlineNodes(template.content)
  Array.from(template.content.querySelectorAll('font')).forEach((font) => {
    const color = font.getAttribute('color')?.toLowerCase()
    if (color === '#c0c0c0' || color === 'silver') font.classList.add('muted-anki-text')
    font.removeAttribute('size')
    font.removeAttribute('color')
  })
  compactBreaks(template.content)
  return { html: template.innerHTML, audioSources }
}

const Html = ({
  html,
  audioVolume = 0.8,
  autoPlayKey,
}: {
  html: string
  audioVolume?: number
  autoPlayKey?: string
}) => {
  const rendered = useMemo(() => extractAudio(html), [html])
  const shellRef = useRef<HTMLDivElement | null>(null)
  const fitRef = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(1)

  useLayoutEffect(() => {
    const fit = () => {
      const shell = shellRef.current
      const content = fitRef.current
      if (!shell || !content) return
      const widthRatio = shell.clientWidth / Math.max(content.scrollWidth, 1)
      const heightRatio = shell.clientHeight / Math.max(content.scrollHeight, 1)
      const nextScale = Math.min(1, widthRatio, heightRatio) * 0.96
      setScale(Math.max(0.45, Math.min(1, nextScale)))
    }

    const frame = window.requestAnimationFrame(fit)
    const observer = new ResizeObserver(fit)
    if (shellRef.current) observer.observe(shellRef.current)
    if (fitRef.current) observer.observe(fitRef.current)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [rendered.html, rendered.audioSources.length])

  return (
    <div className="html-content-shell" ref={shellRef}>
      <div
        className="html-fit-content"
        ref={fitRef}
        style={{ '--content-scale': scale } as CSSProperties}
      >
        <div className="html-content" dangerouslySetInnerHTML={{ __html: rendered.html }} />
        {rendered.audioSources.length > 0 && (
          <div className="audio-button-row">
            {rendered.audioSources.map((source, index) => (
              <AudioPlayButton
                key={`${source}-${index}`}
                src={source}
                volume={audioVolume}
                autoPlayKey={index === 0 ? autoPlayKey : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function AudioPlayButton({
  src,
  volume,
  autoPlayKey,
}: {
  src: string
  volume: number
  autoPlayKey?: string
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume
  }, [volume])

  const play = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.pause()
    audio.currentTime = 0
    audio.volume = volume
    void audio.play().catch(() => undefined)
  }, [volume])

  useEffect(() => {
    if (!autoPlayKey) return
    play()
  }, [autoPlayKey, play])

  return (
    <>
      <button className="audio-play-button" onClick={play} title="Play audio" aria-label="Play audio">
        <Play size={20} fill="currentColor" />
      </button>
      <audio ref={audioRef} src={src} preload="none" />
    </>
  )
}

const percent = (value: number) => `${Math.round(value * 100)}%`

const formatStudyModeLabel = (mode: string) => mode.replace(/-/g, ' ')

const formatDuration = (valueMs: number) => {
  if (valueMs <= 0) return '0m'
  const totalSeconds = Math.floor(valueMs / 1000)
  if (totalSeconds < 60) return `${Math.max(totalSeconds, 1)}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours < 24) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`
}

const dueLabel = (card: CardSummary) => {
  if (card.state === 'New') return 'New'
  if (!card.dueAt) return card.state
  const delta = Date.parse(card.dueAt) - Date.now()
  if (delta <= 0) return 'Due'
  const minutes = Math.ceil(delta / 60000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.ceil(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.ceil(hours / 24)}d`
}

const buildDeckRows = (decks: DeckSummary[]): DeckRow[] => {
  const childrenByParent = new Map<string | null, DeckSummary[]>()
  for (const deck of decks) {
    const children = childrenByParent.get(deck.parentId) ?? []
    children.push(deck)
    childrenByParent.set(deck.parentId, children)
  }
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  }

  const aggregate = (deck: DeckSummary): DeckRow['aggregate'] => {
    const children = childrenByParent.get(deck.id) ?? []
    return children.reduce(
      (sum, child) => {
        const childAggregate = aggregate(child)
        return {
          totalCards: sum.totalCards + childAggregate.totalCards,
          dueCards: sum.dueCards + childAggregate.dueCards,
          newCards: sum.newCards + childAggregate.newCards,
        }
      },
      {
        totalCards: deck.totalCards,
        dueCards: deck.dueCards,
        newCards: deck.newCards,
      }
    )
  }

  const rows: DeckRow[] = []
  const append = (deck: DeckSummary, depth: number) => {
    rows.push({ deck, depth, aggregate: aggregate(deck) })
    for (const child of childrenByParent.get(deck.id) ?? []) append(child, depth + 1)
  }

  const roots = [
    ...(childrenByParent.get(null) ?? []),
    ...decks.filter((deck) => deck.parentId && !decks.some((candidate) => candidate.id === deck.parentId)),
  ]
  for (const root of roots) append(root, 0)
  return rows
}

function App() {
  const [view, setView] = useState<View>('study')
  const [decks, setDecks] = useState<DeckSummary[]>([])
  const [selectedDeckId, setSelectedDeckId] = useState('')
  const [deckDetail, setDeckDetail] = useState<DeckDetail | null>(null)
  const [stats, setStats] = useState<AppStats>(emptyStats)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyLabel, setBusyLabel] = useState('Working...')
  const [isMaximized, setIsMaximized] = useState(false)
  const [studyCardMode, setStudyCardMode] = useState(false)
  const [appSettings, setAppSettings] = useState<AppSettings>(defaultAppSettings)
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>('light')
  const autoSyncRunningRef = useRef(false)

  const load = useCallback(async (deckId = selectedDeckId) => {
    const [deckList, appStats] = await Promise.all([window.onami.decks.list(), window.onami.stats.get()])
    setDecks(deckList)
    setStats(appStats)
    const nextDeckId = deckList.some((deck) => deck.id === deckId) ? deckId : deckList[0]?.id || ''
    setSelectedDeckId(nextDeckId)
    if (nextDeckId) setDeckDetail(await window.onami.decks.get(nextDeckId))
    else setDeckDetail(null)
  }, [selectedDeckId])

  useEffect(() => {
    load().catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error)))
  }, [load])

  useEffect(() => {
    let disposed = false

    const runAutoSync = async () => {
      if (disposed || busy || studyCardMode || autoSyncRunningRef.current) return

      autoSyncRunningRef.current = true
      try {
        const status = await window.onami.sync.getStatus()
        if (!status.paired) return

        const result = await window.onami.sync.syncNow()
        if (disposed) return
        if (result.appliedEvents > 0) await load()
      } catch {
        // Background sync is best-effort. The Settings tab still exposes the
        // manual action and detailed progress/error messages.
      } finally {
        autoSyncRunningRef.current = false
      }
    }

    void runAutoSync()
    const interval = window.setInterval(() => {
      void runAutoSync()
    }, AUTO_SYNC_INTERVAL_MS)

    return () => {
      disposed = true
      window.clearInterval(interval)
    }
  }, [busy, load, studyCardMode])

  useEffect(() => {
    window.onami.appWindow.isMaximized().then(setIsMaximized).catch(() => undefined)
    const dispose = window.onami.appWindow.onMaximizedChanged((next) => setIsMaximized(next))
    return () => dispose()
  }, [])

  useEffect(() => {
    window.onami.settings.get().then(setAppSettings).catch(() => undefined)
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setSystemTheme(media.matches ? 'dark' : 'light')
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (view !== 'study') setStudyCardMode(false)
  }, [view])

  const selectedDeck = useMemo(
    () => decks.find((deck) => deck.id === selectedDeckId) ?? decks[0] ?? null,
    [decks, selectedDeckId]
  )

  const deleteDeck = (deck: DeckSummary) =>
    runBusy(async () => {
      const ok = window.confirm(
        `Delete "${deck.name}" and any subdecks? This removes its cards and review history from oNami.`
      )
      if (!ok) return
      await window.onami.decks.delete(deck.id)
      await load(deck.id === selectedDeckId ? '' : selectedDeckId)
    })

  const resetDeckScheduling = (deck: DeckSummary) =>
    runBusy(async () => {
      const ok = window.confirm(
        `Reset scheduling for "${deck.name}" and any subdecks?\n\nCards will return to their import-time study state when that baseline exists. Older cards without a stored import baseline fall back to fresh/New. Streak and study-time totals stay intact.`
      )
      if (!ok) return
      await window.onami.decks.resetScheduling(deck.id)
      await load(deck.id === selectedDeckId ? deck.id : selectedDeckId)
    })

  const runBusy: BusyRunner = async (fn, label = 'Working...') => {
    setBusy(true)
    setBusyLabel(label)
    setMessage('')
    try {
      await fn()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
      setBusyLabel('Working...')
    }
  }

  const inStudyCardMode = view === 'study' && studyCardMode
  const effectiveTheme = appSettings.themeMode === 'system' ? systemTheme : appSettings.themeMode

  useEffect(() => {
    const dark = effectiveTheme === 'dark'
    const backgroundColor = dark ? '#15171d' : '#fbf7ef'
    document.documentElement.style.colorScheme = effectiveTheme
    document.documentElement.style.backgroundColor = backgroundColor
    document.body.style.backgroundColor = backgroundColor
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', backgroundColor)

    try {
      window.onamiAndroid?.setSystemBarTheme(dark)
    } catch {
      // The native bridge is Android-only; browser and Electron use the CSS theme.
    }
  }, [effectiveTheme])

  const toggleTheme = () => {
    const themeMode: ThemeMode = effectiveTheme === 'dark' ? 'light' : 'dark'
    setAppSettings((current) => ({ ...current, themeMode }))
    window.onami.settings.save({ themeMode }).then(setAppSettings).catch(() => undefined)
  }

  return (
    <main className="desktop" data-theme={effectiveTheme}>
      <section className={`phone-frame${inStudyCardMode ? ' phone-frame-study-session' : ''}`}>
        <header className="topbar">
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true">
              <span />
            </div>
            <div>
              <p className="eyebrow">oNami</p>
              <h1>{view === 'study' ? selectedDeck?.name ?? 'Study' : viewTitle[view]}</h1>
            </div>
          </div>
          <div className="topbar-actions">
            <button
              className={`theme-toggle no-drag ${effectiveTheme === 'dark' ? 'dark' : 'light'}`}
              title={`Switch to ${effectiveTheme === 'dark' ? 'light' : 'dark'} mode`}
              aria-label={`Switch to ${effectiveTheme === 'dark' ? 'light' : 'dark'} mode`}
              onClick={toggleTheme}
            >
              <Sun size={14} />
              <span className="theme-toggle-track">
                <span className="theme-toggle-thumb" />
              </span>
              <Moon size={14} />
            </button>
            <div className="window-controls no-drag" role="group" aria-label="Window controls">
              <button
                className="window-control-button"
                title="Minimize"
                aria-label="Minimize window"
                onClick={() => {
                  void window.onami.appWindow.minimize()
                }}
              >
                <Minus size={15} />
              </button>
              <button
                className="window-control-button"
                title={isMaximized ? 'Restore' : 'Maximize'}
                aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
                onClick={() => {
                  void window.onami.appWindow.toggleMaximize().then(setIsMaximized)
                }}
              >
                <Square size={14} />
              </button>
              <button
                className="window-control-button close"
                title="Close"
                aria-label="Close window"
                onClick={() => {
                  void window.onami.appWindow.close()
                }}
              >
                <X size={15} />
              </button>
            </div>
          </div>
        </header>

        {!inStudyCardMode && (
          <div className="status-strip" aria-label="Study activity">
            <div className="streak-pill">
              <Flame size={17} />
              <div className="streak-copy">
                <strong>{stats.streakDays}</strong>
                <span>{stats.streakDays === 1 ? 'day streak' : 'days streak'}</span>
                <small>Longest {stats.longestStreakDays}d</small>
              </div>
            </div>
            <MiniMetric label="Today" value={formatDuration(stats.studyTime.todayMs)} />
            <MiniMetric label="Week" value={formatDuration(stats.studyTime.weekMs)} />
            <MiniMetric label="Month" value={formatDuration(stats.studyTime.monthMs)} />
            <div className="score-pill">
              <Clock3 size={15} />
              {formatDuration(stats.studyTime.overallMs)}
            </div>
          </div>
        )}

        {!inStudyCardMode && (
          <nav className="tabbar" aria-label="Main views">
            {tabs.map((tab) => {
              const Icon = tab.icon
              return (
                <button
                  key={tab.id}
                  className={view === tab.id ? 'active' : ''}
                  onClick={() => setView(tab.id)}
                  title={tab.label}
                >
                  <Icon size={17} />
                  <span>{tab.label}</span>
                </button>
              )
            })}
          </nav>
        )}

        <div className={`content${inStudyCardMode ? ' content-study-session' : ''}`}>
          {message && <div className="notice">{message}</div>}
          {view === 'study' && (
            <StudyView
              busy={busy}
              deck={deckDetail}
              decks={decks}
              selectedDeckId={selectedDeckId}
              setSelectedDeckId={(deckId) => runBusy(async () => load(deckId))}
              deleteDeck={deleteDeck}
              resetDeckScheduling={resetDeckScheduling}
              goToCreate={() => setView('create')}
              goToImport={() => setView('import')}
              reload={() => load()}
              runBusy={runBusy}
              onSessionActiveChange={setStudyCardMode}
              audioVolume={appSettings.audioVolume}
            />
          )}
          {view === 'create' && (
            <CreateView
              decks={decks}
              selectedDeckId={selectedDeckId}
              reload={() => load()}
              runBusy={runBusy}
            />
          )}
          {view === 'browse' && (
            <BrowseView
              onAdded={(deckId) =>
                load(deckId).then(() => {
                  setView('study')
                })
              }
              runBusy={runBusy}
            />
          )}
          {view === 'import' && (
            <ImportView
              onImported={(deckId) =>
                load(deckId).then(() => {
                  setView('study')
                })
              }
              runBusy={runBusy}
            />
          )}
          {view === 'stats' && (
            <StatsView
              stats={stats}
              decks={decks}
              deleteDeck={deleteDeck}
              resetDeckScheduling={resetDeckScheduling}
              audioVolume={appSettings.audioVolume}
            />
          )}
          {view === 'settings' && (
            <SettingsView
              appSettings={appSettings}
              onAppSettingsChanged={setAppSettings}
              runBusy={runBusy}
              setBusyLabel={setBusyLabel}
              reload={() => load()}
            />
          )}
        </div>

        {busy && <div className="busy">{busyLabel}</div>}
      </section>
    </main>
  )
}

function MiniMetric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="mini-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}

function DeckPicker({
  decks,
  selectedDeckId,
  onChange,
  label = 'Deck',
  includeAll = false,
  allLabel = 'All decks',
}: {
  decks: DeckSummary[]
  selectedDeckId: string
  onChange: (deckId: string) => void
  label?: string
  includeAll?: boolean
  allLabel?: string
}) {
  const rows = buildDeckRows(decks)
  return (
    <label className="field">
      <span>{label}</span>
      <select value={selectedDeckId} onChange={(event) => onChange(event.target.value)}>
        {includeAll && <option value="">{allLabel}</option>}
        {rows.map((row) => (
          <option key={row.deck.id} value={row.deck.id}>
            {`${'  '.repeat(row.depth)}${row.deck.name}`}
          </option>
        ))}
      </select>
    </label>
  )
}

function DeckTree({
  decks,
  selectedDeckId,
  onSelect,
  onResetScheduling,
  onDelete,
}: {
  decks: DeckSummary[]
  selectedDeckId: string
  onSelect: (deckId: string) => void
  onResetScheduling: (deck: DeckSummary) => void
  onDelete: (deck: DeckSummary) => void
}) {
  const rows = buildDeckRows(decks)

  return (
    <div className="deck-tree" aria-label="Decks">
      <div className="deck-tree-header">
        <span>Deck</span>
        <span>New</span>
        <span>Due</span>
        <span>Cards</span>
      </div>
      <div className="deck-tree-rows">
        {rows.map((row) => {
          const perfectUnitTest = row.deck.unitTestScore === 1
          return (
            <div
              className={`deck-tree-row${row.deck.id === selectedDeckId ? ' selected' : ''}${perfectUnitTest ? ' perfect-test' : ''}`}
              key={row.deck.id}
              style={{ '--deck-depth': `${row.depth * 18}px` } as CSSProperties}
            >
              <button className="deck-tree-main" onClick={() => onSelect(row.deck.id)}>
                <span className="deck-tree-name-cell">
                  <span className="deck-tree-name">{row.deck.name}</span>
                  {perfectUnitTest && (
                    <span className="deck-complete-badge">
                      <CheckCircle2 size={12} />
                      Test 100%
                    </span>
                  )}
                </span>
                <span>{row.aggregate.newCards}</span>
                <span>{row.aggregate.dueCards}</span>
                <span>{row.aggregate.totalCards}</span>
              </button>
              <button
                className="deck-refresh"
                onClick={() => onResetScheduling(row.deck)}
                title="Reset scheduling"
                aria-label={`Reset scheduling for ${row.deck.name}`}
              >
                <RotateCcw size={15} />
              </button>
              <button
                className="deck-delete"
                onClick={() => onDelete(row.deck)}
                title="Delete deck"
                aria-label={`Delete ${row.deck.name}`}
              >
                <Trash2 size={15} />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function StudyView({
  busy,
  deck,
  decks,
  selectedDeckId,
  setSelectedDeckId,
  deleteDeck,
  resetDeckScheduling,
  goToCreate,
  goToImport,
  reload,
  runBusy,
  onSessionActiveChange,
  audioVolume,
}: {
  busy: boolean
  deck: DeckDetail | null
  decks: DeckSummary[]
  selectedDeckId: string
  setSelectedDeckId: (deckId: string) => void
  deleteDeck: (deck: DeckSummary) => void
  resetDeckScheduling: (deck: DeckSummary) => void
  goToCreate: () => void
  goToImport: () => void
  reload: () => Promise<void>
  runBusy: BusyRunner
  onSessionActiveChange: (active: boolean) => void
  audioVolume: number
}) {
  const [mode, setMode] = useState<StudyMode>('mixed')
  const [session, setSession] = useState<StudySession | null>(null)
  const [index, setIndex] = useState(0)
  const [showBack, setShowBack] = useState(false)
  const [recommendation, setRecommendation] = useState('')
  const [publishNote, setPublishNote] = useState('')
  const cardStartedAtRef = useRef(performance.now())
  const cardRevealedAtRef = useRef<number | null>(null)

  const current = session?.cards[index]

  // A parent deck has no direct cards, so its DeckDetail counts are 0. Use the
  // subdeck-inclusive aggregate (what the tree shows and what a study session
  // actually pulls from) for the metrics and the start/empty-state gate.
  const selectedCounts = useMemo(() => {
    const row = buildDeckRows(decks).find((entry) => entry.deck.id === selectedDeckId)
    if (row) return row.aggregate
    return {
      totalCards: deck?.totalCards ?? 0,
      dueCards: deck?.dueCards ?? 0,
      newCards: deck?.newCards ?? 0,
    }
  }, [decks, selectedDeckId, deck])

  const resetCardTimer = useCallback(() => {
    cardStartedAtRef.current = performance.now()
    cardRevealedAtRef.current = null
  }, [])

  useEffect(() => {
    setSession(null)
    setIndex(0)
    setShowBack(false)
    setRecommendation('')
    resetCardTimer()
  }, [mode, resetCardTimer, selectedDeckId])

  useEffect(() => {
    onSessionActiveChange(Boolean(session))
    return () => onSessionActiveChange(false)
  }, [session, onSessionActiveChange])

  useEffect(() => {
    if (!session || !current) return
    resetCardTimer()
  }, [current, resetCardTimer, session])

  // Publishing shares the deck's cards with everyone on the library host, so it
  // asks first and reports the outcome in place.
  const publishGlobally = () => {
    if (!selectedDeckId) return
    const name = decks.find((item) => item.id === selectedDeckId)?.name ?? 'this deck'
    const confirmed = window.confirm(
      `Publish "${name}" to the global library? Its cards become visible to everyone browsing. Your scheduling and review history are not shared.`
    )
    if (!confirmed) return

    setPublishNote('')
    runBusy(async () => {
      try {
        const published = await window.onami.globalDecks.publish(selectedDeckId)
        setPublishNote(`Published "${published.name}" with ${published.cardCount} cards.`)
      } catch (error) {
        setPublishNote(error instanceof Error ? error.message : String(error))
      }
    }, 'Publishing deck...')
  }

  const start = () =>
    runBusy(async () => {
      if (!selectedDeckId) return
      const next = await window.onami.study.startSession(selectedDeckId, mode, {
        limit: 30,
        newEvery: 5,
        unitTestThreshold: 0.8,
      })
      setIndex(0)
      setShowBack(false)
      if (next.cards.length === 0) {
        setSession(null)
        setRecommendation('No cards are ready for this mode.')
        return
      }
      setSession(next)
      setRecommendation('')
      resetCardTimer()
    })

  const answer = (rating: ReviewRating) =>
    runBusy(async () => {
      if (!session || !current) return
      const answeredAt = performance.now()
      const revealMs =
        cardRevealedAtRef.current === null
          ? 0
          : Math.max(0, Math.round(cardRevealedAtRef.current - cardStartedAtRef.current))
      const elapsedMs = Math.max(0, Math.round(answeredAt - cardStartedAtRef.current))
      const answerMs =
        cardRevealedAtRef.current === null
          ? 0
          : Math.max(0, Math.round(answeredAt - cardRevealedAtRef.current))
      const result = await window.onami.study.answer({
        sessionId: session.id,
        cardId: current.id,
        rating,
        elapsedMs,
        revealMs,
        answerMs,
      })
      if (result.recommendation) setRecommendation(result.recommendation)
      if (index + 1 >= session.cards.length) {
        setSession(null)
        setIndex(0)
        setShowBack(false)
        resetCardTimer()
        await reload()
        return
      }
      setIndex(index + 1)
      setShowBack(false)
    })

  const exitSession = () => {
    setSession(null)
    setIndex(0)
    setShowBack(false)
    setRecommendation('')
    resetCardTimer()
    void reload()
  }

  if (session && current) {
    return (
      <section className="study-session">
        <div className="study-session-header">
          <div className="study-session-stats">
            <div className="session-stat">
              <span>Deck</span>
              <strong>{deck?.name ?? 'Study'}</strong>
            </div>
            <div className="session-stat">
              <span>Mode</span>
              <strong>{formatStudyModeLabel(mode)}</strong>
            </div>
            <div className="session-stat">
              <span>Due</span>
              <strong>{deck?.dueCards ?? 0}</strong>
            </div>
            <div className="session-stat">
              <span>Progress</span>
              <strong>{index + 1}/{session.cards.length}</strong>
            </div>
          </div>
          <button className="secondary-action exit-session" onClick={exitSession}>
            <X size={16} />
            Exit
          </button>
        </div>

        <article className="study-card study-card-session">
          <div className="card-meta">
            <span>{index + 1} / {session.cards.length}</span>
            <span>{dueLabel(current)}</span>
          </div>
          <div className="prompt">
            <Html
              html={showBack ? current.backHtml : current.frontHtml}
              audioVolume={audioVolume}
              autoPlayKey={`${current.id}:${showBack ? 'back' : 'front'}`}
            />
          </div>
        </article>

        <footer className="study-session-footer">
          {!showBack ? (
            <button
              className="primary-action session-action"
              onClick={() => {
                if (cardRevealedAtRef.current === null) cardRevealedAtRef.current = performance.now()
                setShowBack(true)
              }}
            >
              Reveal
            </button>
          ) : (
            <div className={`rating-grid session-rating-grid${mode === 'unit-test' ? ' unit-test' : ''}`}>
              {mode === 'unit-test' ? (
                <>
                  <button onClick={() => answer('hard')}>Hard</button>
                  <button onClick={() => answer('easy')}>Easy</button>
                </>
              ) : (
                <>
                  <button onClick={() => answer('again')}>Again</button>
                  <button onClick={() => answer('hard')}>Hard</button>
                  <button onClick={() => answer('good')}>Good</button>
                  <button onClick={() => answer('easy')}>Easy</button>
                </>
              )}
            </div>
          )}

          {recommendation && <div className="recommendation">{recommendation}</div>}
        </footer>
      </section>
    )
  }

  return (
    <section className="view-stack">
      <DeckTree
        decks={decks}
        selectedDeckId={selectedDeckId}
        onSelect={setSelectedDeckId}
        onResetScheduling={resetDeckScheduling}
        onDelete={deleteDeck}
      />

      <div className="deck-strip">
        <Metric label="Cards" value={selectedCounts.totalCards} />
        <Metric label="Due" value={selectedCounts.dueCards} />
        <Metric label="New" value={selectedCounts.newCards} />
      </div>

      <button
        className="secondary-action compact-action"
        disabled={busy || !selectedDeckId || selectedCounts.totalCards === 0}
        onClick={publishGlobally}
      >
        <Globe2 size={16} />
        Publish globally
      </button>
      {publishNote && <div className="recommendation">{publishNote}</div>}

      <div className="segmented">
        {(['learn-new', 'review-due', 'mixed', 'unit-test'] as StudyMode[]).map((item) => (
          <button key={item} className={mode === item ? 'selected' : ''} onClick={() => setMode(item)}>
            {formatStudyModeLabel(item)}
          </button>
        ))}
      </div>

      {!session && selectedCounts.totalCards === 0 && (
        <div className="empty-state">
          <BookOpen size={28} />
          <h2>{deck?.name ?? 'Study'}</h2>
          <div className="empty-actions">
            <button onClick={goToImport}>
              <FileUp size={17} />
              Import
            </button>
            <button onClick={goToCreate}>
              <Plus size={17} />
              Add card
            </button>
          </div>
        </div>
      )}

      {!session && selectedCounts.totalCards > 0 && (
        <button className="primary-action" disabled={busy || !selectedDeckId} onClick={start}>
          <BookOpen size={18} />
          Start {formatStudyModeLabel(mode)}
        </button>
      )}

      {recommendation && <div className="recommendation">{recommendation}</div>}
    </section>
  )
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}

function CreateView({
  decks,
  selectedDeckId,
  reload,
  runBusy,
}: {
  decks: DeckSummary[]
  selectedDeckId: string
  reload: () => Promise<void>
  runBusy: BusyRunner
}) {
  const [deckId, setDeckId] = useState(selectedDeckId)
  const [newDeckName, setNewDeckName] = useState('')
  const [noteType, setNoteType] = useState<'basic' | 'cloze'>('basic')
  const [front, setFront] = useState('')
  const [back, setBack] = useState('')
  const [cloze, setCloze] = useState('')
  const [tags, setTags] = useState('')
  const [batch, setBatch] = useState('')
  const [aiInput, setAiInput] = useState('')
  const [drafts, setDrafts] = useState<AiDraftCard[]>([])

  useEffect(() => {
    setDeckId(selectedDeckId)
  }, [selectedDeckId])

  const activeDeckId = deckId || decks[0]?.id || ''
  const tagList = tags.split(',').map((tag) => tag.trim()).filter(Boolean)
  const clozeFront = cloze.replace(/{{c\d+::(.*?)(?:::.*?)?}}/g, '<span class="cloze">[...]</span>')
  const clozeBack = cloze.replace(/{{c\d+::(.*?)(?:::.*?)?}}/g, '<strong>$1</strong>')

  const saveSingle = () =>
    runBusy(async () => {
      await window.onami.cards.create({
        deckId: activeDeckId,
        noteType,
        frontHtml: noteType === 'cloze' ? clozeFront : front,
        backHtml: noteType === 'cloze' ? clozeBack : back,
        tags: tagList,
        fields: noteType === 'cloze' ? { Text: cloze } : { Front: front, Back: back },
      })
      setFront('')
      setBack('')
      setCloze('')
      await reload()
    })

  const saveBatch = () =>
    runBusy(async () => {
      const rows = batch
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [rowFront, rowBack] = line.includes('\t') ? line.split('\t') : line.split('|')
          return { rowFront: rowFront?.trim(), rowBack: rowBack?.trim() }
        })
        .filter((row) => row.rowFront && row.rowBack)
      await Promise.all(
        rows.map((row) =>
          window.onami.cards.create({
            deckId: activeDeckId,
            noteType: 'basic',
            frontHtml: row.rowFront,
            backHtml: row.rowBack,
            tags: tagList,
          })
        )
      )
      setBatch('')
      await reload()
    })

  const createDeck = () =>
    runBusy(async () => {
      const deck = await window.onami.decks.create({ name: newDeckName })
      setNewDeckName('')
      setDeckId(deck.id)
      await reload()
    })

  const generateAi = () =>
    runBusy(async () => {
      const result = await window.onami.ai.generateCards(aiInput, {
        style: noteType === 'cloze' ? 'cloze' : 'mixed',
        deckId: activeDeckId,
        count: 8,
      })
      setDrafts(result.cards)
    })

  const saveDraft = (draft: AiDraftCard) =>
    runBusy(async () => {
      await window.onami.cards.create({
        deckId: activeDeckId,
        noteType: draft.noteType,
        frontHtml: draft.frontHtml,
        backHtml: draft.backHtml,
        tags: draft.tags,
      })
      setDrafts((current) => current.filter((item) => item !== draft))
      await reload()
    })

  return (
    <section className="view-stack">
      <DeckPicker decks={decks} selectedDeckId={activeDeckId} onChange={setDeckId} />
      <div className="inline-create">
        <input value={newDeckName} onChange={(event) => setNewDeckName(event.target.value)} placeholder="New deck" />
        <button onClick={createDeck} disabled={!newDeckName.trim()}>
          <Plus size={16} />
        </button>
      </div>

      <div className="segmented">
        <button className={noteType === 'basic' ? 'selected' : ''} onClick={() => setNoteType('basic')}>
          Basic
        </button>
        <button className={noteType === 'cloze' ? 'selected' : ''} onClick={() => setNoteType('cloze')}>
          Cloze
        </button>
      </div>

      {noteType === 'basic' ? (
        <>
          <textarea value={front} onChange={(event) => setFront(event.target.value)} placeholder="Front" />
          <textarea value={back} onChange={(event) => setBack(event.target.value)} placeholder="Back" />
        </>
      ) : (
        <textarea
          value={cloze}
          onChange={(event) => setCloze(event.target.value)}
          placeholder="Use {{c1::hidden answer}} inside the text"
        />
      )}
      <label className="field">
        <span><Tags size={14} /> Tags</span>
        <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="biology, chapter-2" />
      </label>
      <button className="primary-action" onClick={saveSingle} disabled={!activeDeckId}>
        <Check size={18} />
        Save card
      </button>

      <div className="divider" />
      <textarea
        value={batch}
        onChange={(event) => setBatch(event.target.value)}
        placeholder="Batch paste: front | back, one card per line"
      />
      <button className="secondary-action" onClick={saveBatch} disabled={!batch.trim()}>
        <Layers3 size={18} />
        Save batch
      </button>

      <div className="divider" />
      <textarea
        value={aiInput}
        onChange={(event) => setAiInput(event.target.value)}
        placeholder="Paste notes for AI card drafts"
      />
      <button className="secondary-action" onClick={generateAi} disabled={!aiInput.trim()}>
        <Sparkles size={18} />
        Generate drafts
      </button>
      {drafts.map((draft, draftIndex) => (
        <div className="draft" key={`${draft.frontHtml}-${draftIndex}`}>
          <Html html={draft.frontHtml} />
          <Html html={draft.backHtml} />
          <button onClick={() => saveDraft(draft)}>Save draft</button>
        </div>
      ))}
    </section>
  )
}

const formatHearts = (hearts: number): string => `${hearts} ${hearts === 1 ? 'heart' : 'hearts'}`

const formatGlobalCards = (cards: number): string => `${cards} ${cards === 1 ? 'card' : 'cards'}`

/**
 * The global deck library. Decks are published by other oNami users and the
 * host returns them most-hearted first, so the list is shown in the order it
 * arrives rather than re-sorted here.
 */
function BrowseView({
  onAdded,
  runBusy,
}: {
  onAdded: (deckId: string) => Promise<void>
  runBusy: BusyRunner
}) {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [decks, setDecks] = useState<GlobalDeckSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [addingId, setAddingId] = useState('')
  const [reloadToken, setReloadToken] = useState(0)

  // Typing shouldn't fire one request per keystroke at the host.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 300)
    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.onami.globalDecks
      .list(debouncedSearch)
      .then((listing) => {
        if (cancelled) return
        setDecks(listing)
        setError('')
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [debouncedSearch, reloadToken])

  const toggleHeart = async (deck: GlobalDeckSummary) => {
    const hearted = !deck.viewerHearted
    setError('')
    try {
      const updated = await window.onami.globalDecks.heart(deck.id, hearted)
      setDecks((current) =>
        current.map((item) =>
          item.id === deck.id
            ? { ...item, heartCount: updated.heartCount, viewerHearted: updated.viewerHearted }
            : item
        )
      )
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const addToLibrary = (deck: GlobalDeckSummary) => {
    setError('')
    setResult('')
    setAddingId(deck.id)
    runBusy(async () => {
      try {
        const added = await window.onami.globalDecks.addToLibrary(deck.id)
        setResult(`Added "${added.name}" with ${added.totalCards} cards.`)
        await onAdded(added.id)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setAddingId('')
      }
    }, 'Adding deck...')
  }

  return (
    <section className="view-stack">
      <div className="global-search">
        <Search size={16} />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search published decks"
          aria-label="Search published decks"
        />
        <button
          className="secondary-action compact-action"
          onClick={() => setReloadToken((token) => token + 1)}
          disabled={loading}
        >
          <RotateCcw size={16} />
          Refresh
        </button>
      </div>

      {error && <div className="notice">{error}</div>}
      {result && <div className="recommendation">{result}</div>}
      {loading && <p className="global-empty">Loading decks…</p>}
      {!loading && !error && decks.length === 0 && (
        <p className="global-empty">
          {debouncedSearch.trim() ? 'No published decks match that search.' : 'No decks have been published yet.'}
        </p>
      )}

      <div className="global-list">
        {decks.map((deck) => (
          <article className="global-card" key={deck.id}>
            <header>
              <h3>{deck.name}</h3>
              <span className="global-meta">
                {formatGlobalCards(deck.cardCount)} · {formatHearts(deck.heartCount)}
              </span>
            </header>
            <div className="global-actions">
              <button
                className={`heart-toggle${deck.viewerHearted ? ' hearted' : ''}`}
                aria-pressed={deck.viewerHearted}
                aria-label={deck.viewerHearted ? `Unheart ${deck.name}` : `Heart ${deck.name}`}
                onClick={() => void toggleHeart(deck)}
              >
                <Heart size={16} />
                {deck.heartCount}
              </button>
              <button
                className="secondary-action compact-action"
                disabled={addingId !== ''}
                onClick={() => addToLibrary(deck)}
              >
                <Plus size={16} />
                {addingId === deck.id ? 'Adding…' : 'Add to library'}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function ImportView({
  onImported,
  runBusy,
}: {
  onImported: (deckId: string) => Promise<void>
  runBusy: BusyRunner
}) {
  const [filePath, setFilePath] = useState('')
  const [preserve, setPreserve] = useState(false)
  const [result, setResult] = useState('')

  const choose = () =>
    runBusy(async () => {
      const selected = await window.onami.decks.selectApkg()
      if (selected) setFilePath(selected)
    })

  const importDeck = () =>
    runBusy(async () => {
      const imported = await window.onami.decks.importApkg(filePath, { preserveScheduling: preserve })
      setResult(
        `${imported.deckName}: ${imported.importedCards} cards, ${imported.importedMedia} media files, ${imported.updatedNotes} updates.`
      )
      await onImported(imported.deckId)
    })

  return (
    <section className="view-stack">
      <button className="primary-action" onClick={choose}>
        <FileUp size={18} />
        Choose .apkg
      </button>
      {filePath && <p className="path-label">{filePath}</p>}
      <label className="toggle">
        <input type="checkbox" checked={preserve} onChange={(event) => setPreserve(event.target.checked)} />
        Preserve Anki scheduling when available
      </label>
      <button className="secondary-action" disabled={!filePath} onClick={importDeck}>
        Import deck
      </button>
      {result && <div className="recommendation">{result}</div>}
    </section>
  )
}

function StatsView({
  stats,
  decks,
  deleteDeck,
  resetDeckScheduling,
  audioVolume,
}: {
  stats: AppStats
  decks: DeckSummary[]
  deleteDeck: (deck: DeckSummary) => void
  resetDeckScheduling: (deck: DeckSummary) => void
  audioVolume: number
}) {
  const [scopedDeckId, setScopedDeckId] = useState('')
  const [scopedStats, setScopedStats] = useState<AppStats>(stats)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (scopedDeckId && !decks.some((deck) => deck.id === scopedDeckId)) setScopedDeckId('')
  }, [decks, scopedDeckId])

  useEffect(() => {
    if (!scopedDeckId) {
      setScopedStats(stats)
      setLoading(false)
      setError('')
      return
    }

    let cancelled = false
    setLoading(true)
    setError('')

    window.onami.stats
      .get({ deckId: scopedDeckId })
      .then((next) => {
        if (!cancelled) setScopedStats(next)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [scopedDeckId, stats])

  const activeStats = scopedDeckId ? scopedStats : stats

  return (
    <section className="view-stack">
      <div className="stats-toolbar">
        <DeckPicker
          decks={decks}
          selectedDeckId={scopedDeckId}
          onChange={setScopedDeckId}
          label="Scope"
          includeAll
          allLabel="All decks"
        />
        {scopedDeckId && (
          <button className="secondary-action compact-action" onClick={() => setScopedDeckId('')}>
            All decks
          </button>
        )}
      </div>
      {error && <div className="notice">{error}</div>}
      <div className="progress-row">
        <span>{activeStats.scopeDeckName ?? 'All decks'}</span>
        <strong>{percent(activeStats.completion.completionRatio)}</strong>
      </div>
      <div className="deck-strip four">
        <Metric label="Decks" value={activeStats.totalDecks} />
        <Metric label="Cards" value={activeStats.totalCards} />
        <Metric label="New" value={activeStats.newCards} />
        <Metric label="Due" value={activeStats.dueCards} />
      </div>
      <div className="deck-strip four">
        <Metric label="Today" value={activeStats.reviewedToday} />
        <Metric label="Week" value={activeStats.reviewedThisWeek} />
        <Metric label="Month" value={activeStats.reviewedThisMonth} />
        <Metric label="Reviews" value={activeStats.totalReviews} />
      </div>
      <div className="deck-strip four">
        <Metric label="Today time" value={formatDuration(activeStats.studyTime.todayMs)} />
        <Metric label="Week time" value={formatDuration(activeStats.studyTime.weekMs)} />
        <Metric label="Month time" value={formatDuration(activeStats.studyTime.monthMs)} />
        <Metric label="All time" value={formatDuration(activeStats.studyTime.overallMs)} />
      </div>
      <div className="deck-strip four">
        <Metric label="Streak" value={`${activeStats.streakDays}d`} />
        <Metric label="Longest" value={`${activeStats.longestStreakDays}d`} />
        <Metric label="Recall" value={percent(activeStats.averageSuccessRate)} />
        <Metric
          label="Learned"
          value={`${activeStats.completion.completedCards}/${activeStats.completion.totalCards}`}
        />
      </div>
      <div className="deck-strip three">
        <Metric label="Avg card" value={formatDuration(activeStats.averageReviewMs)} />
        <Metric label="Avg reveal" value={formatDuration(activeStats.averageRevealMs)} />
        <Metric
          label="Again -> easy"
          value={
            activeStats.averageAgainToEasyMs === null
              ? '-'
              : formatDuration(activeStats.averageAgainToEasyMs)
          }
        />
      </div>
      <div className="stats-section">
        <div className="stats-section-header">
          <span>
            <CheckCircle2 size={16} />
            Unit test scores
          </span>
          {loading && <strong>Updating...</strong>}
        </div>
        <div className="unit-test-score-list">
          {activeStats.unitTestScores.map((deckScore) => (
            <div className="unit-test-score-row" key={deckScore.deckId}>
              <div>
                <strong>{deckScore.deckName}</strong>
                <span>{deckScore.hasTakenTest ? 'Latest deck test' : 'Not taken'}</span>
              </div>
              <strong>{percent(deckScore.score)}</strong>
              {deckScore.subdeckAverage !== null && (
                <span>
                  Subdeck average {percent(deckScore.subdeckAverage)} ({deckScore.subdeckCount})
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="stats-section">
        <div className="stats-section-header">
          <span>
            <Brain size={16} />
            Hardest cards
          </span>
          {loading && <strong>Updating...</strong>}
        </div>
        {activeStats.hardestCards.length > 0 ? (
          <div className="hard-card-list">
            {activeStats.hardestCards.map((card) => (
              <HardCardRow card={card} audioVolume={audioVolume} key={card.cardId} />
            ))}
          </div>
        ) : (
          <div className="path-label">Study a few cards and the difficulty trends will start showing here.</div>
        )}
      </div>
      <DeckTree
        decks={decks}
        selectedDeckId={scopedDeckId}
        onSelect={setScopedDeckId}
        onResetScheduling={resetDeckScheduling}
        onDelete={deleteDeck}
      />
    </section>
  )
}

function HardCardRow({ card, audioVolume }: { card: HardCardSummary; audioVolume: number }) {
  const front = useMemo(() => extractAudio(card.frontHtml), [card.frontHtml])
  const back = useMemo(() => extractAudio(card.backHtml), [card.backHtml])
  const audioSources = useMemo(
    () => [...new Set([...front.audioSources, ...back.audioSources])],
    [back.audioSources, front.audioSources]
  )

  return (
    <div className="hard-card-row">
      <div className="hard-card-copy">
        {front.html ? (
          <div className="hard-card-front" dangerouslySetInnerHTML={{ __html: front.html }} />
        ) : (
          <strong>Untitled card</strong>
        )}
        <span className="hard-card-deck-name">{card.deckName}</span>
      </div>
      <div className="hard-card-answer">
        <span>Answer</span>
        {back.html ? (
          <div className="hard-card-answer-content" dangerouslySetInnerHTML={{ __html: back.html }} />
        ) : (
          <div className="hard-card-answer-content">No answer provided</div>
        )}
      </div>
      {audioSources.length > 0 && (
        <div className="hard-card-audio" aria-label="Card audio">
          {audioSources.map((source, index) => (
            <AudioPlayButton key={`${source}-${index}`} src={source} volume={audioVolume} />
          ))}
        </div>
      )}
      <div className="hard-card-meta">
        <span>{percent(card.successRate)} recall</span>
        <span>{formatDuration(card.averageReviewMs)} avg</span>
        <span>{card.againCount} again</span>
        <span>
          {card.averageAgainToEasyMs === null
            ? 'No easy recovery yet'
            : `${formatDuration(card.averageAgainToEasyMs)} to easy`}
        </span>
      </div>
    </div>
  )
}

function SettingsView({
  appSettings,
  onAppSettingsChanged,
  runBusy,
  setBusyLabel,
  reload,
}: {
  appSettings: AppSettings
  onAppSettingsChanged: (settings: AppSettings) => void
  runBusy: BusyRunner
  setBusyLabel: (label: string) => void
  reload: () => Promise<void>
}) {
  const [aiSettings, setAiSettings] = useState<AiSettings>({ hasApiKey: false, model: 'gpt-4o-mini' })
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('gpt-4o-mini')
  const [audioVolume, setAudioVolume] = useState(appSettings.audioVolume)
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [syncHostUrl, setSyncHostUrl] = useState('')
  const [syncHealth, setSyncHealth] = useState<SyncHealthResult | null>(null)
  const [pairingFlow, setPairingFlow] = useState<PairingFlow>(null)
  const [pairing, setPairing] = useState<SyncStartPairingResult | null>(null)
  const [joinCode, setJoinCode] = useState('')
  const [pairingMode, setPairingMode] = useState<SyncPairingMode>('merge')
  const [starterReadyToConfirm, setStarterReadyToConfirm] = useState(false)
  const [syncRun, setSyncRun] = useState<SyncRunResult | null>(null)
  const [syncMessage, setSyncMessage] = useState('')
  const [syncProgress, setSyncProgress] = useState<SyncProgressEvent[]>([])
  const BackupIcon =
    syncStatus?.backupState === 'backed-up'
      ? CloudCheck
      : syncStatus?.backupState === 'needs-sync'
        ? CloudUpload
        : CloudOff
  const backupTitle =
    syncStatus?.backupState === 'backed-up'
      ? 'Structured data backed up'
      : syncStatus?.backupState === 'needs-sync'
        ? 'Backup pending'
        : syncStatus?.backupState === 'no-data'
          ? 'No study data uploaded yet'
          : 'Host backup off'
  const backupTime = formatSyncTimestamp(syncStatus?.lastBackedUpAt ?? null)
  const backupDetail =
    syncStatus?.backupState === 'backed-up'
      ? `Host stores synced deck, card, and review events${backupTime ? ` as of ${backupTime}` : ''}. Media file backup is not enabled yet.`
      : syncStatus?.backupState === 'needs-sync'
        ? `${syncStatus.pendingEvents} local changes are queued and will sync automatically.`
        : syncStatus?.backupState === 'no-data'
          ? 'New cards and reviews will sync automatically after this device has study data.'
          : 'Pair this device to back up structured study data to the host.'

  const applySyncStatus = useCallback((next: SyncStatus) => {
    setSyncStatus(next)
    setSyncHostUrl(next.hostUrl)
    if (next.recentProgress.length > 0) setSyncProgress(next.recentProgress.slice(0, 12))
    if (next.activeProgress) setSyncMessage(next.activeProgress.message)
  }, [])

  useEffect(() => {
    window.onami.ai.getSettings().then((next) => {
      setAiSettings(next)
      setModel(next.model)
    })
    window.onami.sync.getStatus().then(applySyncStatus)
  }, [applySyncStatus])

  useEffect(() => {
    setAudioVolume(appSettings.audioVolume)
  }, [appSettings.audioVolume])

  useEffect(() => {
    return window.onami.sync.onProgress((event) => {
      setBusyLabel(event.message)
      setSyncMessage(event.message)
      setSyncProgress((current) => [event, ...current].slice(0, 12))
    })
  }, [setBusyLabel])

  const save = () =>
    runBusy(async () => {
      const [nextAiSettings, nextAppSettings] = await Promise.all([
        window.onami.ai.saveSettings({ apiKey: apiKey || undefined, model }),
        window.onami.settings.save({ audioVolume }),
      ])
      setAiSettings(nextAiSettings)
      onAppSettingsChanged(nextAppSettings)
      setApiKey('')
    })

  const saveSyncHost = () =>
    runBusy(async () => {
      const next = await window.onami.sync.saveSettings({ hostUrl: syncHostUrl })
      applySyncStatus(next)
      setSyncMessage('Sync host saved.')
    })

  const checkSyncHost = () =>
    runBusy(async () => {
      const result = await window.onami.sync.checkHealth()
      setSyncHealth(result)
      setSyncMessage(result.ok ? 'Sync host is reachable.' : result.error ?? 'Sync host is not reachable.')
    })

  const startPairing = () =>
    runBusy(async () => {
      const result = await window.onami.sync.startPairing()
      setPairingFlow('start')
      setPairing(result)
      setJoinCode('')
      setStarterReadyToConfirm(false)
      applySyncStatus(await window.onami.sync.getStatus())
      setSyncMessage('Give the pairing code to the other device.')
    })

  const joinPairing = () =>
    runBusy(async () => {
      if (!joinCode.trim()) throw new Error('Enter the pairing code from the other device.')
      const result = await window.onami.sync.joinPairing({ pairingCode: joinCode })
      setPairingFlow('join')
      setPairing({
        deviceId: result.deviceId,
        pairingCode: joinCode,
        confirmationCode: result.confirmationCode,
        expiresInMs: Math.max(0, Date.parse(result.expiresAt) - Date.now()),
      })
      setStarterReadyToConfirm(true)
      applySyncStatus(await window.onami.sync.getStatus())
      setSyncMessage('Confirm this device, then tell the starter to confirm.')
    })

  const runInitialSyncAfterPairing = async () => {
    setPairingFlow(null)
    setPairing(null)
    setJoinCode('')
    setStarterReadyToConfirm(false)
    setSyncProgress([])
    setBusyLabel('Syncing content with host...')
    setSyncMessage('Pairing complete. Syncing content with host...')
    try {
      const result = await window.onami.sync.syncNow()
      setSyncRun(result)
      applySyncStatus(await window.onami.sync.getStatus())
      await reload()
      setSyncMessage(
        `Initial sync complete. Sent ${result.pushedEvents} local changes and applied ${result.appliedEvents}/${result.pulledEvents} host updates.`
      )
    } catch (error) {
      applySyncStatus(await window.onami.sync.getStatus())
      setSyncMessage(
        `Device paired, but initial sync failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  const confirmPairing = () =>
    runBusy(async () => {
      const pairingCode = pairing?.pairingCode || joinCode
      if (!pairingCode.trim()) throw new Error('Pairing code is required.')
      let result = await window.onami.sync.confirmPairing({ pairingCode, mode: pairingMode })
      applySyncStatus(await window.onami.sync.getStatus())
      if (!result.completed) {
        const waitingMessage =
          pairingFlow === 'start'
            ? 'Waiting for the other device to confirm pairing...'
            : 'Waiting for the starter device to finish pairing...'
        setBusyLabel(waitingMessage)
        setSyncMessage(waitingMessage)
        for (let attempt = 0; attempt < 30; attempt += 1) {
          await wait(2000)
          result = await window.onami.sync.confirmPairing({ pairingCode, mode: pairingMode })
          applySyncStatus(await window.onami.sync.getStatus())
          if (result.completed && result.syncGroupId) break
        }
      }

      if (result.completed && result.syncGroupId) {
        await runInitialSyncAfterPairing()
        return
      }

      setSyncMessage('Waiting for the other device.')
    }, 'Confirming pairing...')

  const resetPairingFlow = () => {
    setPairingFlow(null)
    setPairing(null)
    setJoinCode('')
    setStarterReadyToConfirm(false)
    setSyncMessage('')
  }

  const syncNow = () =>
    runBusy(async () => {
      setSyncProgress([])
      setSyncMessage('Syncing local changes to host...')
      const result = await window.onami.sync.syncNow()
      setSyncRun(result)
      applySyncStatus(await window.onami.sync.getStatus())
      await reload()
      setSyncMessage(
        `Synced ${result.pushedEvents} local, ${result.appliedEvents}/${result.pulledEvents} remote.`
      )
    }, 'Syncing content with host...')

  return (
    <section className="view-stack">
      <div className="settings-state">
        <Sparkles size={18} />
        <span>{aiSettings.hasApiKey ? 'AI generation is configured.' : 'AI generation needs an API key.'}</span>
      </div>
      <label className="field">
        <span>Audio volume</span>
        <div className="slider-row">
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={audioVolume}
            onChange={(event) => setAudioVolume(Number(event.target.value))}
          />
          <strong>{Math.round(audioVolume * 100)}%</strong>
        </div>
      </label>
      <label className="field">
        <span>OpenAI API key</span>
        <input
          value={apiKey}
          type="password"
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={aiSettings.hasApiKey ? 'Stored securely' : 'sk-...'}
        />
      </label>
      <label className="field">
        <span>Model</span>
        <input value={model} onChange={(event) => setModel(event.target.value)} />
      </label>
      <div className="settings-group">
        <div className="settings-state">
          <CheckCircle2 size={18} />
          <span>{syncStatus?.paired ? 'Sync device is paired.' : 'Sync device is not paired.'}</span>
        </div>
        {syncStatus && (
          <>
            <div className={`settings-state backup-state ${syncStatus.backupState}`}>
              <BackupIcon size={18} />
              <span>{backupTitle}</span>
            </div>
            <div className="settings-note">
              {backupDetail}
              <br />
              Uploaded {syncStatus.backedUpEvents} / Pending {syncStatus.pendingEvents} / Cursor{' '}
              {syncStatus.lastHostCursor}
            </div>
          </>
        )}
        <label className="field">
          <span>Sync host</span>
          <input value={syncHostUrl} onChange={(event) => setSyncHostUrl(event.target.value)} />
        </label>
        <div className="button-row">
          <button className="secondary-action" onClick={saveSyncHost}>
            Save host
          </button>
          <button className="secondary-action" onClick={checkSyncHost}>
            Check host
          </button>
        </div>
        {syncHealth && (
          <div className="settings-note">
            {syncHealth.ok ? `${syncHealth.service ?? 'Sync host'} online` : syncHealth.error}
          </div>
        )}
        {!pairingFlow && (
          <div className="button-row">
            <button className="secondary-action" onClick={() => void startPairing()}>
              Start pairing
            </button>
            <button
              className="secondary-action"
              onClick={() => {
                setPairingFlow('join')
                setPairing(null)
                setJoinCode('')
                setStarterReadyToConfirm(false)
                setSyncMessage('Enter the pairing code from the other device.')
              }}
            >
              Join pairing
            </button>
          </div>
        )}
        {pairingFlow === 'start' && pairing && (
          <>
            <div className="pairing-code-stack">
              <div className="pairing-code-panel">
                <span>Pairing code</span>
                <strong>{pairing.pairingCode}</strong>
              </div>
              <div className="settings-note">
                The other device enters this pairing code. Match the confirmation code on both screens before
                finishing.
              </div>
              <div className="pairing-code-panel">
                <span>Confirmation code</span>
                <strong>{pairing.confirmationCode}</strong>
              </div>
            </div>
            <label className="field">
              <span>Pairing mode</span>
              <select value={pairingMode} onChange={(event) => setPairingMode(event.target.value as SyncPairingMode)}>
                <option value="merge">Merge devices</option>
                <option value="copy-desktop-to-phone">Copy desktop to phone</option>
                <option value="copy-phone-to-desktop">Copy phone to desktop</option>
              </select>
            </label>
            {!starterReadyToConfirm ? (
              <button className="secondary-action" onClick={() => setStarterReadyToConfirm(true)}>
                Other device is ready
              </button>
            ) : (
              <button className="primary-action" onClick={confirmPairing}>
                Finish pairing
              </button>
            )}
            <button className="secondary-action" onClick={resetPairingFlow}>
              Cancel pairing
            </button>
          </>
        )}
        {pairingFlow === 'join' && (
          <>
            <label className="field">
              <span>Pairing code</span>
              <input value={joinCode} onChange={(event) => setJoinCode(event.target.value)} placeholder="123-456" />
            </label>
            {!pairing ? (
              <button className="primary-action" onClick={joinPairing} disabled={!joinCode.trim()}>
                Join pairing
              </button>
            ) : (
              <>
                <div className="pairing-code-panel">
                  <span>Confirmation code</span>
                  <strong>{pairing.confirmationCode}</strong>
                </div>
                <div className="settings-note">Confirm here, then tell the starter to finish pairing.</div>
                <button className="primary-action" onClick={confirmPairing}>
                  Confirm this device
                </button>
              </>
            )}
            <button className="secondary-action" onClick={resetPairingFlow}>
              Cancel pairing
            </button>
          </>
        )}
        <button className="secondary-action" onClick={syncNow} disabled={!syncStatus?.paired}>
          Sync now
        </button>
        {syncRun && (
          <div className="settings-note">
            Last sync pushed {syncRun.pushedEvents}, pulled {syncRun.pulledEvents}, applied {syncRun.appliedEvents}.
          </div>
        )}
        {syncProgress.length > 0 && (
          <div className="sync-progress-list" aria-label="Sync progress">
            {syncProgress.map((event, index) => (
              <div key={`${event.stage}-${index}`} className="sync-progress-row">
                <span>{event.stage}</span>
                <strong>{event.message}</strong>
                {event.current !== undefined && event.total !== undefined && (
                  <small>
                    {event.current}/{event.total}
                  </small>
                )}
              </div>
            ))}
          </div>
        )}
        {syncMessage && <div className="settings-note">{syncMessage}</div>}
      </div>
      <button
        className="secondary-action"
        onClick={() => {
          void window.onami.appWindow.openDevTools()
        }}
      >
        <Bug size={18} />
        Open DevTools
      </button>
      <button className="primary-action" onClick={save}>
        Save settings
      </button>
    </section>
  )
}

export default App
