import { describe, expect, test } from 'claude-code/testing'

import {
  alignTranslations,
  isInNativeScript,
  buildReviewPrompt,
  cardMarkdown,
  DEFAULT_CONFIG,
  normalizeConfig,
  parseReviewResult,
  replyKey,
  segmentMarkdown,
  shouldSkipCheck
} from '../hooks/core'
import { addCards, deckStats, dueQueue, needsRetry, Rating, rateCard } from '../hooks/flashcards'
import type { FlashcardEntry } from '../types'

describe('shouldSkipCheck', () => {
  const skipped: [string, string][] = [
    ['slash command', '/model anthropic claude something here'],
    ['bang command', '!ls -la some directory here'],
    ['short reply', 'ok go ahead'],
    ['code fence', 'please fix this\n```ts\nconst x = 1\n```\nwhat is wrong with it exactly'],
    ['mostly code', 'const x = foo(bar); y->z; a[i] = {b: 1};'],
    ['short CJK', '你好吗'],
    ['symbols only', '=== !== >>> <<< &&& ||| ??? *** !!!']
  ]
  for (const [name, text] of skipped) {
    test(`skips ${name}`, () => {
      expect(shouldSkipCheck(text)).toBe(true)
    })
  }

  const checked: [string, string][] = [
    ['substantial CJK', '请帮我修复这个程序里的错误谢谢'],
    ['one path among prose', 'look at src/core/extensions/types.ts please'],
    ['sentence with typos', 'I want create a extension to leading English'],
    ['plain 4 words', 'please explain this error']
  ]
  for (const [name, text] of checked) {
    test(`checks ${name}`, () => {
      expect(shouldSkipCheck(text)).toBe(false)
    })
  }
})

describe('review prompt and parsing', () => {
  test('tutor off removes the tutor branch', () => {
    const prompt = buildReviewPrompt('我想重构这个函数', { ...DEFAULT_CONFIG, tutor: false })
    expect(prompt.includes('"mode": "tutor"')).toBe(false)
  })

  test('context preface only in contextual mode', () => {
    expect(buildReviewPrompt('fix the bug please now', DEFAULT_CONFIG, true).startsWith('The conversation above')).toBe(true)
    expect(buildReviewPrompt('fix the bug please now', DEFAULT_CONFIG).startsWith('You are')).toBe(true)
  })

  test('parses a check with items and rephrase', () => {
    const r = parseReviewResult(
      '{"mode":"check","items":[{"wrong":"anwser","right":"answer","reason":"拼写"}],"rephrase":"When the agent answers me"}'
    )
    expect(r).toEqual({
      mode: 'check',
      items: [{ wrong: 'anwser', right: 'answer', reason: '拼写' }],
      rephrase: 'When the agent answers me'
    })
  })

  test('parses a tutor reply and caps words at 5', () => {
    const words = Array.from({ length: 7 }, (_, i) => ({ word: `w${i}`, note: 'n' }))
    const r = parseReviewResult(JSON.stringify({ mode: 'tutor', sentence: 'S', words, grammar: [] }))
    expect(r?.mode).toBe('tutor')
    expect(r?.mode === 'tutor' && r.tutor.words.length).toBe(5)
  })

  test('an empty tutor reply is a skip', () => {
    expect(parseReviewResult('{"mode":"tutor","sentence":"","words":[],"grammar":[]}')).toEqual({ mode: 'skip' })
  })

  test('unrelated JSON without mode is rejected', () => {
    expect(parseReviewResult('{"items":[{"name":"x"}]}')).toBe(undefined)
  })

  test('garbage is rejected', () => {
    expect(parseReviewResult('I will now edit the file.')).toBe(undefined)
  })
})

describe('bilingual card', () => {
  const source = 'First paragraph.\n\n```ts\nconst a = 1\n```\n\nSecond paragraph.'

  test('segments prose and code', () => {
    const kinds = segmentMarkdown(source).map((s) => s.kind)
    expect(kinds).toEqual(['prose', 'code', 'prose'])
  })

  test('aligns translations and renders blockquotes', () => {
    const aligned = alignTranslations(segmentMarkdown(source), '{"t":["第一段。","第二段。"]}', () => false)
    if ('error' in aligned) throw new Error(aligned.error)
    expect(cardMarkdown(aligned)).toBe(
      'First paragraph.\n\n> 第一段。\n\n```ts\nconst a = 1\n```\n\nSecond paragraph.\n\n> 第二段。'
    )
  })

  test('paragraphs already in the native language get no translation', () => {
    const mixed = '这一段已经是中文。\n\nThis one is English.\n\n再来一段中文。'
    const aligned = alignTranslations(segmentMarkdown(mixed), '{"t":["","这一段是英文。","再来一段中文。"]}', () => false)
    if ('error' in aligned) throw new Error(aligned.error)
    expect(cardMarkdown(aligned)).toBe('这一段已经是中文。\n\nThis one is English.\n\n> 这一段是英文。\n\n再来一段中文。')
  })

  test('long code becomes a placeholder', () => {
    const long = 'Intro.\n\n```\n1\n2\n3\n4\n5\n6\n```'
    const aligned = alignTranslations(segmentMarkdown(long), '{"t":["介绍。"]}', () => false)
    if ('error' in aligned) throw new Error(aligned.error)
    expect(cardMarkdown(aligned).endsWith('*[code block ↑ 6 lines]*')).toBe(true)
  })

  test('a count mismatch is an error', () => {
    expect(alignTranslations(segmentMarkdown(source), '{"t":["only one"]}', () => false)).toEqual({
      error: 'expected 2 segments, got 1'
    })
  })

  test('locally skipped paragraphs are not expected in the reply', () => {
    const mixed = '这一段已经是中文。\n\nThis one is English.'
    const aligned = alignTranslations(segmentMarkdown(mixed), '{"t":["这一段是英文。"]}', (t) =>
      isInNativeScript(t, 'zh-CN')
    )
    if ('error' in aligned) throw new Error(aligned.error)
    expect(cardMarkdown(aligned)).toBe('这一段已经是中文。\n\nThis one is English.\n\n> 这一段是英文。')
  })

  test('replyKey ignores whitespace differences', () => {
    expect(replyKey('  a\n\nb  ')).toBe(replyKey('a b'))
  })
})

describe('isInNativeScript', () => {
  const cases: [string, string, string, boolean][] = [
    ['Chinese with English terms', '它判成了 check 模式，没有错误，也没有更地道的改写建议。', 'zh-CN', true],
    ['Chinese around inline code', '运行 `/translate auto=true` 之后再看 `tutor.log`。', 'zh-CN', true],
    ['English', 'The writing check runs in the background after you submit a prompt.', 'zh-CN', false],
    ['English with a Chinese word', 'The label 测试 shows up above the prompt box.', 'zh-CN', false],
    ['Japanese for a Chinese native', 'このテストは失敗しました。', 'zh-CN', false],
    ['Japanese', 'このテストは失敗しました。', 'ja', true],
    ['Chinese for a Japanese native', '这个测试失败了。', 'ja', false],
    ['Korean', '이 테스트는 실패했습니다.', 'ko', true],
    ['a native without a script rule', 'Le test a échoué.', 'fr', false]
  ]
  for (const [name, text, native, expected] of cases) {
    test(`${name} (${native})`, () => {
      expect(isInNativeScript(text, native)).toBe(expected)
    })
  }
})

describe('config', () => {
  test('defaults fill missing fields', () => {
    expect(normalizeConfig({ native: 'ja' })).toEqual({ ...DEFAULT_CONFIG, native: 'ja' })
  })

  test('the default model is haiku', () => {
    expect(normalizeConfig({}).model).toBe('haiku')
    expect(normalizeConfig({ model: '' }).model).toBe('haiku')
    expect(normalizeConfig({ model: 'claude-sonnet-5-5' }).model).toBe('claude-sonnet-5-5')
  })

  test('invalid check mode falls to the default', () => {
    expect(normalizeConfig({ check: 'loud' }).check).toBe('on')
  })
})

describe('flashcards', () => {
  const now = new Date('2026-10-24T10:00:00Z')
  const settings = { newPerDay: 2, sessionLimit: 20, requestRetention: 0.9 }

  test('adds cards deduplicated by word', () => {
    const cards: FlashcardEntry[] = []
    const added = addCards(
      cards,
      [
        { word: 'refactor', note: '重构' },
        { word: 'Refactor', note: '重复' },
        { word: '', note: 'x' }
      ],
      'tutor',
      now
    )
    expect(added).toBe(1)
    expect(cards.length).toBe(1)
  })

  test('new cards are capped by the daily budget', () => {
    const cards: FlashcardEntry[] = []
    addCards(cards, ['a', 'b', 'c'].map((word) => ({ word, note: 'n' })), 'tutor', now)
    expect(dueQueue(cards, settings, now).length).toBe(2)
    expect(deckStats(cards, settings, now).due).toBe(2)
  })

  test('Good schedules the card for a later day and spends the budget', () => {
    const cards: FlashcardEntry[] = []
    addCards(cards, [{ word: 'cache', note: '缓存' }], 'tutor', now)
    const card = cards[0]!
    rateCard(card, Rating.Good, settings, now)
    expect(card.fsrs.state).toBe(2)
    expect(new Date(card.fsrs.due).getTime() > now.getTime() + 12 * 3600_000).toBe(true)
    expect(card.introducedAt).toBe(now.toISOString())
    expect(dueQueue(cards, settings, now)).toEqual([])
  })

  test('Again and Hard stay in the round', () => {
    expect(needsRetry(Rating.Again)).toBe(true)
    expect(needsRetry(Rating.Hard)).toBe(true)
    expect(needsRetry(Rating.Good)).toBe(false)
  })
})
