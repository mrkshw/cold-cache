import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf, SessionMessage } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const OPTIONS = { options: { thresholdMinutes: 1 } }
const MINUTE = 60_000
const SURFACES = ['terminal', 'desktop'] as const
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as unknown as RenderPropsOf['AbovePrompt']

const TRANSCRIPT: SessionMessage[] = [
  { role: 'user', text: 'Why is checkout flaky on CI?', toolUses: [] },
  { role: 'assistant', text: 'The payment iframe races the fill.', toolUses: [] },
]

const stubSession = (on: On) => {
  const clock = mock.clock(on, { now: 0 })
  mock.store(on)
  mock.env(on, { TEMP: 'C:\\Temp' })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.turns', () => ({ value: 3 }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 184_300, window: 1_000_000 }, rateLimits: [] },
  }))
  on('session.messages', () => ({ value: TRANSCRIPT }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return clock
}

const finishTurn = ($: Engine) =>
  $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })

const mountBand = ($: Engine, surface: (typeof SURFACES)[number], props: Partial<RenderPropsOf['AbovePrompt']> = {}) =>
  $.ui.mount({ plugin: 'cold-cache', surface, component: 'AbovePrompt', props: { ...BAND_PROPS, ...props } })

test('stays hidden while the cache is still warm', OPTIONS, async ($, on) => {
  const clock = stubSession(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await finishTurn($)
  await clock.advance(30_000)

  for (const surface of SURFACES) {
    const band = await mountBand($, surface)
    expect(await band.find({ text: /Cache cold/ })).toBeUndefined()
    await band.unmount()
  }
})

test('warns once idle past the threshold, with the uncached token count', OPTIONS, async ($, on) => {
  const clock = stubSession(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await finishTurn($)
  await clock.advance(MINUTE + 15_000)

  for (const surface of SURFACES) {
    const band = await mountBand($, surface)
    expect(await band.find({ text: /Cache cold/ })).toBeDefined()
    expect(await band.find({ text: /re-reads 184k tokens uncached/ })).toBeDefined()
    expect(await band.find({ key: 'handoff' })).toBeDefined()
    expect(await band.find({ key: 'compact' })).toBeDefined()
    await band.unmount()
  }
})

test('stays out of the way while a turn runs', OPTIONS, async ($, on) => {
  const clock = stubSession(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await finishTurn($)
  await clock.advance(MINUTE + 15_000)

  const band = await mountBand($, 'terminal', { isWorking: true })
  expect(await band.find({ text: /Cache cold/ })).toBeUndefined()
})

test('dismiss hides the warning until the next cold period', OPTIONS, async ($, on) => {
  const clock = stubSession(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await finishTurn($)
  await clock.advance(MINUTE + 15_000)

  const band = await mountBand($, 'terminal')
  await band.press({ key: 'dismiss' })
  await clock.advance(MINUTE)
  expect(await band.find({ text: /Cache cold/ })).toBeUndefined()

  await finishTurn($)
  await clock.advance(MINUTE + 15_000)
  expect(await band.find({ text: /Cache cold/ })).toBeDefined()
})

test('handoff asks Haiku and saves its document to the temp folder', OPTIONS, async ($, on) => {
  const clock = stubSession(on)
  const writes: { path: string; text: string }[] = []
  let asked: { model: string; prompt: string } | undefined
  on('model.complete', (_$, e) => {
    asked = { model: e.model, prompt: e.prompt }
    return { value: { isAnswered: true, text: '# Handoff\nGoal: fix flaky checkout', usage: USAGE } }
  })
  on('fs.write', (_$, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await finishTurn($)
  await clock.advance(MINUTE + 15_000)

  const band = await mountBand($, 'terminal')
  await band.press({ key: 'handoff' })

  expect(asked?.model).toBe('haiku')
  expect(asked?.prompt).toContain('Why is checkout flaky on CI?')
  expect(writes).toHaveLength(1)
  expect(writes[0]?.path).toMatch(/^C:\\Temp\\handoff-.*\.md$/)
  expect(writes[0]?.text).toContain('Goal: fix flaky checkout')
  expect(await band.find({ text: /Handoff saved/ })).toBeDefined()
  expect(await band.find({ key: 'continue' })).toBeDefined()
})

test('clear & continue copies the prompt, clears, and refills the prompt box', OPTIONS, async ($, on) => {
  const clock = stubSession(on)
  const events: string[] = []
  on('model.complete', () => ({ value: { isAnswered: true, text: '# Handoff', usage: USAGE } }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.copy', (_$, e) => {
    events.push(`copy:${e.text}`)
    return { value: { isCopied: true } }
  })
  on('command.run', (_$, e) => {
    events.push(`run:${e.command}`)
    return { text: '' }
  })
  on('prompt.fill', (_$, e) => {
    events.push(`fill:${e.text}`)
    return { isFilled: true }
  })
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await finishTurn($)
  await clock.advance(MINUTE + 15_000)

  const band = await mountBand($, 'terminal')
  await band.press({ key: 'handoff' })
  await band.press({ key: 'continue' })

  expect(events[0]).toMatch(/^copy:Read the handoff at C:\\Temp\\handoff-.*\.md first\.$/)
  expect(events[1]).toBe('run:clear')
  expect(events[2]).toMatch(/^fill:Read the handoff at /)
})

test('a failed Haiku call says why and offers a retry', OPTIONS, async ($, on) => {
  const clock = stubSession(on)
  on('model.complete', () => ({
    value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE },
  }))
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await finishTurn($)
  await clock.advance(MINUTE + 15_000)

  const band = await mountBand($, 'terminal')
  await band.press({ key: 'handoff' })

  expect(await band.find({ text: /couldn't write the handoff/ })).toBeDefined()
  expect(await band.find({ text: /529 overloaded/ })).toBeDefined()
  expect(await band.find({ key: 'retry' })).toBeDefined()
})

test('compact from the banner is answered by Haiku, not the main model', OPTIONS, async ($, on) => {
  const clock = stubSession(on)
  const models: string[] = []
  let isEngineCompactorUsed = false
  on('command.run', async (_$, e) => {
    if (e.command === 'compact')
      await $.session.compact({ trigger: 'manual', instructions: e.args, messages: TRANSCRIPT })
    return { text: '' }
  })
  on('model.complete', (_$, e) => {
    models.push(e.model)
    return { value: { isAnswered: true, text: 'Goal: fix flaky checkout', usage: USAGE } }
  })
  on('session.compact', () => {
    isEngineCompactorUsed = true
    return { messages: [{ role: 'user', text: 'engine summary', toolUses: [] }] }
  })
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await finishTurn($)
  await clock.advance(MINUTE + 15_000)

  const band = await mountBand($, 'terminal')
  await band.press({ key: 'compact' })

  expect(isEngineCompactorUsed).toBe(false)
  expect(models).toEqual(['haiku'])
  expect(isEngineCompactorUsed).toBe(false)
  expect(await band.find({ text: /Cache cold/ })).toBeUndefined()
})

test('a typed /compact is left to the engine', OPTIONS, async ($, on) => {
  stubSession(on)
  let isModelAsked = false
  let isEngineCompactorUsed = false
  on('model.complete', () => {
    isModelAsked = true
    return { value: { isAnswered: true, text: '', usage: USAGE } }
  })
  on('session.compact', () => {
    isEngineCompactorUsed = true
    return { messages: [{ role: 'user', text: 'engine summary', toolUses: [] }] }
  })

  await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })

  expect(isEngineCompactorUsed).toBe(true)
  expect(isModelAsked).toBe(false)
})
