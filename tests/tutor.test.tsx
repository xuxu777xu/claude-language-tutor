import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = '/home/tester'
const DIR = `${HOME}/.claude/language-tutor`
const USAGE = {
  input_tokens: 10,
  output_tokens: 10,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0
}

function engine(on: On, replies: string[], files = new Map<string, string>(), modelHangs = false) {
  const prompts: string[] = []
  const models: string[] = []
  mock.env(on, { HOME })
  const clock = mock.clock(on)
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('model.complete', (_, e) => {
    prompts.push(e.prompt)
    models.push(e.model)
    if (modelHangs) return new Promise<never>(() => {})
    const text = replies.shift()
    if (text === undefined) throw new Error('unexpected model call')
    return { value: { isAnswered: true, text, usage: USAGE } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Markdown, Text } = $.ui.resolve(e)
    return 'text' in e.props ? <Markdown text={String(e.props.text)} /> : <Text>engine</Text>
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  return { clock, files, prompts, models }
}

const BAND = {
  plugin: 'language-tutor',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 12,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 12 },
    view: {}
  }
} as const

const COMPOSER = { kind: 'composer' } as const
const TRANSLATE = {
  command: 'translate',
  args: '',
  origin: COMPOSER,
  presentation: { isFullscreen: true, columns: 120 }
} as const

test('a learning-language prompt shows the writing check', async ($, on) => {
  const { clock, prompts, models } = engine(on, [
    '{"mode":"check","items":[{"wrong":"anwser","right":"answer","reason":"拼写错误"}],"rephrase":null}'
  ])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'when agent anwser me, I want translate it', origin: COMPOSER, wait: false })
  await clock.advance(5)

  expect(prompts.length).toBe(1)
  expect(models).toEqual(['haiku'])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Writing check/ }))).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /拼写错误/ }))).toBeDefined()
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ type: 'Text', text: /Writing check/ })).toBe(undefined)
  await ui.unmount()
})

test('a native prompt shows the tutor and captures flashcards', async ($, on) => {
  const { clock, files } = engine(on, [
    JSON.stringify({
      mode: 'tutor',
      sentence: "I'd like to refactor this function but don't know where to start.",
      words: [{ word: 'refactor', note: '重构：不改行为只改结构' }],
      grammar: [{ structure: "don't know where to + verb", note: '不知道从哪里……' }]
    })
  ])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: '我想重构这个函数但是不知道怎么下手', origin: COMPOSER, wait: false })
  await clock.advance(5)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Writing tutor/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /refactor/ })).toBeDefined()
  await ui.unmount()

  const saved = JSON.parse(files.get(`${DIR}/flashcards.json`) ?? '[]') as { word: string }[]
  expect(saved.map((c) => c.word)).toEqual(['refactor'])
  expect((files.get(`${DIR}/tutor.log`) ?? '').includes('[review.done]')).toBe(true)
})

test('a reload clears a busy status the cut-off work left behind', async ($, on) => {
  const reply = 'The build failed because a dependency is missing from the lockfile.'
  const { clock, files } = engine(on, [], new Map(), true)
  on('session.messages', () => ({ value: [{ role: 'assistant', text: reply, toolUses: [] }] }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(TRANSLATE)
  void clock.advance(5)
  await clock.advance(5)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((files.get(`${DIR}/tutor.log`) ?? '').includes('[session.start.busy] cleared "🌐 translating…"')).toBe(true)
})

test('check off makes no model call', async ($, on) => {
  const files = new Map([[`${DIR}/config.json`, JSON.stringify({ check: 'off' })]])
  const { clock, prompts } = engine(on, [], files)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'please explain this error to me', origin: COMPOSER, wait: false })
  await clock.advance(5)
  expect(prompts.length).toBe(0)
})

test('a configured model is used, and /lang model default goes back to haiku', async ($, on) => {
  const files = new Map([[`${DIR}/config.json`, JSON.stringify({ model: 'sonnet' })]])
  const { clock, models } = engine(on, ['{"mode":"check","items":[],"rephrase":null}'], files)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'please explain this error to me', origin: COMPOSER, wait: false })
  await clock.advance(5)
  expect(models).toEqual(['sonnet'])

  await $.command.run({ ...TRANSLATE, command: 'lang', args: 'model default' })
  expect(JSON.parse(files.get(`${DIR}/config.json`) ?? '{}').model).toBe('haiku')
})

test('a reply already in the native language is left as it is', async ($, on) => {
  const reply = '构建失败了，因为锁文件里缺了一个依赖。'
  const { clock, files, prompts } = engine(on, [])
  on('session.messages', () => ({ value: [{ role: 'assistant', text: reply, toolUses: [] }] }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(TRANSLATE)
  await clock.advance(5)

  const message = {
    plugin: 'language-tutor',
    component: 'AssistantMessage',
    requestId: 'm1',
    props: { text: reply, isFirstOfReply: true }
  } as const
  const ui = await $.ui.mount({ ...message, surface: 'terminal' })
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe(reply)
  await ui.unmount()
  expect(prompts.length).toBe(0)
  expect((files.get(`${DIR}/tutor.log`) ?? '').includes('[translate.skip] local:')).toBe(true)
})

test('only paragraphs outside the native language reach the model', async ($, on) => {
  const reply = '构建失败了，原因如下。\n\nA dependency is missing from the lockfile.'
  const { clock, prompts } = engine(on, ['{"t":["锁文件里缺了一个依赖。"]}'])
  on('session.messages', () => ({ value: [{ role: 'assistant', text: reply, toolUses: [] }] }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(TRANSLATE)
  await clock.advance(5)

  expect(prompts.length).toBe(1)
  expect(prompts[0]?.includes('构建失败了')).toBe(false)
  const ui = await $.ui.mount({
    plugin: 'language-tutor',
    component: 'AssistantMessage',
    requestId: 'm1',
    props: { text: reply, isFirstOfReply: true },
    surface: 'terminal'
  })
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe(
    '构建失败了，原因如下。\n\nA dependency is missing from the lockfile.\n\n> 锁文件里缺了一个依赖。'
  )
  await ui.unmount()
})

test('a translated reply draws as the bilingual card', async ($, on) => {
  const reply = 'The build failed because a dependency is missing from the lockfile.'
  const { clock } = engine(on, ['{"t":["构建失败，因为锁文件里缺了一个依赖。"]}'])
  on('session.messages', () => ({ value: [{ role: 'assistant', text: reply, toolUses: [] }] }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(TRANSLATE)
  await clock.advance(5)

  const message = {
    plugin: 'language-tutor',
    component: 'AssistantMessage',
    requestId: 'm1',
    props: { text: reply, isFirstOfReply: true }
  } as const
  const ui = await $.ui.mount({ ...message, surface: 'terminal' })
  const drawn = await ui.find({ type: 'Markdown' })
  expect(drawn?.text).toBe(`${reply}\n\n> 构建失败，因为锁文件里缺了一个依赖。`)
  await ui.unmount()

  await $.command.run(TRANSLATE)
  const again = await $.ui.mount({ ...message, surface: 'terminal' })
  expect((await again.find({ type: 'Markdown' }))?.text).toBe(reply)
  await again.unmount()
})

test('a flashcard round rates the card and reschedules it', async ($, on) => {
  const { clock, files } = engine(on, [
    JSON.stringify({ mode: 'tutor', sentence: 'Clear the cache.', words: [{ word: 'cache', note: '缓存' }], grammar: [] })
  ])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: '请帮我清掉这个缓存目录', origin: COMPOSER, wait: false })
  await clock.advance(5)
  await $.command.run({ ...TRANSLATE, command: 'flashcards' })

  const pane = {
    plugin: 'language-tutor',
    component: 'Pane',
    requestId: 'flashcards',
    props: {
      title: 'Flashcards',
      isFocused: true,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 20 },
      view: {}
    }
  } as const
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  await ui.press({ key: 'start' })
  expect((await ui.find({ type: 'Text', text: /left/ }))?.text).toBe('1 left')
  expect(await ui.find({ type: 'Text', text: /^cache$/ })).toBeDefined()
  await ui.press({ key: 'reveal' })
  expect(await ui.find({ type: 'Text', text: /缓存/ })).toBeDefined()
  await ui.press({ key: 'rate-Good' })
  await ui.unmount()

  const saved = JSON.parse(files.get(`${DIR}/flashcards.json`) ?? '[]') as { fsrs: { state: number; reps: number } }[]
  expect(saved[0]?.fsrs.state).toBe(2)
  expect(saved[0]?.fsrs.reps).toBe(1)

  for (const surface of ['terminal', 'desktop'] as const) {
    const overview = await $.ui.mount({ ...pane, surface })
    expect(await overview.find({ type: 'Text', text: /Last review 20/ })).toBeDefined()
    await overview.unmount()
  }
})
