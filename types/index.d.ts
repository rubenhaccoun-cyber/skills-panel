export type ActiveSkill = { name: string; count: number }
export type Suggestion = { name: string; why: string; score: number; tag: string; isRule: boolean }
export type TopSkill = { name: string; count: number; tag: string }

declare module 'claude-code' {
  interface PluginState {
    'skills-panel': {
      active: ActiveSkill[]
      suggested: Suggestion[]
      note: string
      about: string
      top: TopSkill[]
      topAll: TopSkill[]
      topScope: string
      tagFilter: string
      ruleNote: string
      cacheNote: string
    }
  }
}
