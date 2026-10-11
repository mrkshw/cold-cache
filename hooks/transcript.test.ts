import { describe, expect, test } from 'claude-code/testing'

import { formatTokens, handoffFileName, joinPath, renderTranscript } from './transcript'

describe('renderTranscript', () => {
  test('keeps conversation text whole and labels each speaker', () => {
    const text = renderTranscript([
      { role: 'user', text: 'Why is checkout flaky?', toolUses: [] },
      { role: 'assistant', text: 'The iframe races the fill.', toolUses: [] },
    ])

    expect(text).toContain('## User\nWhy is checkout flaky?')
    expect(text).toContain('## Assistant\nThe iframe races the fill.')
  })

  test('lists tool calls by name and input', () => {
    const text = renderTranscript([
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'src/app.ts' } }],
      },
    ])

    expect(text).toContain('[tool call] Read {"file_path":"src/app.ts"}')
  })

  test('trims long tool results to 2000 characters with a marker', () => {
    const text = renderTranscript([
      {
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [{ tool_use_id: 't1', text: 'x'.repeat(5000), isError: false }],
      },
    ])

    expect(text).toContain(`${'x'.repeat(2000)} […trimmed 3000 chars]`)
    expect(text).not.toContain('x'.repeat(2001))
  })

  test('marks errored tool results', () => {
    const text = renderTranscript([
      {
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [{ tool_use_id: 't1', text: 'ENOENT', isError: true }],
      },
    ])

    expect(text).toContain('[tool result, error]\nENOENT')
  })
})

describe('formatTokens', () => {
  test('rounds to thousands and millions', () => {
    expect(formatTokens(812)).toBe('812')
    expect(formatTokens(184_300)).toBe('184k')
    expect(formatTokens(1_250_000)).toBe('1.3M')
  })
})

describe('handoff paths', () => {
  test('names the file after the local time', () => {
    expect(handoffFileName(new Date(2026, 9, 11, 14, 32).getTime())).toBe('handoff-2026-10-11-1432.md')
  })

  test('joins with the directory own separator', () => {
    expect(joinPath('C:\\Users\\me\\Temp\\', 'a.md')).toBe('C:\\Users\\me\\Temp\\a.md')
    expect(joinPath('/tmp', 'a.md')).toBe('/tmp/a.md')
  })
})
