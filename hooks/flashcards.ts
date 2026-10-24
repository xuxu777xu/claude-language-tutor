import { createEmptyCard, fsrs, Rating, State, type Card, type Grade } from './vendor/ts-fsrs.mjs'
import type { FlashcardEntry, FlashcardSettings, StoredFsrsCard } from '../types'

export { Rating }
export type { Grade }

export const DEFAULT_DECK_SETTINGS: FlashcardSettings = {
  newPerDay: 20,
  sessionLimit: 20,
  requestRetention: 0.9
}

const numOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const clampNum = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export function clampDeckSettings(raw: unknown): FlashcardSettings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    newPerDay: Math.round(clampNum(numOr(r.newPerDay, DEFAULT_DECK_SETTINGS.newPerDay), 0, 500)),
    sessionLimit: Math.round(
      clampNum(numOr(r.sessionLimit, DEFAULT_DECK_SETTINGS.sessionLimit), 1, 200)
    ),
    requestRetention:
      Math.round(
        clampNum(numOr(r.requestRetention, DEFAULT_DECK_SETTINGS.requestRetention), 0.7, 0.97) * 100
      ) / 100
  }
}

function toStored(card: Card): StoredFsrsCard {
  const stored: StoredFsrsCard = {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state
  }
  if (card.last_review) stored.last_review = card.last_review.toISOString()
  return stored
}

function fromStored(stored: StoredFsrsCard): Card {
  return {
    ...stored,
    due: new Date(stored.due),
    state: stored.state as State,
    last_review: stored.last_review ? new Date(stored.last_review) : undefined
  }
}

function isEntry(v: unknown): v is FlashcardEntry {
  if (typeof v !== 'object' || v === null) return false
  const e = v as FlashcardEntry
  return (
    typeof e.id === 'string' &&
    typeof e.word === 'string' &&
    typeof e.note === 'string' &&
    typeof e.fsrs === 'object' &&
    e.fsrs !== null &&
    typeof e.fsrs.due === 'string'
  )
}

export function parseCards(raw: unknown): FlashcardEntry[] {
  return Array.isArray(raw) ? raw.filter(isEntry) : []
}

let idCounter = 0

function nextId(now: Date): string {
  return `${now.getTime().toString(36)}-${(idCounter++).toString(36)}`
}

/** Adds cards in place, deduplicating by word (case-insensitive); returns how many were added. */
export function addCards(
  cards: FlashcardEntry[],
  items: readonly { word: string; note: string }[],
  source: 'tutor' | 'manual',
  now: Date
): number {
  let added = 0
  for (const item of items) {
    const word = item.word.trim()
    const note = item.note.trim()
    if (!word || !note) continue
    if (cards.some((c) => c.word.trim().toLowerCase() === word.toLowerCase())) continue
    cards.push({
      id: nextId(now),
      word,
      note,
      source,
      createdAt: now.toISOString(),
      fsrs: toStored(createEmptyCard(now))
    })
    added++
  }
  return added
}

function isNew(c: FlashcardEntry): boolean {
  return c.fsrs.state === State.New
}

function isDue(c: FlashcardEntry, now: Date): boolean {
  return isNew(c) || new Date(c.fsrs.due) <= now
}

function newBudget(cards: FlashcardEntry[], settings: FlashcardSettings, now: Date): number {
  const today = now.toDateString()
  const introducedToday = cards.filter(
    (c) => c.introducedAt && new Date(c.introducedAt).toDateString() === today
  ).length
  return Math.max(0, settings.newPerDay - introducedToday)
}

/** Ids of the cards one review round deals: due cards in order, new ones capped by today's budget. */
export function dueQueue(cards: FlashcardEntry[], settings: FlashcardSettings, now: Date): string[] {
  const budget = newBudget(cards, settings, now)
  let newTaken = 0
  const queue: string[] = []
  for (const c of cards) {
    if (queue.length >= settings.sessionLimit) break
    if (!isDue(c, now)) continue
    if (isNew(c)) {
      if (newTaken >= budget) continue
      newTaken++
    }
    queue.push(c.id)
  }
  return queue
}

export type DeckStats = {
  total: number
  due: number
  newCards: number
  lastReview: string | null
  nextDue: string | null
}

export function deckStats(cards: FlashcardEntry[], settings: FlashcardSettings, now: Date): DeckStats {
  let last: string | null = null
  let next: string | null = null
  for (const c of cards) {
    if (c.fsrs.last_review && (!last || c.fsrs.last_review > last)) last = c.fsrs.last_review
    if (!isDue(c, now) && (!next || c.fsrs.due < next)) next = c.fsrs.due
  }
  const reviewDue = cards.filter((c) => !isNew(c) && isDue(c, now)).length
  const newCount = cards.filter(isNew).length
  return {
    total: cards.length,
    due: reviewDue + Math.min(newBudget(cards, settings, now), newCount),
    newCards: newCount,
    lastReview: last,
    nextDue: next
  }
}

/** Applies an FSRS rating in place. No minute-level learning steps: one rating moves to a day-level interval. */
export function rateCard(
  card: FlashcardEntry,
  rating: Grade,
  settings: FlashcardSettings,
  now: Date
): void {
  if (isNew(card) && !card.introducedAt) card.introducedAt = now.toISOString()
  const scheduler = fsrs({ enable_short_term: false, request_retention: settings.requestRetention })
  card.fsrs = toStored(scheduler.next(fromStored(card.fsrs), now, rating).card)
}

/** Again and Hard keep the card in this round for another pass; Good and Easy graduate it. */
export function needsRetry(rating: Grade): boolean {
  return rating === Rating.Again || rating === Rating.Hard
}

export const STATE_LABELS = ['new', 'learning', 'review', 'relearning'] as const

/** Library order: soonest due first, so new cards lead. */
export function libraryOrder(cards: readonly FlashcardEntry[]): FlashcardEntry[] {
  return [...cards].sort((a, b) => a.fsrs.due.localeCompare(b.fsrs.due))
}
