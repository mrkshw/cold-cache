import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteResult, Register, RenderSurface } from 'claude-code'

import type { Action, Banner } from '../types'
import { COMPACT_SYSTEM, HANDOFF_SYSTEM, SUMMARY_PREFIX, resumePrompt } from './prompts'
import { formatTokens, handoffFileName, joinPath, renderTranscript } from './transcript'

type Engine = EngineInterface

const HIDDEN: Banner = { phase: 'hidden', tokens: null, path: null, failure: null, retry: null, isCopied: false }

const banner = atom({ plugin: 'cold-cache', key: 'banner' } as const, HIDDEN)
const isDismissed = atom({ plugin: 'cold-cache', key: 'isDismissed' } as const, false)

const TICK_MS = 15_000
const COMPACT_MARKER = 'cold-cache:haiku'
const KEEP_MS = 7 * 24 * 60 * 60 * 1000
const LAST_TURN_KEY = 'lastTurnAt'
const HAIKU = { model: 'haiku', maxTokens: 16_000, timeoutMs: 180_000 } as const

const FAILURE_HEADLINE: Record<Action, string> = {
  handoff: "Haiku couldn't write the handoff",
  compact: "Haiku couldn't compact",
}

const describeFailure = (reply: Exclude<ModelCompleteResult, { isAnswered: true }>) =>
  reply.reason === 'api-error' ? `api-error ${reply.status ?? ''} ${reply.error}`.replace(/\s+/g, ' ') : reply.reason

const estimateTokens = (text: string) => Math.round(text.length / 4)

let thresholdMs = 60 * 60_000

const show = ($: Engine, next: Banner) => update($, banner, () => next)

const lastTurns = async ($: Engine) => ((await $.store.get(LAST_TURN_KEY)) ?? {}) as Record<string, number>

const markActive = async ($: Engine) => {
  const now = await $.clock.now()
  const id = await $.session.id()
  const recent = Object.entries(await lastTurns($)).filter(([, at]) => now - at < KEEP_MS)
  await $.store.set(LAST_TURN_KEY, { ...Object.fromEntries(recent), [id]: now })
}

const checkCold = async ($: Engine) => {
  if ((await read($, banner)).phase !== 'hidden' || (await read($, isDismissed))) return
  if ((await $.session.turns()) === 0) return
  const lastAt = (await lastTurns($))[await $.session.id()]
  if (lastAt === undefined) {
    await markActive($)
    return
  }
  if ((await $.clock.now()) - lastAt < thresholdMs) return
  const { context } = await $.session.usage()
  await show($, { ...HIDDEN, phase: 'cold', tokens: context.tokens ?? null })
}

const fail = ($: Engine, action: Action, reason: string) =>
  show($, { ...HIDDEN, phase: 'failed', failure: reason, retry: action })

const writeHandoff = async ($: Engine) => {
  await show($, { ...HIDDEN, phase: 'writing' })
  try {
    const transcript = renderTranscript(await $.session.messages())
    await show($, { ...HIDDEN, phase: 'writing', tokens: estimateTokens(transcript) })
    const reply = await $.model.complete({ ...HAIKU, system: HANDOFF_SYSTEM, prompt: transcript })
    if (!reply.isAnswered) {
      await fail($, 'handoff', describeFailure(reply))
      return
    }
    const dir = (await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? '/tmp'
    const path = joinPath(dir, handoffFileName(await $.clock.now()))
    await $.fs.write(path, reply.text)
    await show($, { ...HIDDEN, phase: 'saved', path })
  } catch (error) {
    await fail($, 'handoff', error instanceof Error ? error.message : String(error))
  }
}

const compactWithHaiku = async ($: Engine) => {
  await show($, { ...HIDDEN, phase: 'compacting' })
  try {
    await $.command.run({ command: 'compact', args: COMPACT_MARKER })
    if ((await read($, banner)).phase === 'compacting') await show($, HIDDEN)
  } catch (error) {
    await fail($, 'compact', error instanceof Error ? error.message : String(error))
  }
}

const clearAndContinue = async ($: Engine, surface: RenderSurface, path: string) => {
  const text = resumePrompt(path)
  await $.ui.copy({ text, surface })
  await show($, HIDDEN)
  await $.command.run({ command: 'clear' })
  await $.prompt.fill({ text })
}

const copyPrompt = async ($: Engine, surface: RenderSurface, path: string) => {
  await $.ui.copy({ text: resumePrompt(path), surface })
  await update($, banner, (current) => ({ ...(current ?? HIDDEN), isCopied: true }))
}

const dismiss = async ($: Engine) => {
  await update($, isDismissed, () => true)
  await show($, HIDDEN)
}

export const register: Register = (on, options) => {
  thresholdMs = Number(options.thresholdMinutes ?? 60) * 60_000

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    $.clock.every(TICK_MS, () => {
      void checkCold($)
    })
    await checkCold($)
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const { phase } = await read($, banner)
    if (phase === 'cold' || phase === 'saved' || phase === 'failed') await show($, HIDDEN)
    await markActive($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await markActive($)
      await update($, isDismissed, () => false)
    }
    return result
  })

  on('session.compact', async ($, e, next) => {
    if (e.instructions !== COMPACT_MARKER || e.agentId !== undefined) return next(e)
    const transcript = renderTranscript(e.messages)
    await show($, { ...HIDDEN, phase: 'compacting', tokens: estimateTokens(transcript) })
    const reply = await $.model.complete({ ...HAIKU, system: COMPACT_SYSTEM, prompt: transcript })
    if (!reply.isAnswered) {
      const reason = describeFailure(reply)
      await fail($, 'compact', reason)
      return { skip: reason }
    }
    await markActive($)
    await show($, HIDDEN)
    return { messages: [{ role: 'user', text: `${SUMMARY_PREFIX}\n\n${reply.text}`, toolUses: [] }] }
  }).catch((_$, e, next) => {
    // Never let a failed Haiku compaction fall through to a full-price main-model one.
    if (next.called || e.instructions !== COMPACT_MARKER) return next(e)
    return { skip: 'the Haiku compaction failed' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, banner)
    const isBusy = state.phase === 'writing' || state.phase === 'compacting'
    if (state.phase === 'hidden' || e.props.hasSurvey || (e.props.isWorking && !isBusy)) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const isDesktop = e.surface === 'desktop'
    const tokens = state.tokens === null ? null : formatTokens(state.tokens)

    const line = {
      cold: {
        icon: '❄︎',
        tone: 'suggestion',
        headline: 'Cache cold',
        detail:
          tokens === null
            ? ' · next message re-reads the whole conversation uncached'
            : ` · next message re-reads ${tokens} tokens uncached`,
      },
      writing: {
        icon: '❄︎',
        tone: 'suggestion',
        headline: 'Writing handoff…',
        detail: tokens === null ? '' : ` · reading ${tokens} tokens`,
      },
      compacting: {
        icon: '❄︎',
        tone: 'suggestion',
        headline: 'Compacting…',
        detail: tokens === null ? '' : ` · reading ${tokens} tokens`,
      },
      saved: { icon: '✓', tone: 'success', headline: 'Handoff saved', detail: ` · ${state.path ?? ''}` },
      failed: {
        icon: '✗',
        tone: 'error',
        headline: FAILURE_HEADLINE[state.retry ?? 'handoff'],
        detail: ` · ${state.failure ?? 'unknown error'}. Conversation unchanged.`,
      },
    }[state.phase]

    const dismissButton = isDesktop ? (
      <Button key="dismiss" role="dismiss" label="Dismiss" onPress={() => void dismiss($)} />
    ) : (
      <Button key="dismiss" role="dismiss" plain hotkey="0" dimColor label="Dismiss" onPress={() => void dismiss($)} />
    )

    const buttons =
      state.phase === 'cold' ? (
        <Box gap={3}>
          <Button
            key="handoff"
            variant="primary"
            plain
            hotkey="1"
            label="Handoff"
            onPress={() => void writeHandoff($)}
          />
          <Button key="compact" plain hotkey="2" label="Compact with Haiku" onPress={() => void compactWithHaiku($)} />
          {dismissButton}
        </Box>
      ) : state.phase === 'saved' && state.path !== null ? (
        <Box gap={3}>
          <Button
            key="continue"
            variant="primary"
            plain
            hotkey="1"
            label="Clear & continue"
            onPress={(press) => void clearAndContinue($, press.surface, state.path as string)}
          />
          <Button
            key="copy"
            plain
            hotkey="2"
            label={state.isCopied ? 'Copied' : 'Copy prompt'}
            onPress={(press) => void copyPrompt($, press.surface, state.path as string)}
          />
          {dismissButton}
        </Box>
      ) : state.phase === 'failed' ? (
        <Box gap={3}>
          <Button
            key="retry"
            variant="primary"
            plain
            hotkey="1"
            label="Retry"
            onPress={() => void (state.retry === 'compact' ? compactWithHaiku($) : writeHandoff($))}
          />
          {dismissButton}
        </Box>
      ) : null

    return (
      <Box
        flexDirection={isDesktop ? 'row' : 'column'}
        justifyContent={isDesktop ? 'space-between' : 'flex-start'}
        alignItems={isDesktop ? 'center' : 'flex-start'}
        gap={isDesktop ? 2 : 0}
        width={e.props.bodyColumns}
      >
        <Box flexShrink={1} minWidth={0}>
          <Box flexShrink={0}>
            <Text color={line.tone} bold wrap="truncate-end">
              {`${line.icon} ${line.headline}`}
            </Text>
          </Box>
          <Box flexShrink={1} minWidth={0}>
            <Text dimColor wrap={state.phase === 'saved' ? 'truncate-middle' : 'truncate-end'}>
              {line.detail}
            </Text>
          </Box>
        </Box>
        {buttons}
      </Box>
    )
  })
}
