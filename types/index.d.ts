export type Part = { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' }

export type View = 'full' | 'compact' | 'off'

export type Limit = { kind: string; percent: number; resetsAt: number | null }

export type Fill = {
  tokens: number | null
  window: number
  percent: number | null
  parts: Part[]
  limits: Limit[]
  usd: number | null
  compactAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'context-bar': { fill: Fill | null; isWarned: boolean; view: View; now: number }
  }
}
