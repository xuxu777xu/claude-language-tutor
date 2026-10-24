export type CheckMode = 'off' | 'on' | 'context'

export type Config = {
  learning: string
  native: string
  /** Model for side calls outside the context modes: an alias such as `haiku`, or a full id. */
  model: string
  check: CheckMode
  tutor: boolean
  auto: boolean
  context: boolean
}

export type GrammarItem = { wrong: string; right: string; reason: string }
export type TutorWord = { word: string; note: string }
export type TutorGrammar = { structure: string; note: string }
export type TutorResult = { sentence: string; words: TutorWord[]; grammar: TutorGrammar[] }

export type ReviewResult =
  | { mode: 'check'; items: GrammarItem[]; rephrase: string | null }
  | { mode: 'tutor'; tutor: TutorResult }
  | { mode: 'skip' }

export type Review =
  | { mode: 'check'; items: GrammarItem[]; rephrase: string | null }
  | { mode: 'tutor'; tutor: TutorResult; added: number }

export type TranslatedSegment =
  | { kind: 'pair'; src: string; dst: string }
  | { kind: 'code'; text: string }
  | { kind: 'codeRef'; lines: number }

export type Translation = { key: string; markdown: string }

/** ts-fsrs Card as JSON: dates are ISO strings. */
export type StoredFsrsCard = {
  due: string
  stability: number
  difficulty: number
  elapsed_days: number
  scheduled_days: number
  learning_steps: number
  reps: number
  lapses: number
  state: number
  last_review?: string
}

export type FlashcardEntry = {
  id: string
  word: string
  note: string
  source: 'tutor' | 'manual'
  createdAt: string
  /** When the card left the New state: drives the daily new-card budget. */
  introducedAt?: string
  fsrs: StoredFsrsCard
}

export type FlashcardSettings = {
  newPerDay: number
  sessionLimit: number
  requestRetention: number
}

export type DeckView =
  | { screen: 'overview' }
  | { screen: 'review'; queue: string[]; revealed: boolean }
  | { screen: 'library' }
  | { screen: 'card'; id: string }
  | { screen: 'settings' }

declare module 'claude-code' {
  interface PluginState {
    'language-tutor': {
      config: Config
      review: Review | null
      translations: Translation[]
      busy: string | null
      cards: FlashcardEntry[]
      deckSettings: FlashcardSettings
      deck: DeckView
    }
  }
}
