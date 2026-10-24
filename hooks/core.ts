import type {
  CheckMode,
  Config,
  GrammarItem,
  ReviewResult,
  TranslatedSegment,
  TutorGrammar,
  TutorWord
} from '../types'

export const DEFAULT_CONFIG: Config = {
  learning: 'en',
  native: 'zh-CN',
  model: 'haiku',
  check: 'on',
  tutor: true,
  auto: false,
  context: false
}

export function normalizeConfig(raw: unknown): Config {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const check: CheckMode =
    r.check === 'off' || r.check === 'on' || r.check === 'context' ? r.check : DEFAULT_CONFIG.check
  return {
    learning: typeof r.learning === 'string' && r.learning ? r.learning : DEFAULT_CONFIG.learning,
    native: typeof r.native === 'string' && r.native ? r.native : DEFAULT_CONFIG.native,
    model: typeof r.model === 'string' && r.model ? r.model : DEFAULT_CONFIG.model,
    check,
    tutor: r.tutor !== false,
    auto: r.auto === true,
    context: r.context === true
  }
}

export const MAX_CHECK_CHARS = 1500
export const MAX_TRANSLATE_CHARS = 12000
/** Code blocks longer than this many content lines become a placeholder in the bilingual card. */
export const SHORT_CODE_LINES = 5
/** Final replies shorter than this many words are not auto-translated. */
export const MIN_AUTO_WORDS = 15

export function extractJson<T>(raw: string): T | undefined {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as T
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Slash/bang commands, trivially short prompts, code fences and mostly-code
 * text are not reviewed. CJK characters count one unit each, so a native
 * sentence without spaces still reaches the tutor.
 */
export function shouldSkipCheck(text: string): boolean {
  if (text.startsWith('/') || text.startsWith('!')) return true
  if (text.includes('```')) return true

  const chars = text.replace(/\s+/g, '')
  if (chars.length === 0) return true

  const words = text.split(/\s+/).filter(Boolean)
  const cjk = text.match(/[一-鿿぀-ヿ가-힯]/gu)?.length ?? 0
  if (Math.max(words.length, cjk) < 4) return true

  const letters = chars.match(/\p{L}/gu)?.length ?? 0
  if (letters / chars.length < 0.5) return true

  const codey = words.filter((w) => /[{}()[\];=<>\\`$]|::|->|\.[a-z]{1,4}$|\//.test(w)).length
  return words.length > 0 && codey / words.length > 0.3
}

export const CHECK_CONTEXT_PREFACE =
  'The conversation above is the session this message was typed in — treat terms it establishes (project names, identifiers, coined words) as correct vocabulary, not errors, and prefer them when teaching how to express the message.'

export function buildReviewPrompt(text: string, cfg: Config, contextual = false): string {
  const tutorBranch = cfg.tutor
    ? [
        `If the message is NOT primarily written in ${cfg.learning} — e.g. it is in ${cfg.native} or another language (mode "tutor") — the student could not express it in ${cfg.learning}; teach them how:`,
        `  {"mode": "tutor", "sentence": "...", "words": [{"word": "...", "note": "..."}], "grammar": [{"structure": "...", "note": "..."}]}`,
        `  - "sentence": a natural, idiomatic ${cfg.learning} rendering of the student's WHOLE thought (not a word-by-word gloss).`,
        `  - "words": the key vocabulary worth learning (at most 5). "word" is the ${cfg.learning} word/phrase exactly as used in "sentence". "note" is a short explanation in ${cfg.native}: meaning, usage, register, and why this word over an obvious synonym.`,
        `  - "grammar": the grammatical structures carrying the sentence (at most 3). "structure" names the structure (e.g. tense, mood, particle, clause shape, agreement). "note" explains in ${cfg.native} what it is and why it is used here.`,
        `  - If the message is too short, code, or has no clear meaning to teach, return {"mode": "skip"} instead.`,
        ``,
        `If neither mode fits (too short, code, unclear): {"mode": "skip"}`
      ]
    : [
        `If the message is NOT primarily written in ${cfg.learning}, or neither rule applies (too short, code, unclear): {"mode": "skip"}`
      ]
  const tutorRule = cfg.tutor
    ? [`- A message already correct in ${cfg.learning} is mode "check" with empty items, NOT "tutor".`]
    : []
  return [
    ...(contextual ? [CHECK_CONTEXT_PREFACE] : []),
    `You are a ${cfg.learning} language tutor. The student's native language is ${cfg.native}.`,
    `The student typed the following message to an AI coding assistant. Decide which mode applies, then respond accordingly.`,
    ``,
    `Respond with ONLY a JSON object, no markdown fences:`,
    ``,
    `If the message IS primarily written in ${cfg.learning} (mode "check") — review it:`,
    `  {"mode": "check", "items": [{"wrong": "...", "right": "...", "reason": "..."}], "rephrase": "..." or null}`,
    `  - "items": genuine spelling/grammar errors only, at most 5. "wrong"/"right" are short exact fragments. "reason" is a very short explanation written in ${cfg.native}.`,
    `  - "rephrase": only if the message is understandable but sounds noticeably non-native, give ONE more natural way to phrase it in ${cfg.learning}; otherwise null.`,
    `  - A correct message: {"mode": "check", "items": [], "rephrase": null}.`,
    ``,
    ...tutorBranch,
    ``,
    `Rules:`,
    `- Ignore code, file paths, identifiers, product names, and technical jargon — do not try to fix or translate them.`,
    ...tutorRule,
    `- Never invent errors, never invent vocabulary the student did not express.`,
    ``,
    `Message:`,
    `<<<`,
    text.slice(0, MAX_CHECK_CHARS),
    `>>>`
  ].join('\n')
}

export function parseReviewResult(raw: string): ReviewResult | undefined {
  const obj = extractJson<{
    mode?: string
    skip?: boolean
    items?: GrammarItem[]
    rephrase?: string | null
    sentence?: string
    words?: TutorWord[]
    grammar?: TutorGrammar[]
  }>(raw)
  if (!obj) return undefined

  if (obj.mode === 'tutor') {
    const sentence = typeof obj.sentence === 'string' ? obj.sentence.trim() : ''
    const words = Array.isArray(obj.words)
      ? obj.words.filter((w) => w && typeof w.word === 'string' && typeof w.note === 'string')
      : []
    const grammar = Array.isArray(obj.grammar)
      ? obj.grammar.filter((g) => g && typeof g.structure === 'string' && typeof g.note === 'string')
      : []
    if (!sentence && words.length === 0 && grammar.length === 0) return { mode: 'skip' }
    return {
      mode: 'tutor',
      tutor: { sentence, words: words.slice(0, 5), grammar: grammar.slice(0, 3) }
    }
  }

  if (obj.mode === 'skip' || obj.skip === true) return { mode: 'skip' }

  const items = Array.isArray(obj.items)
    ? obj.items.filter(
        (i) =>
          i &&
          typeof i.wrong === 'string' &&
          i.wrong.trim().length > 0 &&
          typeof i.right === 'string' &&
          i.right.trim().length > 0
      )
    : []
  const rephrase =
    typeof obj.rephrase === 'string' && obj.rephrase.trim().length > 0 ? obj.rephrase.trim() : null

  // Without an explicit mode, only genuine review evidence counts: unrelated
  // JSON that merely holds an `items` array (a forked reply where the agent
  // prompt won) is rejected.
  if (obj.mode !== 'check') {
    const itemsEvidence = Array.isArray(obj.items) && (obj.items.length === 0 || items.length > 0)
    const rephraseEvidence = typeof obj.rephrase === 'string' || obj.rephrase === null
    if (!itemsEvidence && !rephraseEvidence) return undefined
  }

  return { mode: 'check', items: items.slice(0, 5), rephrase }
}

export type Segment =
  | { kind: 'prose'; text: string }
  | { kind: 'code'; text: string; lines: number }

/** Split markdown into prose paragraphs and fenced code blocks. */
export function segmentMarkdown(src: string): Segment[] {
  const segments: Segment[] = []
  let prose: string[] = []
  let code: string[] = []
  let inCode = false

  const flushProse = () => {
    const paragraphs = prose
      .join('\n')
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    for (const p of paragraphs) segments.push({ kind: 'prose', text: p })
    prose = []
  }

  for (const line of src.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (inCode) {
        code.push(line)
        segments.push({ kind: 'code', text: code.join('\n'), lines: code.length - 2 })
        code = []
        inCode = false
      } else {
        flushProse()
        code.push(line)
        inCode = true
      }
    } else if (inCode) {
      code.push(line)
    } else {
      prose.push(line)
    }
  }
  if (inCode) {
    segments.push({ kind: 'code', text: code.join('\n'), lines: Math.max(0, code.length - 1) })
  }
  flushProse()
  return segments
}

export const CONTEXT_PREFACE =
  'The conversation above is the session this response came from — use it to resolve terminology, referents, and project-specific names.'

export function buildSegmentPrompt(proseTexts: string[], cfg: Config, contextual = false): string {
  const numbered = proseTexts.map((t, i) => `[${i}]\n${t}`).join('\n\n')
  return [
    ...(contextual ? [CONTEXT_PREFACE] : []),
    `Translate each numbered segment of an AI coding assistant's response into ${cfg.native}.`,
    `Keep inline code, file paths, commands, and technical identifiers untranslated. Preserve markdown formatting within each segment.`,
    `If a segment is already written in ${cfg.native}, its item is an empty string.`,
    ``,
    `Respond with ONLY this JSON, no markdown fences:`,
    `{"t": ["...", "..."]}`,
    `"t" must contain exactly ${proseTexts.length} strings; item i is the translation of segment [i].`,
    ``,
    `Segments:`,
    numbered
  ].join('\n')
}

/** Pairs each prose segment with its translation, or says why the reply does not align. */
const HAN = /\p{Script=Han}/gu
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu
const HANGUL = /\p{Script=Hangul}/gu
const LATIN_WORD = /\p{Script=Latin}+/gu

/**
 * Whether a paragraph is already in a Chinese, Japanese or Korean native
 * language, judged by script with no model call: native characters at least
 * as many as Latin words, inline code ignored. Always false for other natives.
 */
export function isInNativeScript(text: string, native: string): boolean {
  const lang = native.split('-')[0]?.toLowerCase()
  const plain = text.replace(/`[^`]*`/g, ' ')
  const count = (pattern: RegExp) => plain.match(pattern)?.length ?? 0
  const kana = count(KANA)
  const nativeChars =
    lang === 'zh'
      ? kana > 0
        ? 0
        : count(HAN)
      : lang === 'ja'
        ? kana > 0
          ? kana + count(HAN)
          : 0
        : lang === 'ko'
          ? count(HANGUL)
          : 0
  return nativeChars > 0 && nativeChars >= count(LATIN_WORD)
}

/** Paragraphs `isSkipped` holds back were not sent: they pair with an empty translation. */
export function alignTranslations(
  segments: Segment[],
  raw: string,
  isSkipped: (text: string) => boolean
): TranslatedSegment[] | { error: string } {
  const proseCount = segments.filter((s) => s.kind === 'prose' && !isSkipped(s.text)).length
  const translations = extractJson<{ t?: unknown }>(raw)?.t
  if (!Array.isArray(translations) || !translations.every((t) => typeof t === 'string')) {
    return { error: 'reply is not {"t": [string...]}' }
  }
  if (translations.length !== proseCount) {
    return { error: `expected ${proseCount} segments, got ${translations.length}` }
  }
  let proseIndex = 0
  return segments.map((s): TranslatedSegment => {
    if (s.kind === 'prose') {
      const dst = isSkipped(s.text) ? '' : (translations[proseIndex++] as string).trim()
      return { kind: 'pair', src: s.text, dst }
    }
    return s.lines <= SHORT_CODE_LINES
      ? { kind: 'code', text: s.text }
      : { kind: 'codeRef', lines: s.lines }
  })
}

/** False for a paragraph already in the native language: the model left it empty or echoed it. */
export function needsTranslation(segment: { src: string; dst: string }): boolean {
  return segment.dst.length > 0 && segment.dst !== segment.src
}

/** The bilingual card: each original paragraph followed by its translation as a blockquote. */
export function cardMarkdown(segments: TranslatedSegment[]): string {
  return segments
    .map((s) => {
      switch (s.kind) {
        case 'pair':
          return needsTranslation(s) ? `${s.src}\n\n> ${s.dst.replace(/\n/g, '\n> ')}` : s.src
        case 'code':
          return s.text
        case 'codeRef':
          return `*[code block ↑ ${s.lines} lines]*`
      }
    })
    .join('\n\n')
}

/** How a reply's text is matched to the transcript block that draws it. */
export function replyKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}
