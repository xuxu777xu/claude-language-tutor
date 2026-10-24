import type { EngineInterface } from 'claude-code'

import type { Config, FlashcardEntry, FlashcardSettings } from '../types'
import { normalizeConfig } from './core'
import { clampDeckSettings, parseCards } from './flashcards'

const LOG_LIMIT = 256 * 1024

export type Paths = {
  dir: string
  config: string
  cards: string
  deckSettings: string
  log: string
}

export async function resolvePaths($: EngineInterface): Promise<Paths> {
  const home = await $.env.get('HOME')
  if (!home) throw new Error('HOME is not set; cannot place ~/.claude/language-tutor')
  const dir = `${home}/.claude/language-tutor`
  return {
    dir,
    config: `${dir}/config.json`,
    cards: `${dir}/flashcards.json`,
    deckSettings: `${dir}/flashcards-settings.json`,
    log: `${dir}/tutor.log`
  }
}

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  if (!(await $.fs.exists(path))) return undefined
  return JSON.parse(await $.fs.read(path))
}

function writeJson($: EngineInterface, path: string, value: unknown): Promise<void> {
  return $.fs.write(path, JSON.stringify(value, null, 2) + '\n')
}

export async function loadConfig($: EngineInterface, paths: Paths): Promise<Config> {
  return normalizeConfig(await readJson($, paths.config))
}

export function saveConfig($: EngineInterface, paths: Paths, config: Config): Promise<void> {
  return writeJson($, paths.config, config)
}

export async function loadCards($: EngineInterface, paths: Paths): Promise<FlashcardEntry[]> {
  return parseCards(await readJson($, paths.cards))
}

export function saveCards($: EngineInterface, paths: Paths, cards: FlashcardEntry[]): Promise<void> {
  return writeJson($, paths.cards, cards)
}

export async function loadDeckSettings($: EngineInterface, paths: Paths): Promise<FlashcardSettings> {
  return clampDeckSettings(await readJson($, paths.deckSettings))
}

export function saveDeckSettings(
  $: EngineInterface,
  paths: Paths,
  settings: FlashcardSettings
): Promise<void> {
  return writeJson($, paths.deckSettings, settings)
}

export type Queue = <T>(job: () => Promise<T>) => Promise<T>

/** Serializes read-modify-write cycles on one file; each caller still gets its own job's rejection. */
export function createQueue(): Queue {
  let tail: Promise<unknown> = Promise.resolve()
  return (job) => {
    const run = tail.then(job, job)
    tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

const logQueue = createQueue()

export function appendLog($: EngineInterface, paths: Paths, step: string, detail: string): Promise<void> {
  return logQueue(async () => {
    const line = `${new Date().toISOString()} [${step}] ${detail}\n`
    const before = (await $.fs.exists(paths.log)) ? await $.fs.read(paths.log) : ''
    const text = before + line
    await $.fs.write(paths.log, text.length > LOG_LIMIT ? text.slice(text.length - LOG_LIMIT / 2) : text)
  }).catch((err: unknown) => {
    $.ui.log(`language-tutor: log write failed (${paths.log}): ${String(err)}`, { to: 'debug' })
  })
}
