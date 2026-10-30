import { useEffect, useState } from 'react'
import { bindings, comboLabel, comboOf, conflicts, SHORTCUTS, type Action } from '../../../shared/shortcuts'
import type { MenuBarMode, YtmSetting } from '../../../shared/types'
import { Close, Plus } from '../components/icons'
import { ErrorBox } from '../components/ui'
import { useApp, useCached } from '../lib'

export function SettingsView({ authed }: { authed: boolean }) {
  const { prefs, setPrefs } = useApp()
  return (
    <div className="page settings">
      <h1 className="page-title">Settings</h1>

      <section className="set-section">
        <h2>Playback</h2>
        <Row title="Music videos" desc="When off, music videos and uploads play as audio-only (or at 144p when YouTube has no audio-only version). Same as “Switch to video” in Now Playing.">
          <Toggle on={prefs.videoMode} onChange={(v) => setPrefs({ videoMode: v })} />
        </Row>
      </section>

      <section className="set-section">
        <h2>App</h2>
        <Row title="Keep playing when the window is closed" desc="Closing the window hides it; reopen from the Dock or Raycast. ⌘Q always quits.">
          <Toggle on={prefs.keepPlaying} onChange={(v) => setPrefs({ keepPlaying: v })} />
        </Row>
        <Row title="Open ytspot when you log in to your Mac">
          <Toggle on={prefs.openAtLogin} onChange={(v) => setPrefs({ openAtLogin: v })} />
        </Row>
        <Row
          title="Now playing in the menu bar"
          desc="Shows the song next to a ♫ icon at the top of your screen; click it for playback controls. On a Mac with a notch, macOS hides it when the menu bar is full, so pick a shorter option if it doesn’t show."
        >
          <select className="select" value={prefs.menuBar} onChange={(e) => setPrefs({ menuBar: e.target.value as MenuBarMode })}>
            <option value="both">Song and artist</option>
            <option value="song">Song</option>
            <option value="artist">Artist</option>
            <option value="icon">Icon only</option>
            <option value="off">Off</option>
          </select>
        </Row>
        <Row
          title="Keyboard navigation"
          desc="Move between buttons with Tab and press them with Space or Return. When off, Space always plays and pauses, wherever you last clicked."
        >
          <Toggle on={prefs.keyboardNav} onChange={(v) => setPrefs({ keyboardNav: v })} />
        </Row>
      </section>

      {authed && <YtmSettings />}
      <ShortcutSettings />

      {authed && (
        <section className="set-section">
          <h2>Account</h2>
          <Row title="Log out" desc="Signs this app out of YouTube Music.">
            <button className="outline-btn" onClick={() => window.ytm.logout()}>
              Log out
            </button>
          </Row>
        </section>
      )}
    </div>
  )
}

function Row({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <div>{title}</div>
        {desc && <div className="sub">{desc}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`toggle ${on ? 'on' : ''}`} role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span />
    </button>
  )
}

// Everything in YouTube Music's own settings dialog, applied through it.
function YtmSettings() {
  const { toast } = useApp()
  const { data, error, set, retry } = useCached<YtmSetting[]>('ytm-settings', () => window.ytm.ytmSettings(), { revalidate: false })
  const change = async (s: YtmSetting, value: boolean | string | null) => {
    if (s.kind === 'action' && s.confirm && !confirm(s.confirm)) return
    if (data && value !== null) set(data.map((x) => (x === s ? { ...x, value } : x)))
    try {
      const endpoint = s.endpoints?.[value === null ? 'run' : String(value)]
      if (!endpoint) throw new Error('no endpoint')
      await window.ytm.applyYtmSetting(endpoint)
      toast(s.kind === 'action' ? `${s.title}: done` : 'Saved')
      // YTM's settings data can lag a moment behind the change; re-read after a beat.
      await new Promise((r) => setTimeout(r, 1500))
      set(await window.ytm.ytmSettings())
    } catch {
      if (data) set(data) // put the control back the way it was
      toast('YouTube Music didn’t accept that change')
    }
  }
  if (!data) return (
    <section className="set-section">
      <h2>YouTube Music</h2>
      {error ? <ErrorBox error={error} onRetry={retry} /> : <SettingsSkeleton />}
    </section>
  )
  const tabs = [...new Set(data.map((s) => s.tab))]
  return (
    <>
      {tabs.map((tab) => (
        <section className="set-section" key={tab}>
          <h2>{tab === 'General' ? 'YouTube Music' : `YouTube Music: ${tab}`}</h2>
          {data
            .filter((s) => s.tab === tab)
            .map((s) => (
              <Row key={s.title} title={s.title} desc={s.summary}>
                {s.kind === 'toggle' && <Toggle on={!!s.value} onChange={(v) => change(s, v)} />}
                {s.kind === 'choice' && (
                  <select className="select" value={String(s.value ?? '')} onChange={(e) => change(s, e.target.value)}>
                    {!s.value && <option value="">Choose…</option>}
                    {s.options?.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                )}
                {s.kind === 'action' && (
                  <button className="outline-btn" onClick={() => change(s, null)}>
                    {/^clear\b/i.test(s.title) ? 'Clear' : s.title.replace(/ history$/, '')}
                  </button>
                )}
                {s.kind === 'link' && s.url && (
                  <button className="outline-btn" onClick={() => window.ytm.open(s.url!)}>
                    Open
                  </button>
                )}
              </Row>
            ))}
        </section>
      ))}
    </>
  )
}

// Placeholder rows shaped like settings rows (title, description, control on the right).
function SettingsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="set-row">
          <div className="set-text sk-set-text">
            <div className="sk sk-line" style={{ width: `${30 + ((i * 13) % 25)}%` }} />
            <div className="sk sk-line short" />
          </div>
          <div className="sk sk-toggle" />
        </div>
      ))}
    </div>
  )
}

function ShortcutSettings() {
  const { prefs, setPrefs } = useApp()
  const sp = prefs.shortcuts
  const keys = bindings(sp)
  const clash = conflicts(keys)
  const [recording, setRecording] = useState<Action | null>(null)
  const setKeys = (action: Action, combos: string[]) =>
    setPrefs({ shortcuts: { ...sp, custom: { ...sp.custom, [action]: combos } } })

  // Record the next combo (or a two-key sequence like "G H") for the chosen action.
  useEffect(() => {
    if (!recording) return
    let first: string | null = null
    let timer: ReturnType<typeof setTimeout>
    const finish = (combo: string) => {
      setKeys(recording, [...keys[recording].filter((c) => c !== combo), combo])
      setRecording(null)
    }
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === 'Escape') return setRecording(null)
      const c = comboOf(e)
      if (!c) return
      clearTimeout(timer)
      if (first) return finish(`${first} ${c}`)
      if (/^[A-Z0-9]$/.test(c)) {
        first = c
        timer = setTimeout(() => finish(c), 900)
      } else finish(c)
    }
    window.addEventListener('keydown', onKey, true)
    return () => (window.removeEventListener('keydown', onKey, true), clearTimeout(timer))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording])

  return (
    <section className="set-section">
      <h2>Keyboard shortcuts</h2>
      <Row title="Spotify shortcuts" desc="⌘-based shortcuts from the Spotify Mac app.">
        <Toggle on={sp.spotify} onChange={(v) => setPrefs({ shortcuts: { ...sp, spotify: v } })} />
      </Row>
      <Row title="YouTube Music shortcuts" desc="Single-key, vim-style shortcuts from YouTube Music on the web (j/k, h/l, g h…).">
        <Toggle on={sp.ytm} onChange={(v) => setPrefs({ shortcuts: { ...sp, ytm: v } })} />
      </Row>
      {clash.size > 0 && (
        <div className="set-warning">
          {[...clash].map(([c, a]) => (
            <div key={c}>
              <kbd>{comboLabel(c)}</kbd> is used by{' '}
              {a.map((x) => SHORTCUTS.find((s) => s.action === x)!.label).join(' and ')} — only the first runs.
            </div>
          ))}
        </div>
      )}
      {SHORTCUTS.map((s) => (
        <div className="set-row sc" key={s.action}>
          <div className="set-text">{s.label}</div>
          <div className="set-control chips-wrap">
            {keys[s.action].map((c) => (
              <span key={c} className={`key-chip ${clash.has(c) ? 'clash' : ''}`}>
                {comboLabel(c)}
                <button aria-label={`Remove ${c}`} onClick={() => setKeys(s.action, keys[s.action].filter((x) => x !== c))}>
                  <Close size={10} />
                </button>
              </span>
            ))}
            <button className={`add-key ${recording === s.action ? 'rec' : ''}`} onClick={() => setRecording(s.action)}>
              {recording === s.action ? 'Press keys… (Esc cancels)' : <Plus size={12} />}
            </button>
          </div>
        </div>
      ))}
      <div className="set-row">
        <div className="set-text sub">Custom bindings override the schemes for that action.</div>
        <button className="outline-btn" onClick={() => setPrefs({ shortcuts: { ...sp, custom: {} } })}>
          Reset to defaults
        </button>
      </div>
    </section>
  )
}
