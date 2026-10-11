export type Phase = 'hidden' | 'cold' | 'writing' | 'compacting' | 'saved' | 'failed'

export type Action = 'handoff' | 'compact'

export type Banner = {
  phase: Phase
  tokens: number | null
  path: string | null
  failure: string | null
  retry: Action | null
  isCopied: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'cold-cache': { banner: Banner; isDismissed: boolean }
  }
}
