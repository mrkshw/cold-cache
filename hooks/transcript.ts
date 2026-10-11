import type { SessionMessage } from 'claude-code'

const TOOL_TEXT_LIMIT = 2000

const trim = (text: string) =>
  text.length <= TOOL_TEXT_LIMIT
    ? text
    : `${text.slice(0, TOOL_TEXT_LIMIT)} […trimmed ${text.length - TOOL_TEXT_LIMIT} chars]`

const renderMessage = (message: SessionMessage) => {
  const parts: string[] = []
  if (message.text.trim() !== '') parts.push(message.text)
  for (const use of message.toolUses) {
    parts.push(`[tool call] ${use.tool} ${trim(JSON.stringify(use.input))}`)
  }
  for (const result of message.toolResults ?? []) {
    parts.push(`[tool result${result.isError ? ', error' : ''}]\n${trim(result.text)}`)
  }
  if (parts.length === 0) return undefined
  return `## ${message.role === 'user' ? 'User' : 'Assistant'}\n${parts.join('\n\n')}`
}

export const renderTranscript = (messages: readonly SessionMessage[]) =>
  messages
    .map(renderMessage)
    .filter((part): part is string => part !== undefined)
    .join('\n\n')

export const formatTokens = (tokens: number) => {
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`
  return `${(tokens / 1_000_000).toFixed(1)}M`
}

const pad = (n: number) => String(n).padStart(2, '0')

export const handoffFileName = (ms: number) => {
  const d = new Date(ms)
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return `handoff-${date}-${pad(d.getHours())}${pad(d.getMinutes())}.md`
}

export const joinPath = (dir: string, name: string) => {
  const separator = dir.includes('\\') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${separator}${name}`
}
