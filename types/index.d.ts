export type Lookup = {
  word: string
  status: 'idle' | 'loading' | 'found' | 'missing'
  text: string
  /** Why the native popup could not open, shown above the fallback text. */
  note: string
}

export type Cleanup = {
  phase: 'idle' | 'measuring' | 'confirm' | 'deleting' | 'done' | 'error'
  files: number
  kb: number
  message: string
}

declare module 'claude-code' {
  interface PluginState {
    'd2d-claude-utility-mod': { lookup: Shaped<Lookup>; cleanup: Shaped<Cleanup> }
  }
}
