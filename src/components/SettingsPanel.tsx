import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { closeSettings, useSettingsOpen } from '../state/settings'
import { COMMANDS, eventBinding, LEADER_SHORTCUTS, resetBindings, setBinding, shortcutLabel, useCommandBindings } from '../state/commands'
import { BUNDLED_THEMES, setThemePalette, useViewThemes } from '../state/theme'
import { setBeadsView, useUiPreferences, type BeadsView } from '../state/uiPreferences'
import { useSessionPreferences, setSessionPreferences } from '../state/sessionPreferences'
import { resetTerminalAppearance, TERMINAL_FONTS, setTerminalAppearance, useTerminalAppearance } from '../state/terminalAppearance'
import { DEFAULT_THEME_ID } from '../themes'
import { getSkin, type Skin } from '../state/skin'
import './SettingsPanel.css'
import { safeListen } from '../lib/listenerRegistry'
import { openSettings } from '../state/settings'

const sectionKeywords: Record<string, string> = { General: 'workspace developer explorer board', Appearance: 'theme colors designer developer font size line height', Terminal: 'font size line height cursor blink scrollback history split unsplit zoom close', 'Keyboard shortcuts': 'commands bindings keys reset', Sessions: 'claude resume agents' }
const sections = ['General', 'Appearance', 'Terminal', 'Keyboard shortcuts', 'Sessions'] as const
export function SettingsPanel() {
  const open = useSettingsOpen()
  const dialog = useRef<HTMLDialogElement>(null)
  const [section, setSection] = useState<typeof sections[number]>('General')
  const [search, setSearch] = useState('')
  const [recording, setRecording] = useState<string | null>(null)
  const [error, setError] = useState('')
  const bindings = useCommandBindings()
  const viewThemes = useViewThemes()
  const [themeView, setThemeView] = useState<Skin>(getSkin)
  const palette = viewThemes[themeView]
  const [settingsSearch, setSettingsSearch] = useState('')
  const ui = useUiPreferences()
  const session = useSessionPreferences()
  const appearance = useTerminalAppearance()
  useEffect(() => {
    let disposed = false
    let release: (() => void) | undefined
    void safeListen('settings:open', openSettings).then(unlisten => { if (disposed) unlisten(); else release = unlisten }).catch(() => {})
    return () => { disposed = true; release?.() }
  }, [])
  useEffect(() => {
    if (open) { setThemeView(getSkin()); dialog.current?.showModal(); return () => { dialog.current?.close() } }
  }, [open])
  if (!open) return null
  return createPortal(<dialog ref={dialog} className="bs-settings" aria-labelledby="settings-title" onCancel={() => { setRecording(null); closeSettings() }} onClick={e => { if (e.target === e.currentTarget) closeSettings() }}>
    <div className="bs-settings__shell">
      <nav aria-label="Settings categories">
        <h2 id="settings-title">Settings</h2>
        <input className="bs-settings__search" aria-label="Search settings" placeholder="Find settings…" value={settingsSearch} onChange={e => setSettingsSearch(e.target.value)} />
        {sections.filter(s => `${s} ${sectionKeywords[s]}`.toLowerCase().includes(settingsSearch.toLowerCase())).map(s => <button key={s} aria-current={section === s ? 'page' : undefined} onClick={() => { setSection(s); setRecording(null); setError('') }}>{s}</button>)}
        {settingsSearch && !sections.some(s => `${s} ${sectionKeywords[s]}`.toLowerCase().includes(settingsSearch.toLowerCase())) && <span role="status">No matching settings</span>}
        <p>Beads Station<br /><span>Preferences save automatically</span></p>
      </nav>
      <main>
        <header><h3>{section}</h3><button aria-label="Close settings" onClick={closeSettings}>Done</button></header>
        {section === 'General' && <>
          <p className="bs-settings__intro">Make this workspace feel at home.</p>
          <label className="bs-settings__row"><span>Developer view<small>Choose which ticket surfaces appear beside the terminal.</small></span><select value={ui.view} onChange={e => setBeadsView(e.target.value as BeadsView)}><option value="terminal-only">Terminal only</option><option value="explorer">Explorer</option><option value="board">Board</option><option value="both">Explorer and board</option></select></label>
          <p className="bs-settings__note">Open folders and manage discovery roots from the workspace picker. These preferences apply across workspaces.</p>
        </>}
        {section === 'Appearance' && <>
          <p className="bs-settings__intro">Choose independent themes for Developer and Designer. Menus and dialogs follow the view you are using.</p>
          <label className="bs-settings__row"><span>Theme for view<small>Editing the other view leaves the current colors in place.</small></span><select aria-label="Theme for view" value={themeView} onChange={e => setThemeView(e.target.value as Skin)}><option value="terminal">Developer</option><option value="designer">Designer</option></select></label>
          <p className="bs-settings__note">Developer: {viewThemes.terminal} · Designer: {viewThemes.designer}</p>
          <div className="bs-settings__themes">{BUNDLED_THEMES.map(t => <button key={t.name} className="bs-theme-preview" aria-pressed={palette === t.name} onClick={() => setThemePalette(t.name, themeView)}>
            <span className="bs-theme-preview__sample" style={{ background: t.background, color: t.foreground }}><span style={{ color: t.green }}>&gt;</span> beads station<span className="bs-theme-preview__swatches">{[t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan].map((color, i) => <i key={i} style={{ background: color }} />)}</span></span>
            <span>{t.name.replace(/-/g, ' ')}{palette === t.name ? ' · selected' : ''}</span>
          </button>)}</div>
          <button onClick={() => setThemePalette(DEFAULT_THEME_ID, themeView)}>Reset this view’s theme</button>
        </>}
        {(section === 'Appearance' || section === 'Terminal') && <>
          {section === 'Terminal' && <p className="bs-settings__intro">Changes apply to existing shells in both views. Applications such as Neovim can override the cursor.</p>}
          <label className="bs-settings__row"><span>Terminal font</span><select value={appearance.fontFamily} onChange={e => setTerminalAppearance({ fontFamily: e.target.value })}>{TERMINAL_FONTS.map(f => <option key={f}>{f}</option>)}</select></label>
          <label className="bs-settings__row"><span>Font size</span><input aria-label="Font size" type="number" min="10" max="24" value={appearance.fontSize} onChange={e => { const n = Number(e.target.value); if (n >= 10 && n <= 24) setTerminalAppearance({ fontSize: n }) }} /></label>
          <label className="bs-settings__row"><span>Line height</span><input aria-label="Line height" type="number" min="1" max="1.8" step="0.1" value={appearance.lineHeight} onChange={e => { const n = Number(e.target.value); if (n >= 1 && n <= 1.8) setTerminalAppearance({ lineHeight: n }) }} /></label>
        </>}
        {section === 'Terminal' && <>
          <label className="bs-settings__row"><span>Cursor shape</span><select aria-label="Cursor shape" value={appearance.cursorStyle} onChange={e => setTerminalAppearance({ cursorStyle: e.target.value as 'block' | 'bar' | 'underline' })}><option value="block">Block</option><option value="bar">Bar</option><option value="underline">Underline</option></select></label>
          <label className="bs-settings__row"><span>Blink cursor</span><input aria-label="Blink cursor" type="checkbox" checked={appearance.cursorBlink} onChange={e => setTerminalAppearance({ cursorBlink: e.target.checked })} /></label>
          <label className="bs-settings__row"><span>Scrollback lines<small>More history uses more memory per terminal. Reducing this trims older output.</small></span><input aria-label="Scrollback lines" type="number" min="100" max="50000" step="100" value={appearance.scrollback} onChange={e => setTerminalAppearance({ scrollback: Number(e.target.value) })} /></label>
          <p className="bs-settings__note">Unsplit to tabs keeps every session running. Close pane stops the selected shell or agent. Zoom temporarily fills the terminal area with one pane.</p>
          <button onClick={resetTerminalAppearance}>Restore terminal defaults</button>
        </>}
        {section === 'Keyboard shortcuts' && <>
          <p className="bs-settings__intro">Click a shortcut and press a new combination. Leader chords are fixed and listed by context below.</p>
          <input className="bs-settings__search" aria-label="Search shortcuts" placeholder="Search commands…" value={search} onChange={e => setSearch(e.target.value)} />
          {error && <p role="alert">{error}</p>}
          {COMMANDS.filter(c => c.label.toLowerCase().includes(search.toLowerCase())).map(c => <div className="bs-settings__row" key={c.id}><span>{c.label}</span><div className="bs-settings__binding"><button aria-label={`Shortcut for ${c.label}`} onBlur={() => setRecording(null)} onClick={() => { setRecording(c.id); setError('') }} onKeyDown={e => {
            if (recording !== c.id) return
            if (e.key === 'Tab') { setRecording(null); return }
            e.preventDefault(); e.stopPropagation()
            if (e.key === 'Escape') { setRecording(null); return }
            const b = eventBinding(e.nativeEvent)
            if (!b) { setError('Include Command or Control in the shortcut.'); return }
            const failure = setBinding(c.id, b)
            setError(failure || '')
            if (!failure) setRecording(null)
          }}><kbd>{recording === c.id ? 'Press shortcut…' : shortcutLabel(bindings[c.id]) || 'Record shortcut'}</kbd></button><button aria-label={`Clear shortcut for ${c.label}`} disabled={!bindings[c.id]} onClick={() => { setBinding(c.id, ''); setError('') }}>Clear</button></div></div>)}
          {(!search || 'leader'.includes(search.toLowerCase())) && <div className="bs-settings__leaders">
            <h4>Leader chords</h4>
            <p className="bs-settings__note">Space arms the leader in normal mode. Cmd/Ctrl+P arms it from any input. The second key depends on the focused surface.</p>
            {(['global', 'terminal'] as const).map(context => <section key={context} aria-label={`${context} leader chords`}>
              <strong>{context === 'global' ? 'Board, sidebar or chat' : 'Terminal pane'}</strong>
              {LEADER_SHORTCUTS[context].map(h => <div className="bs-settings__leader-row" key={`${context}-${h.key}`}><kbd>&lt;leader&gt; {h.key}</kbd><span>{h.label}</span></div>)}
            </section>)}
          </div>}
          <p className="bs-settings__note">Escape belongs to your editor. Fullscreen terminal focus defaults to Cmd/Ctrl+Enter and can be rebound above. Existing leader sequences are unchanged.</p>
          <button onClick={() => { resetBindings(); setError('') }}>Restore default shortcuts</button>
        </>}
        {section === 'Sessions' && <>
          <p className="bs-settings__intro">Agents start when you ask them to.</p>
          <label className="bs-settings__row"><span>Ask before resuming Claude<small>When starting chat, offer a choice for a previously observed Claude session. Turn off to resume it directly.</small></span><input type="checkbox" checked={session.askBeforeResume} onChange={e => setSessionPreferences({ askBeforeResume: e.target.checked })} /></label>
          <p className="bs-settings__note">Opening a folder does not start an agent. A saved conversation is not proof of a running process; a session removed by Claude may no longer be resumable.</p>
        </>}
      </main>
    </div>
  </dialog>, document.body)
}
