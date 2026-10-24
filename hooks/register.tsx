import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteResult, ModelForkResult, Register } from 'claude-code'

import type { Config, DeckView, FlashcardEntry, Review, Translation } from '../types'
import {
  alignTranslations,
  buildReviewPrompt,
  buildSegmentPrompt,
  cardMarkdown,
  DEFAULT_CONFIG,
  isInNativeScript,
  MAX_TRANSLATE_CHARS,
  MIN_AUTO_WORDS,
  needsTranslation,
  normalizeConfig,
  parseReviewResult,
  replyKey,
  segmentMarkdown,
  shouldSkipCheck,
  wordCount
} from './core'
import {
  addCards,
  clampDeckSettings,
  DEFAULT_DECK_SETTINGS,
  deckStats,
  dueQueue,
  libraryOrder,
  needsRetry,
  Rating,
  rateCard,
  STATE_LABELS,
  type Grade
} from './flashcards'
import {
  appendLog,
  createQueue,
  loadCards,
  loadConfig,
  loadDeckSettings,
  resolvePaths,
  saveCards,
  saveConfig,
  saveDeckSettings,
  type Paths
} from './storage'

const configAtom = atom({ plugin: 'language-tutor', key: 'config' } as const, DEFAULT_CONFIG)
const reviewAtom = atom({ plugin: 'language-tutor', key: 'review' } as const, null)
const translationsAtom = atom({ plugin: 'language-tutor', key: 'translations' } as const, [])
const busyAtom = atom({ plugin: 'language-tutor', key: 'busy' } as const, null)
const cardsAtom = atom({ plugin: 'language-tutor', key: 'cards' } as const, [])
const deckSettingsAtom = atom(
  { plugin: 'language-tutor', key: 'deckSettings' } as const,
  DEFAULT_DECK_SETTINGS
)
const deckAtom = atom({ plugin: 'language-tutor', key: 'deck' } as const, { screen: 'overview' })

const DECK_PANE = 'flashcards'
const LANG_PANE = 'lang'
const KEPT_TRANSLATIONS = 50
const REVIEW_TIMEOUT_MS = 60_000
const TRANSLATE_TIMEOUT_MS = 180_000

type Reply = { text: string } | { error: string }

function failure(r: Exclude<ModelCompleteResult | ModelForkResult, { isAnswered: true }>): string {
  return r.reason === 'api-error' ? `api-error status=${r.status} error=${r.error}` : r.reason
}

function formatDate(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '—'
}

function onOff(value: boolean): string {
  return value ? 'on' : 'off'
}

let paths: Paths | undefined
let isInteractive = false
let reviewSeq = 0
let reviewAbort: AbortController | undefined
const cardQueue = createQueue()
const configQueue = createQueue()

function log($: EngineInterface, step: string, detail: string): Promise<void> {
  return appendLog($, files(), step, detail)
}

function files(): Paths {
  if (!paths) throw new Error('language-tutor: session.start has not run yet')
  return paths
}

async function refreshStatus($: EngineInterface) {
  const busy = await read($, busyAtom)
  const cfg = await read($, configAtom)
  $.ui.status(busy ?? (cfg.auto ? '🌐 auto' : undefined))
}

function setConfig($: EngineInterface, patch: Partial<Config>): Promise<Config> {
  return configQueue(async () => {
    const current = await loadConfig($, files())
    const next = normalizeConfig({ ...current, ...patch })
    await saveConfig($, files(), next)
    await update($, configAtom, () => next)
    await refreshStatus($)
    void log($, 'config.set', JSON.stringify(next))
    return next
  })
}

/**
 * One side call. `contextual` forks the session transcript; with no
 * transcript yet there is no context to give, so it asks without one.
 */
async function ask(
  $: EngineInterface,
  cfg: Config,
  prompt: (contextual: boolean) => string,
  contextual: boolean,
  limits: { maxTokens: number; timeoutMs: number; signal?: AbortSignal }
): Promise<Reply> {
  if (contextual) {
    const forked = await $.model.fork({ prompt: prompt(true) })
    if (forked.isAnswered) return { text: forked.text }
    if (forked.reason !== 'nothing-to-fork') return { error: `fork: ${failure(forked)}` }
  }
  const model = cfg.model
  const done = await $.model.complete(
    { model, prompt: prompt(false), maxTokens: limits.maxTokens, timeoutMs: limits.timeoutMs },
    { signal: limits.signal }
  )
  return done.isAnswered ? { text: done.text } : { error: `${model}: ${failure(done)}` }
}

function mutateCards<T>($: EngineInterface, fn: (cards: FlashcardEntry[]) => T): Promise<T> {
  return cardQueue(async () => {
    const cards = await loadCards($, files())
    const result = fn(cards)
    await saveCards($, files(), cards)
    await update($, cardsAtom, () => cards)
    return result
  })
}

async function runReview($: EngineInterface, text: string, cfg: Config, seq: number) {
  reviewAbort?.abort()
  const abort = new AbortController()
  reviewAbort = abort
  const startedAt = Date.now()
  void log($, 'review.start', `seq=${seq} check=${cfg.check} chars=${text.length}`)
  try {
    const reply = await ask(
      $,
      cfg,
      (contextual) => buildReviewPrompt(text, cfg, contextual),
      cfg.check === 'context',
      { maxTokens: 2048, timeoutMs: REVIEW_TIMEOUT_MS, signal: abort.signal }
    )
    if (seq !== reviewSeq) {
      void log($, 'review.stale', `seq=${seq} superseded by ${reviewSeq}`)
      return
    }
    if ('error' in reply) {
      void log($, 'review.error', `seq=${seq} ${reply.error}`)
      return
    }
    const result = parseReviewResult(reply.text)
    if (!result) {
      void log($, 'review.parse', `seq=${seq} unparseable reply: ${reply.text.slice(0, 500)}`)
      return
    }
    void log($, 'review.done', `seq=${seq} mode=${result.mode} ms=${Date.now() - startedAt}`)

    let shown: Review | null = null
    if (result.mode === 'tutor' && cfg.tutor) {
      const words = result.tutor.words
      const added =
        words.length > 0 ? await mutateCards($, (cards) => addCards(cards, words, 'tutor', new Date())) : 0
      if (added > 0) void log($, 'cards.capture', `added=${added} of ${words.length}`)
      shown = { mode: 'tutor', tutor: result.tutor, added }
    } else if (result.mode === 'check' && (result.items.length > 0 || result.rephrase)) {
      shown = { mode: 'check', items: result.items, rephrase: result.rephrase }
    }
    await update($, reviewAtom, () => shown)
  } catch (err) {
    void log($, 'review.throw', `seq=${seq} ${String(err)}`)
  }
}

async function translate($: EngineInterface, source: string, isAuto: boolean) {
  const cfg = await read($, configAtom)
  const key = replyKey(source)
  const clipped = source.slice(0, MAX_TRANSLATE_CHARS)
  const segments = segmentMarkdown(clipped)
  const isNative = (text: string) => isInNativeScript(text, cfg.native)
  const allProse = segments.flatMap((s) => (s.kind === 'prose' ? [s.text] : []))
  const prose = allProse.filter((text) => !isNative(text))
  const tell = (message: string) => {
    if (!isAuto) $.ui.toast(message)
  }
  if (allProse.length === 0) {
    tell('Nothing to translate: the reply has no prose.')
    return
  }
  if (prose.length === 0) {
    void log($, 'translate.skip', `local: all ${allProse.length} paragraphs already in ${cfg.native}`)
    tell(`Nothing to translate: the reply is already in ${cfg.native}.`)
    return
  }

  await update($, busyAtom, () => '🌐 translating…')
  await refreshStatus($)
  const startedAt = Date.now()
  void log($, 'translate.start', `auto=${isAuto} context=${cfg.context} segments=${prose.length} skipped=${allProse.length - prose.length} chars=${source.length}`)
  try {
    const reply = await ask(
      $,
      cfg,
      (contextual) => buildSegmentPrompt(prose, cfg, contextual),
      cfg.context,
      { maxTokens: 16000, timeoutMs: TRANSLATE_TIMEOUT_MS }
    )
    if ('error' in reply) {
      void log($, 'translate.error', reply.error)
      tell(`Translation failed: ${reply.error}`)
      return
    }
    const aligned = alignTranslations(segments, reply.text, isNative)
    if ('error' in aligned) {
      void log($, 'translate.align', `${aligned.error}; reply: ${reply.text.slice(0, 500)}`)
      tell(`Translation failed: ${aligned.error}`)
      return
    }
    if (!aligned.some((s) => s.kind === 'pair' && needsTranslation(s))) {
      void log($, 'translate.skip', `model: every segment is already in ${cfg.native}`)
      tell(`Nothing to translate: the reply is already in ${cfg.native}.`)
      return
    }
    const rest = source.slice(MAX_TRANSLATE_CHARS)
    const markdown = cardMarkdown(aligned) + (rest ? `\n\n${rest}` : '')
    const entry: Translation = { key, markdown }
    await update($, translationsAtom, (list) =>
      [...list.filter((t) => t.key !== key), entry].slice(-KEPT_TRANSLATIONS)
    )
    void log($, 'translate.done', `ms=${Date.now() - startedAt}`)
  } catch (err) {
    void log($, 'translate.throw', String(err))
    tell(`Translation failed: ${String(err)}`)
  } finally {
    await update($, busyAtom, () => null)
    await refreshStatus($)
  }
}

async function openDeck($: EngineInterface) {
  const cards = await cardQueue(() => loadCards($, files()))
  const settings = await loadDeckSettings($, files())
  await update($, cardsAtom, () => cards)
  await update($, deckSettingsAtom, () => settings)
  await update($, deckAtom, (): DeckView => ({ screen: 'overview' }))
  const opened = await $.ui.open({ id: DECK_PANE, title: 'Flashcards', focus: true, closeOnEscape: true })
  void log($, 'deck.open', `cards=${cards.length} placed=${opened.isPlaced}${opened.isPlaced ? '' : ` reason=${opened.reason}`}`)
}

async function startRound($: EngineInterface) {
  const cards = await read($, cardsAtom)
  const settings = await read($, deckSettingsAtom)
  const queue = dueQueue(cards, settings, new Date())
  if (queue.length === 0) {
    $.ui.toast('No cards are due.')
    return
  }
  void log($, 'deck.round', `queue=${queue.length}`)
  await update($, deckAtom, (): DeckView => ({ screen: 'review', queue, revealed: false }))
}

async function rate($: EngineInterface, id: string, rating: Grade) {
  const view = await read($, deckAtom)
  if (view.screen !== 'review' || view.queue[0] !== id) return
  const settings = await read($, deckSettingsAtom)
  const found = await mutateCards($, (cards) => {
    const card = cards.find((c) => c.id === id)
    if (card) rateCard(card, rating, settings, new Date())
    return card !== undefined
  })
  if (!found) void log($, 'deck.rate', `card ${id} is gone from disk`)
  const queue = view.queue.slice(1)
  if (found && needsRetry(rating)) queue.push(id)
  void log($, 'deck.rate', `id=${id} rating=${rating} left=${queue.length}`)
  if (queue.length === 0) {
    $.ui.toast('Round complete.')
    await update($, deckAtom, (): DeckView => ({ screen: 'overview' }))
    return
  }
  await update($, deckAtom, (): DeckView => ({ screen: 'review', queue, revealed: false }))
}

async function editCard($: EngineInterface, id: string, field: 'word' | 'note', value: string) {
  const text = value.trim()
  if (!text) {
    $.ui.toast(`The ${field} cannot be empty.`)
    return
  }
  await mutateCards($, (cards) => {
    const card = cards.find((c) => c.id === id)
    if (card) card[field] = text
  })
  void log($, 'deck.edit', `id=${id} field=${field}`)
}

async function deleteCard($: EngineInterface, id: string) {
  await mutateCards($, (cards) => {
    const at = cards.findIndex((c) => c.id === id)
    if (at >= 0) cards.splice(at, 1)
  })
  void log($, 'deck.delete', `id=${id}`)
  await update($, deckAtom, (): DeckView => ({ screen: 'library' }))
}

async function setDeckSettings($: EngineInterface, patch: Record<string, number>) {
  const next = clampDeckSettings({ ...(await read($, deckSettingsAtom)), ...patch })
  await saveDeckSettings($, files(), next)
  await update($, deckSettingsAtom, () => next)
  void log($, 'deck.settings', JSON.stringify(next))
}

async function applyLangArgs($: EngineInterface, args: string): Promise<string> {
  const [head = '', ...rest] = args.trim().split(/\s+/)
  const value = rest.join(' ')
  const toggle = (v: string) => (v === 'on' ? true : v === 'off' ? false : undefined)
  const usage =
    'Usage: /lang [on|off] | check off|on|context | tutor on|off | auto on|off | context on|off | native <code> | learning <code> | model <model>|default'
  switch (head) {
    case 'on':
    case 'off':
      await setConfig($, { check: head })
      return `Writing check ${head}`
    case 'check':
      if (value !== 'off' && value !== 'on' && value !== 'context') return usage
      await setConfig($, { check: value })
      return `Writing check ${value}`
    case 'tutor':
    case 'auto':
    case 'context': {
      const flag = toggle(value)
      if (flag === undefined) return usage
      await setConfig($, { [head]: flag })
      return `${head} ${value}`
    }
    case 'native':
    case 'learning':
      if (!value) return usage
      await setConfig($, { [head]: value })
      return `${head} language: ${value}`
    case 'model':
      if (!value) return usage
      {
        const model = value === 'default' ? DEFAULT_CONFIG.model : value
        await setConfig($, { model })
        return `Model: ${model}`
      }
    default:
      return usage
  }
}

export const register: Register = (on) => {

  on('session.start', async ($, e, next) => {
    paths = await resolvePaths($)
    isInteractive = e.isInteractive
    try {
      const cfg = await loadConfig($, paths)
      const cards = await loadCards($, paths)
      const deckSettings = await loadDeckSettings($, paths)
      await update($, configAtom, () => cfg)
      await update($, cardsAtom, () => cards)
      await update($, deckSettingsAtom, () => deckSettings)
      const stale = await read($, busyAtom)
      if (stale !== null) {
        await update($, busyAtom, () => null)
        void log($, 'session.start.busy', `cleared "${stale}" left by work the reload cut off`)
      }
      void log($, 'session.start', `interactive=${isInteractive} cards=${cards.length} config=${JSON.stringify(cfg)}`)
    } catch (err) {
      void log($, 'session.start.load', `${paths.dir}: ${String(err)}`)
      throw err
    }
    await $.command.register({
      name: 'translate',
      description: 'Show the last reply as a bilingual card (run again to show the original)'
    })
    await $.command.register({ name: 'flashcards', description: 'Review the words the Writing tutor taught you' })
    await $.command.register({
      name: 'lang',
      description: 'Language tutor settings',
      argumentHint: '[check|tutor|auto|context|native|learning|model] [value]'
    })
    await refreshStatus($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!isInteractive || e.command || e.isMeta || e.origin.kind !== 'composer') return next(e)
    const cfg = await read($, configAtom)
    const text = e.text.trim()
    if (cfg.check !== 'off' && !shouldSkipCheck(text)) {
      const seq = ++reviewSeq
      $.clock.after(1, () => void runReview($, text, cfg, seq))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!isInteractive || e.agentId || e.reason !== 'answer') return result
    const cfg = await read($, configAtom)
    if (cfg.auto && wordCount(e.answer) >= MIN_AUTO_WORDS) {
      const answer = e.answer
      $.clock.after(1, () => void translate($, answer, true))
    }
    return result
  })

  on('command.run', { command: 'translate' }, async ($) => {
    const messages = await $.session.messages()
    const last = messages.findLast((m) => m.role === 'assistant' && m.text.trim().length > 0)
    if (!last) {
      $.ui.toast('No assistant reply to translate.')
      return {}
    }
    const key = replyKey(last.text)
    const shown = await read($, translationsAtom)
    if (shown.some((t) => t.key === key)) {
      await update($, translationsAtom, (list) => list.filter((t) => t.key !== key))
      void log($, 'translate.hide', `chars=${last.text.length}`)
      return {}
    }
    const source = last.text
    $.clock.after(1, () => void translate($, source, false))
    return {}
  })

  on('command.run', { command: 'flashcards' }, async ($) => {
    await openDeck($)
    return {}
  })

  on('command.run', { command: 'lang' }, async ($, e) => {
    if (e.args.trim()) {
      $.ui.toast(await applyLangArgs($, e.args))
      return {}
    }
    await $.ui.open({ id: LANG_PANE, title: 'Language tutor', focus: true, closeOnEscape: true })
    return {}
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const list = await read($, translationsAtom)
    if (list.length === 0) return next(e)
    const key = replyKey(e.props.text)
    const hit = list.find((t) => t.key === key)
    return hit ? next({ ...e, props: { ...e.props, text: hit.markdown } }) : next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const review = await read($, reviewAtom)
    if (!review || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const dismiss = (
      <Button key="dismiss" label="×" plain role="dismiss" onPress={() => update($, reviewAtom, () => null)} />
    )

    if (review.mode === 'check') {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text color="claude" bold>
              ✏ Writing check
            </Text>
            {dismiss}
          </Box>
          {review.items.map((item) => (
            <Text>
              <Text color="error">"{item.wrong}"</Text> → <Text color="success">"{item.right}"</Text>{' '}
              <Text dimColor>{item.reason}</Text>
            </Text>
          ))}
          {review.rephrase && (
            <Text>
              <Text dimColor>◇ </Text>
              <Text color="subtle">{review.rephrase}</Text>
            </Text>
          )}
        </Box>
      )
    }

    const { tutor, added } = review
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text color="claude" bold>
            ✏ Writing tutor{added > 0 ? <Text dimColor> · +{added} flashcards</Text> : ''}
          </Text>
          {dismiss}
        </Box>
        {tutor.sentence && (
          <Text>
            <Text dimColor>◇ </Text>
            <Text color="success">{tutor.sentence}</Text>
          </Text>
        )}
        {tutor.words.length > 0 && <Text color="subtle">Words</Text>}
        {tutor.words.map((w) => (
          <Text>
            <Text color="claude">{w.word}</Text> <Text dimColor>{w.note}</Text>
          </Text>
        ))}
        {tutor.grammar.length > 0 && <Text color="subtle">Grammar</Text>}
        {tutor.grammar.map((g) => (
          <Text>
            <Text color="claude">{g.structure}</Text> <Text dimColor>{g.note}</Text>
          </Text>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: LANG_PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text>Open /lang in a terminal or desktop session to change settings.</Text>
    }
    const { Box, Text, Select, Input } = $.ui.resolve(e)
    const cfg = await read($, configAtom)
    const flag = [
      { value: 'on', label: 'on' },
      { value: 'off', label: 'off' }
    ]
    return (
      <Box flexDirection="column" gap={1}>
        <Select
          key="check"
          label="Writing check"
          value={cfg.check}
          options={[
            { value: 'on', label: 'on' },
            { value: 'context', label: 'context (sees the session, costs a cache read)' },
            { value: 'off', label: 'off' }
          ]}
          onSelect={(v) => void setConfig($, { check: v as Config['check'] })}
        />
        <Select
          key="tutor"
          label="Writing tutor"
          value={onOff(cfg.tutor)}
          options={flag}
          onSelect={(v) => void setConfig($, { tutor: v === 'on' })}
        />
        <Select
          key="auto"
          label="Auto-translate final replies"
          value={onOff(cfg.auto)}
          options={flag}
          onSelect={(v) => void setConfig($, { auto: v === 'on' })}
        />
        <Select
          key="context"
          label="Translate with session context"
          value={onOff(cfg.context)}
          options={flag}
          onSelect={(v) => void setConfig($, { context: v === 'on' })}
        />
        <Input
          key="learning"
          label="Learning language"
          value={cfg.learning}
          onSubmit={(v) => {
            if (v.trim()) void setConfig($, { learning: v.trim() })
          }}
        />
        <Input
          key="native"
          label="Native language"
          value={cfg.native}
          onSubmit={(v) => {
            if (v.trim()) void setConfig($, { native: v.trim() })
          }}
        />
        <Input
          key="model"
          label="Model"
          value={cfg.model}
          placeholder={DEFAULT_CONFIG.model}
          onSubmit={(v) => void setConfig($, { model: v.trim() || DEFAULT_CONFIG.model })}
        />
        <Text dimColor>Context modes always use the session model.</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: DECK_PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text>Open /flashcards in a terminal or desktop session to review.</Text>
    }
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const view = await read($, deckAtom)
    const cards = await read($, cardsAtom)
    const settings = await read($, deckSettingsAtom)
    const back = (
      <Button key="back" label="Back" hotkey="b" onPress={() => update($, deckAtom, (): DeckView => ({ screen: 'overview' }))} />
    )

    if (view.screen === 'review') {
      const card = cards.find((c) => c.id === view.queue[0])
      if (!card) {
        return (
          <Box flexDirection="column">
            <Text dimColor>This card was deleted.</Text>
            {back}
          </Box>
        )
      }
      const grades: [Grade, string, string][] = [
        [Rating.Again, 'Again', '1'],
        [Rating.Hard, 'Hard', '2'],
        [Rating.Good, 'Good', '3'],
        [Rating.Easy, 'Easy', '4']
      ]
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>{view.queue.length} left</Text>
          <Text bold color="claude">
            {card.word}
          </Text>
          {view.revealed ? (
            <Box flexDirection="column" gap={1}>
              <Text>{card.note}</Text>
              <Box flexDirection="row" gap={1}>
                {grades.map(([rating, label, hotkey]) => (
                  <Button
                    key={`rate-${label}`}
                    label={label}
                    hotkey={hotkey}
                    variant={rating === Rating.Good ? 'primary' : undefined}
                    onPress={() => rate($, card.id, rating)}
                  />
                ))}
              </Box>
            </Box>
          ) : (
            <Button
              key="reveal"
              label="Show answer"
              hotkey="s"
              variant="primary"
              autoFocus
              onPress={() =>
                update($, deckAtom, (v): DeckView => (v.screen === 'review' ? { ...v, revealed: true } : v))
              }
            />
          )}
          {back}
        </Box>
      )
    }

    if (view.screen === 'library') {
      return (
        <Box flexDirection="column">
          {back}
          {cards.length === 0 && <Text dimColor>No cards yet. Write a prompt in your native language to get some.</Text>}
          {libraryOrder(cards).map((c) => (
            <Button key={`card-${c.id}`} plain onPress={() => update($, deckAtom, (): DeckView => ({ screen: 'card', id: c.id }))}>
              {c.word} <Text dimColor>{STATE_LABELS[c.fsrs.state] ?? '?'} · due {formatDate(c.fsrs.due)}</Text>
            </Button>
          ))}
        </Box>
      )
    }

    if (view.screen === 'card') {
      const card = cards.find((c) => c.id === view.id)
      const toLibrary = () => update($, deckAtom, (): DeckView => ({ screen: 'library' }))
      if (!card) {
        return (
          <Box flexDirection="column">
            <Text dimColor>This card was deleted.</Text>
            <Button key="library" label="Library" onPress={toLibrary} />
          </Box>
        )
      }
      return (
        <Box flexDirection="column" gap={1}>
          <Input key="word" label="Word" value={card.word} onSubmit={(v) => void editCard($, card.id, 'word', v)} />
          <Input key="note" label="Note" value={card.note} rows={3} onSubmit={(v) => void editCard($, card.id, 'note', v)} />
          <Text dimColor>
            {STATE_LABELS[card.fsrs.state] ?? '?'} · reps {card.fsrs.reps} · lapses {card.fsrs.lapses} · due{' '}
            {formatDate(card.fsrs.due)}
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="library" label="Library" onPress={toLibrary} />
            <Button key="delete" label="Delete" onPress={() => deleteCard($, card.id)} />
          </Box>
        </Box>
      )
    }

    if (view.screen === 'settings') {
      return (
        <Box flexDirection="column" gap={1}>
          <Input
            key="newPerDay"
            label="New cards per day"
            value={String(settings.newPerDay)}
            onSubmit={(v) => void setDeckSettings($, { newPerDay: Number(v) })}
          />
          <Input
            key="sessionLimit"
            label="Cards per round"
            value={String(settings.sessionLimit)}
            onSubmit={(v) => void setDeckSettings($, { sessionLimit: Number(v) })}
          />
          <Button key="back" label="Back" onPress={() => update($, deckAtom, (): DeckView => ({ screen: 'overview' }))} />
        </Box>
      )
    }

    const stats = deckStats(cards, settings, new Date())
    return (
      <Box flexDirection="column" gap={1}>
        <Text>
          <Text bold>{stats.total}</Text> cards · <Text bold color="claude">{stats.due}</Text> due ·{' '}
          {stats.newCards} new
        </Text>
        <Text dimColor>
          Last review {formatDate(stats.lastReview)} · next due {formatDate(stats.nextDue)}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="start" label="Start review" hotkey="1" variant="primary" autoFocus onPress={() => startRound($)} />
          <Button key="library" label="Library" hotkey="2" onPress={() => update($, deckAtom, (): DeckView => ({ screen: 'library' }))} />
          <Button key="settings" label="Settings" hotkey="3" onPress={() => update($, deckAtom, (): DeckView => ({ screen: 'settings' }))} />
        </Box>
      </Box>
    )
  })
}
