import { createEmptyCard, fsrs, Rating, State, type Card as FsrsCard, type Grade } from 'ts-fsrs'

import type { OnamiDatabase, ImportedReviewState } from './database'
import type {
  AnswerInput,
  AnswerResult,
  CardSummary,
  ReviewRating,
  ReviewStateName,
  StudyMode,
  StudySessionSettings,
} from '../../src/shared/types'

const ratingMap: Record<ReviewRating, Rating> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
}

const stateToFsrs: Record<ReviewStateName, State> = {
  New: State.New,
  Learning: State.Learning,
  Review: State.Review,
  Relearning: State.Relearning,
}

const fsrsToState: Record<State, ReviewStateName> = {
  [State.New]: 'New',
  [State.Learning]: 'Learning',
  [State.Review]: 'Review',
  [State.Relearning]: 'Relearning',
}

export interface StudySessionRuntime {
  id: string
  mode: StudyMode
  deckId: string
  cardIds: string[]
  answered: Array<{ cardId: string; rating: ReviewRating }>
  unitTestThreshold: number
}

export const selectCardsForMode = (
  cards: CardSummary[],
  mode: StudyMode,
  settings: StudySessionSettings,
  random: () => number = Math.random
): CardSummary[] => {
  const limit = settings.limit ?? 30
  const now = Date.now()
  const isDue = (card: CardSummary) =>
    card.state !== 'New' && card.dueAt !== null && Date.parse(card.dueAt) <= now
  const newCards = cards
    .filter((card) => card.state === 'New')
    .sort((a, b) => a.templateOrd - b.templateOrd)
  const dueCards = cards.filter(isDue)

  if (mode === 'learn-new') return newCards.slice(0, limit)
  if (mode === 'review-due') return dueCards.slice(0, limit)
  if (mode === 'unit-test') {
    const shuffled = [...cards]
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1))
      const current = shuffled[index]
      shuffled[index] = shuffled[swapIndex]
      shuffled[swapIndex] = current
    }
    return shuffled
  }

  const newEvery = Math.max(1, settings.newEvery ?? 5)
  const mixed: CardSummary[] = []
  let newIndex = 0
  let dueIndex = 0
  while (mixed.length < limit && (dueIndex < dueCards.length || newIndex < newCards.length)) {
    const shouldInsertNew = mixed.length > 0 && mixed.length % newEvery === 0
    if (shouldInsertNew && newIndex < newCards.length) {
      mixed.push(newCards[newIndex])
      newIndex += 1
    } else if (dueIndex < dueCards.length) {
      mixed.push(dueCards[dueIndex])
      dueIndex += 1
    } else if (newIndex < newCards.length) {
      mixed.push(newCards[newIndex])
      newIndex += 1
    }
  }
  return mixed
}

export class SchedulerService {
  private scheduler = fsrs({
    request_retention: 0.9,
    maximum_interval: 36500,
    enable_fuzz: true,
    enable_short_term: true,
    learning_steps: ['1m', '10m'],
    relearning_steps: ['10m'],
  })

  constructor(private readonly database: OnamiDatabase) {}

  answer(input: AnswerInput, session: StudySessionRuntime): AnswerResult {
    if (!session.cardIds.includes(input.cardId)) throw new Error('Card is not part of this study session.')
    if (session.answered.some((answer) => answer.cardId === input.cardId)) {
      throw new Error('Card has already been answered in this study session.')
    }
    if (session.mode === 'unit-test') return this.answerUnitTest(input, session)

    const previous = this.database.getReviewState(input.cardId)
    const fsrsCard = this.toFsrsCard(previous)
    const reviewedAt = new Date()
    const result = this.scheduler.next(fsrsCard, reviewedAt, ratingMap[input.rating] as Grade)
    const nextState = fsrsToState[result.card.state]
    const nextDueAt = nextState === 'New' ? null : result.card.due.toISOString()
    const previousReps = previous?.reps ?? 0
    const success = input.rating === 'again' ? 0 : 1
    const successRate = result.card.reps > 0 ? (previousReps * (previous?.successRate ?? 0) + success) / result.card.reps : 0

    this.database.upsertReviewState(input.cardId, {
      dueAt: nextDueAt,
      state: nextState,
      stability: result.card.stability,
      difficulty: result.card.difficulty,
      elapsedDays: result.card.elapsed_days,
      scheduledDays: result.card.scheduled_days,
      learningSteps: result.card.learning_steps,
      reps: result.card.reps,
      lapses: result.card.lapses,
      successRate,
      lastRating: input.rating,
      lastReviewedAt: reviewedAt.toISOString(),
    })
    this.database.logReview({
      cardId: input.cardId,
      reviewedAt: reviewedAt.toISOString(),
      rating: input.rating,
      elapsedMs: input.elapsedMs ?? 0,
      revealMs: input.revealMs ?? 0,
      answerMs: input.answerMs ?? 0,
      previousDueAt: previous?.dueAt ?? null,
      nextDueAt,
    })

    session.answered.push({ cardId: input.cardId, rating: input.rating })
    const sessionComplete = session.answered.length >= session.cardIds.length

    return {
      cardId: input.cardId,
      rating: input.rating,
      nextDueAt,
      state: nextState,
      successRate,
      sessionComplete,
      unitScore: null,
      recommendation: null,
    }
  }

  private answerUnitTest(input: AnswerInput, session: StudySessionRuntime): AnswerResult {
    if (input.rating !== 'hard' && input.rating !== 'easy') {
      throw new Error('Unit test answers must be Hard or Easy.')
    }

    const reviewedAt = new Date().toISOString()
    if (input.rating === 'hard') this.database.markCardReviewDue(input.cardId, reviewedAt)

    session.answered.push({ cardId: input.cardId, rating: input.rating })
    const sessionComplete = session.answered.length >= session.cardIds.length
    const unitScore =
      session.answered.filter((answer) => answer.rating === 'easy').length / session.answered.length
    if (sessionComplete) this.database.recordDeckUnitTestScore(session.deckId, unitScore, reviewedAt)

    const state = this.database.getReviewState(input.cardId)
    return {
      cardId: input.cardId,
      rating: input.rating,
      nextDueAt: state?.dueAt ?? null,
      state: state?.state ?? 'New',
      successRate: state?.successRate ?? 0,
      sessionComplete,
      unitScore,
      recommendation:
        sessionComplete && unitScore < session.unitTestThreshold
          ? 'Score is below target. Incorrect cards are ready in Review Due.'
          : null,
    }
  }

  private toFsrsCard(state: ImportedReviewState | null): FsrsCard {
    if (!state || state.state === 'New') return createEmptyCard(new Date())
    return {
      due: state.dueAt ? new Date(state.dueAt) : new Date(),
      stability: state.stability || 0.1,
      difficulty: state.difficulty || 5,
      elapsed_days: state.elapsedDays,
      scheduled_days: state.scheduledDays,
      learning_steps: state.learningSteps,
      reps: state.reps,
      lapses: state.lapses,
      state: stateToFsrs[state.state],
      last_review: state.lastReviewedAt ? new Date(state.lastReviewedAt) : undefined,
    }
  }
}
