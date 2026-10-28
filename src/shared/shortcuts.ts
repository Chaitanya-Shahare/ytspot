// Keyboard shortcuts: Spotify (macOS) and YouTube Music web schemes, merged. Combos are strings:
// modifiers in canonical order joined with "+", e.g. "Shift+Cmd+Right"; sequences are
// space-separated combos, e.g. "G H". Users can turn schemes off or rebind actions in Settings.
export type Action =
  | 'toggle' | 'next' | 'prev' | 'seekFwd' | 'seekBack' | 'seekFwdSmall' | 'seekBackSmall'
  | 'shuffle' | 'repeat' | 'volUp' | 'volDown' | 'mute' | 'like' | 'dislike'
  | 'search' | 'home' | 'explore' | 'library' | 'settings' | 'back' | 'forward' | 'liked'
  | 'queue' | 'lyrics' | 'toggleLeft' | 'toggleRight' | 'fullscreen' | 'help'

export interface ShortcutDef {
  action: Action
  label: string
  section: 'Playback' | 'Navigation' | 'Layout' | 'Basic'
  spotify: string[]
  ytm: string[]
}

export const SHORTCUTS: ShortcutDef[] = [
  { section: 'Playback', action: 'toggle', label: 'Play / Pause', spotify: ['Space'], ytm: ['Space', ';'] },
  { section: 'Playback', action: 'next', label: 'Skip to next', spotify: ['Cmd+Right'], ytm: ['J', 'Shift+N'] },
  { section: 'Playback', action: 'prev', label: 'Skip to previous', spotify: ['Cmd+Left'], ytm: ['K', 'Shift+P'] },
  { section: 'Playback', action: 'seekFwd', label: 'Forward 10s', spotify: ['Shift+Cmd+Right'], ytm: ['L', 'Shift+Right'] },
  { section: 'Playback', action: 'seekBack', label: 'Back 10s', spotify: ['Shift+Cmd+Left'], ytm: ['H', 'Shift+Left'] },
  { section: 'Playback', action: 'seekFwdSmall', label: 'Forward 1s', spotify: [], ytm: ['Shift+L', 'Ctrl+Shift+Right'] },
  { section: 'Playback', action: 'seekBackSmall', label: 'Back 1s', spotify: [], ytm: ['Shift+H', 'Ctrl+Shift+Left'] },
  { section: 'Playback', action: 'shuffle', label: 'Shuffle', spotify: ['Cmd+S'], ytm: ['S'] },
  { section: 'Playback', action: 'repeat', label: 'Repeat', spotify: ['Cmd+R'], ytm: ['R'] },
  { section: 'Playback', action: 'volUp', label: 'Raise volume', spotify: ['Cmd+Up'], ytm: ['='] },
  { section: 'Playback', action: 'volDown', label: 'Lower volume', spotify: ['Cmd+Down'], ytm: ['-'] },
  { section: 'Playback', action: 'mute', label: 'Mute', spotify: [], ytm: ['M'] },
  { section: 'Playback', action: 'like', label: 'Like', spotify: ['Alt+Shift+B'], ytm: ['+'] },
  { section: 'Playback', action: 'dislike', label: 'Dislike', spotify: [], ytm: ['_'] },
  { section: 'Navigation', action: 'search', label: 'Search', spotify: ['Cmd+L', 'Cmd+K'], ytm: ['/'] },
  { section: 'Navigation', action: 'home', label: 'Home', spotify: ['Alt+Shift+H'], ytm: ['G H'] },
  { section: 'Navigation', action: 'explore', label: 'Explore', spotify: [], ytm: ['G E'] },
  { section: 'Navigation', action: 'library', label: 'Your Library', spotify: [], ytm: ['G L'] },
  { section: 'Navigation', action: 'liked', label: 'Liked Songs', spotify: ['Alt+Shift+S'], ytm: [] },
  { section: 'Navigation', action: 'settings', label: 'Settings', spotify: ['Cmd+,'], ytm: ['G ,'] },
  { section: 'Navigation', action: 'back', label: 'Back in history', spotify: ['Cmd+['], ytm: [] },
  { section: 'Navigation', action: 'forward', label: 'Forward in history', spotify: ['Cmd+]'], ytm: [] },
  { section: 'Layout', action: 'queue', label: 'Queue', spotify: ['Alt+Shift+Q'], ytm: ['Q'] },
  { section: 'Layout', action: 'lyrics', label: 'Lyrics', spotify: [], ytm: [] },
  { section: 'Layout', action: 'toggleLeft', label: 'Toggle left sidebar', spotify: ['Alt+Shift+L'], ytm: [] },
  { section: 'Layout', action: 'toggleRight', label: 'Toggle right sidebar', spotify: ['Alt+Shift+R'], ytm: [] },
  { section: 'Layout', action: 'fullscreen', label: 'Full screen', spotify: [], ytm: ['F'] },
  { section: 'Basic', action: 'help', label: 'Keyboard shortcuts', spotify: ['Cmd+/'], ytm: ['?'] }
]

export interface ShortcutPrefs {
  spotify: boolean
  ytm: boolean
  custom: Partial<Record<Action, string[]>>
}

export const DEFAULT_PREFS: ShortcutPrefs = { spotify: true, ytm: true, custom: {} }

export function bindings(p: ShortcutPrefs): Record<Action, string[]> {
  const out = {} as Record<Action, string[]>
  for (const s of SHORTCUTS)
    out[s.action] = p.custom[s.action] ?? [...new Set([...(p.spotify ? s.spotify : []), ...(p.ytm ? s.ytm : [])])]
  return out
}

// Combos bound to more than one action.
export function conflicts(b: Record<Action, string[]>): Map<string, Action[]> {
  const by = new Map<string, Action[]>()
  for (const [a, combos] of Object.entries(b) as [Action, string[]][])
    for (const c of combos) by.set(c, [...(by.get(c) ?? []), a])
  return new Map([...by].filter(([, a]) => a.length > 1))
}

const KEY_NAMES: Record<string, string> = {
  ' ': 'Space', ArrowRight: 'Right', ArrowLeft: 'Left', ArrowUp: 'Up', ArrowDown: 'Down', Escape: 'Esc'
}

// Canonical combo for a keydown. Letters/digits use the physical key (⌥ changes e.key on macOS);
// punctuation uses the produced character, so Shift is implied ("+" rather than "Shift+=").
export function comboOf(e: KeyboardEvent): string | null {
  if (['Shift', 'Meta', 'Alt', 'Control'].includes(e.key)) return null
  const letter = /^(Key|Digit)/.test(e.code)
  const key = letter ? e.code.replace(/^(Key|Digit)/, '') : (KEY_NAMES[e.key] ?? e.key)
  const punct = !letter && key.length === 1
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && !punct && 'Shift', e.metaKey && 'Cmd']
  return [...mods.filter(Boolean), key].join('+')
}

const SYM: Record<string, string> = {
  Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘', Right: '→', Left: '←', Up: '↑', Down: '↓'
}
export const comboLabel = (combo: string) =>
  combo
    .split(' ')
    // Split on "+" separators only, so the "+" key itself survives ("+", "Cmd++").
    .map((step) => step.split(/\+(?=.)/).map((k) => SYM[k] ?? k).join(' '))
    .join(' then ')

// Electron accelerator for the menu bar (display only); sequences and bare keys aren't shown.
export function accel(combos: string[]): string | undefined {
  const c = combos.find((x) => !x.includes(' ') && /^(Ctrl|Alt|Shift|Cmd)\+/.test(x)) ?? combos.find((x) => x === 'Space')
  return c?.replace(/\+\+$/, '+Plus')
}
