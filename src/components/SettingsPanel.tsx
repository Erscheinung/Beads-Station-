import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { closeSettings, useSettingsOpen } from '../state/settings'
import { ensureSystemNotificationPermission } from '../lib/systemNotifications'
import { setAgentHooksInstalled, useAgentHooks } from '../state/agentHooks'
import { COMMANDS, eventBinding, LEADER_SHORTCUTS, resetBindings, setBinding, shortcutLabel, useCommandBindings } from '../state/commands'
import { BUNDLED_THEMES, setThemePalette, useViewThemes, useMatchSystem, setMatchSystem, useThemeToggleMode, setThemeToggleMode, type ThemeToggleMode } from '../state/theme'
import { paletteAppearance } from '../lib/themeImport'
import { setBeadsView, useUiPreferences, type BeadsView } from '../state/uiPreferences'
import { useSessionPreferences, setSessionPreferences } from '../state/sessionPreferences'
import { resetTerminalAppearance, TERMINAL_FONTS, setTerminalAppearance, useTerminalAppearance, resolveCmdColor, HEX_COLOR, type CmdColorMode } from '../state/terminalAppearance'
import { DEFAULT_THEME_ID } from '../themes'
import { getSkin, type Skin } from '../state/skin'
import './SettingsPanel.css'
import { safeListen } from '../lib/listenerRegistry'
import { openSettings } from '../state/settings'
import { providerAvailability, providerLabel, setInteractiveChatProvider, useInteractiveChatProvider, useNativeProviderAvailability, type InteractiveChatProvider } from '../state/chatProviders'
import { resetUiCustomization, setUiCustomization, UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP, useUiCustomization } from '../state/uiCustomization'
import { RecipeSettings } from './RecipeSettings'
import appPackage from '../../package.json'
import { setNotificationPreferences, useNotificationPreferences, SOUND_NAMES, type SoundEvent, type SoundName } from '../state/notificationPreferences'
import { previewSound } from '../lib/sounds'
import { abbreviatePath } from '../lib/abbreviatePath'
import { clearAllPaneNotifications, usePaneNotifications } from '../state/paneNotifications'
import { checkForUpdates, downloadUpdate, setCheckForUpdatesOnLaunch, useAppUpdate, useCheckForUpdatesOnLaunch, type UpdateState, prepareUpdate, restartToUpdate } from '../state/appUpdate'

function updateSummary(update: UpdateState): string {
  switch (update.status) {
    case 'idle': return 'Not checked yet'
    case 'checking': return 'Checking…'
    case 'current': return update.info.latest ? `Up to date (latest release is ${update.info.latest})` : 'No published release found'
    case 'available': return `${update.info.latest} is available`
    case 'downloading': return `Downloading ${update.info.latest}…`
    case 'downloaded': return `${update.info.latest} downloaded and opened in Finder`
    case 'preparing': return `Downloading and checking ${update.info.latest}…`
    case 'ready': return `${update.info.latest} is ready to install`
    case 'error': return 'Could not check'
  }
}

const RELEASE_NOTES_URL = 'https://github.com/Erscheinung/Beads-Station-/releases'

const sectionKeywords: Record<string, string> = { General: 'workspace developer explorer board', Appearance: 'theme colors match system appearance light dark auto designer developer interface scale density compact comfortable reset font size line height', Terminal: 'typed command colour color orange prompt zsh highlight font size line height cursor blink scrollback history split unsplit zoom close nerd icons editing shortcuts command arrow option click shift enter', Notifications: 'pane notification ring bell done finished waiting attention auto switch dock badge quiet sound sounds audio volume chime subagent responded alert mute', 'Keyboard shortcuts': 'commands bindings keys reset terminal pane focus switch resize fullscreen arrow tiling', Sessions: 'handoff note budget limit context percent prompt journal history crash lost backup obsidian vault notes pinned claude codex provider chat resume agents confirm confirmation destructive close launch command flags yolo skip permissions', Recipes: 'recording replay interaction recipe steps binding import export undo', About: 'version release build beads station update download check' }
const sections = ['General', 'Appearance', 'Terminal', 'Notifications', 'Keyboard shortcuts', 'Sessions', 'Recipes', 'About'] as const
const TERMINAL_PANE_COMMAND_IDS = new Set([
  'fullscreen',
  'focusLeft',
  'focusRight',
  'focusUp',
  'focusDown',
  'resizeLeft',
  'resizeRight',
  'resizeUp',
  'resizeDown',
  'terminalFontLarger',
  'terminalFontSmaller',
  'terminalFontReset',
])
export function SettingsPanel() {
  const open = useSettingsOpen()
  const dialog = useRef<HTMLDialogElement>(null)
  const [section, setSection] = useState<typeof sections[number]>('General')
  const [search, setSearch] = useState('')
  const [recording, setRecording] = useState<string | null>(null)
  const [systemDenied, setSystemDenied] = useState(false)
  const [crashLog, setCrashLog] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    invoke<string | null>('app_last_crash').then(value => setCrashLog(typeof value === 'string' ? value : null)).catch(() => {})
  }, [open])
  const agentHooks = useAgentHooks()
  const [error, setError] = useState('')
  const bindings = useCommandBindings()
  const viewThemes = useViewThemes()
  const [themeView, setThemeView] = useState<Skin>(getSkin)
  const palette = viewThemes[themeView]
  const matchSystem = useMatchSystem()
  const themeToggleMode = useThemeToggleMode()
  const [settingsSearch, setSettingsSearch] = useState('')
  const ui = useUiPreferences()
  const session = useSessionPreferences()
  const interactiveProvider = useInteractiveChatProvider()
  const providerStatuses = useNativeProviderAvailability()
  const appearance = useTerminalAppearance()
  const customization = useUiCustomization()
  const notificationPrefs = useNotificationPreferences()
  const waitingPanes = usePaneNotifications().size
  const update = useAppUpdate()
  const checkOnLaunch = useCheckForUpdatesOnLaunch()
  const visibleCommands = COMMANDS.filter(c => c.label.toLowerCase().includes(search.toLowerCase()))
  const terminalPaneCommands = visibleCommands.filter(c => TERMINAL_PANE_COMMAND_IDS.has(c.id))
  const otherCommands = visibleCommands.filter(c => !TERMINAL_PANE_COMMAND_IDS.has(c.id))
  const renderShortcut = (c: (typeof COMMANDS)[number]) => <div className="bs-settings__row" key={c.id}>
    <span>{c.label}</span>
    <div className="bs-settings__binding">
      <button aria-label={`Shortcut for ${c.label}`} onClick={() => { setRecording(c.id); setError('') }} onKeyDown={e => {
        // Handle keyboard activation on keydown so the capture state is
        // visible immediately, including in WebViews that do not synthesize
        // a button click until after their focus transition.
        if (recording !== c.id && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          setRecording(c.id)
          setError('')
        }
      }}>
        <kbd>{recording === c.id ? 'Press shortcut…' : shortcutLabel(bindings[c.id]) || 'Not set'}</kbd>
        {recording !== c.id && <span className="bs-settings__change-binding">{bindings[c.id] ? 'Change' : 'Set'}</span>}
      </button>
      <button aria-label={`Clear shortcut for ${c.label}`} disabled={!bindings[c.id]} onClick={() => { setBinding(c.id, ''); setRecording(current => current === c.id ? null : current); setError('') }}>Clear</button>
    </div>
  </div>

  // Shortcut capture must not depend on the recorder button retaining focus.
  // macOS can move focus while a Command chord is being delivered (and the
  // dialog's focus handling can do the same when it is opened from a menu).
  // Listen in the capture phase for the duration of a recording so the chord
  // is consumed before xterm, the global vim keymap, or another focused input
  // can claim it. This also makes pointer and keyboard activation equivalent.
  useEffect(() => {
    if (!recording) return
    const onRecordingKeyDown = (event: KeyboardEvent) => {
      // Plain Tab cancels capture and keeps dialog focus traversal usable.
      // With Command or Control it is a chord like any other.
      if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey) {
        setRecording(null)
        setError('')
        event.stopPropagation()
        return
      }

      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape') {
        setRecording(null)
        setError('')
        return
      }

      // A modifier by itself is not a shortcut. Keep the visible recording
      // state while waiting for the non-modifier key, without showing a
      // misleading validation error or leaking the modifier to the app.
      if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return

      const binding = eventBinding(event)
      if (!binding) {
        setError('Include Command or Control in the shortcut.')
        return
      }

      const failure = setBinding(recording, binding)
      setError(failure || '')
      if (!failure) setRecording(null)
    }
    window.addEventListener('keydown', onRecordingKeyDown, true)
    return () => window.removeEventListener('keydown', onRecordingKeyDown, true)
  }, [recording])

  // Closing the dialog must always end an in-progress capture. Otherwise a
  // later reopen can show a stale "Press shortcut…" state with no visible
  // recorder button to own the key events.
  useEffect(() => {
    if (!open) {
      setRecording(null)
      setError('')
    }
  }, [open])
  useEffect(() => {
    let disposed = false
    let release: (() => void) | undefined
    void safeListen('settings:open', openSettings).then(unlisten => { if (disposed) unlisten(); else release = unlisten }).catch(() => {})
    return () => { disposed = true; release?.() }
  }, [])
  useEffect(() => {
    const onOpenRecipes = () => setSection('Recipes')
    const onShowAbout = () => setSection('About')
    window.addEventListener('recipes:open', onOpenRecipes)
    window.addEventListener('settings:show-about', onShowAbout)
    return () => {
      window.removeEventListener('recipes:open', onOpenRecipes)
      window.removeEventListener('settings:show-about', onShowAbout)
    }
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
          <label className="bs-settings__row"><span>Toggle theme goes<small>"Toggle theme" in the palette moves to the next theme in the list, or shuffles through all of them without repeating one until each was shown.</small></span><select aria-label="Toggle theme goes" value={themeToggleMode} onChange={e => setThemeToggleMode(e.target.value as ThemeToggleMode)}><option value="series">In order</option><option value="shuffle">Shuffle</option></select></label>
          <label className="bs-settings__row"><span>Match system appearance<small>Follow macOS light and dark mode live, using the two themes below for every view.</small></span><input aria-label="Match system appearance" type="checkbox" checked={matchSystem.enabled} onChange={e => setMatchSystem({ enabled: e.target.checked })} /></label>
          {matchSystem.enabled && <>
            <label className="bs-settings__row"><span>Light mode theme</span><select aria-label="Light mode theme" value={matchSystem.light} onChange={e => setMatchSystem({ light: e.target.value })}>{BUNDLED_THEMES.filter(t => paletteAppearance(t) === 'light').map(t => <option key={t.name} value={t.name}>{t.name.replace(/-/g, ' ')}</option>)}</select></label>
            <label className="bs-settings__row"><span>Dark mode theme</span><select aria-label="Dark mode theme" value={matchSystem.dark} onChange={e => setMatchSystem({ dark: e.target.value })}>{BUNDLED_THEMES.filter(t => paletteAppearance(t) === 'dark').map(t => <option key={t.name} value={t.name}>{t.name.replace(/-/g, ' ')}</option>)}</select></label>
            <p className="bs-settings__note">While this is on, the choices below are kept but not shown.</p>
          </>}
          <p className="bs-settings__note">Developer: {viewThemes.terminal} · Designer: {viewThemes.designer}</p>
          <div className="bs-settings__themes">{BUNDLED_THEMES.map(t => <button key={t.name} className="bs-theme-preview" aria-pressed={palette === t.name} onClick={() => setThemePalette(t.name, themeView)}>
            <span className="bs-theme-preview__sample" style={{ background: t.background, color: t.foreground }}><span style={{ color: t.green }}>&gt;</span> beads station<span className="bs-theme-preview__swatches">{[t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan].map((color, i) => <i key={i} style={{ background: color }} />)}</span></span>
            <span>{t.name.replace(/-/g, ' ')}{palette === t.name ? ' · selected' : ''}</span>
          </button>)}</div>
          <button onClick={() => setThemePalette(DEFAULT_THEME_ID, themeView)}>Reset this view’s theme</button>
          <div className="bs-settings__customization" aria-labelledby="interface-customization-title">
            <h4 id="interface-customization-title">Interface</h4>
            <p className="bs-settings__note">Adjusts application chrome text and spacing. Terminal canvas measurement and terminal font settings stay independent.</p>
            <label className="bs-settings__row" htmlFor="interface-scale">
              <span>Interface scale<small>Choose a comfortable reading size for menus, tabs and other application chrome.</small></span>
              <span className="bs-settings__range-control"><input id="interface-scale" aria-label="Interface scale" type="range" min={UI_SCALE_MIN} max={UI_SCALE_MAX} step={UI_SCALE_STEP} value={customization.interfaceScale} onChange={e => setUiCustomization({ interfaceScale: Number(e.currentTarget.value) })} /><output htmlFor="interface-scale">{customization.interfaceScale}%</output></span>
            </label>
            <label className="bs-settings__row" htmlFor="interface-density">
              <span>Interface density<small>Compact uses less spacing; comfortable keeps more room between controls.</small></span>
              <select id="interface-density" aria-label="Interface density" value={customization.density} onChange={e => setUiCustomization({ density: e.currentTarget.value as typeof customization.density })}>
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </select>
            </label>
            <button onClick={resetUiCustomization}>Reset interface customization</button>
          </div>
        </>}
        {(section === 'Appearance' || section === 'Terminal') && <>
          {section === 'Terminal' && <p className="bs-settings__intro">Changes apply to existing shells in both views. Applications such as Neovim can override the cursor.</p>}
          <label className="bs-settings__row"><span>Terminal font<small>Nerd Font icons (LazyVim, prompts, file trees) are bundled and work with every choice.</small></span><select value={appearance.fontFamily} onChange={e => setTerminalAppearance({ fontFamily: e.target.value })}>{TERMINAL_FONTS.map(f => <option key={f}>{f}</option>)}</select></label>
          <label className="bs-settings__row"><span>Font size<small>{[bindings.terminalFontLarger, bindings.terminalFontSmaller, bindings.terminalFontReset].filter(Boolean).map(shortcutLabel).join(' · ') || 'Shortcuts can be set under Keyboard shortcuts.'}</small></span><input aria-label="Font size" type="number" min="10" max="24" value={appearance.fontSize} onChange={e => { const n = Number(e.target.value); if (n >= 10 && n <= 24) setTerminalAppearance({ fontSize: n }) }} /></label>
          <label className="bs-settings__row"><span>Line height</span><input aria-label="Line height" type="number" min="1" max="1.8" step="0.1" value={appearance.lineHeight} onChange={e => { const n = Number(e.target.value); if (n >= 1 && n <= 1.8) setTerminalAppearance({ lineHeight: n }) }} /></label>
        </>}
        {section === 'Terminal' && <>
          <label className="bs-settings__row"><span>Cursor shape</span><select aria-label="Cursor shape" value={appearance.cursorStyle} onChange={e => setTerminalAppearance({ cursorStyle: e.target.value as 'block' | 'bar' | 'underline' })}><option value="block">Block</option><option value="bar">Bar</option><option value="underline">Underline</option></select></label>
          <label className="bs-settings__row"><span>Blink cursor</span><input aria-label="Blink cursor" type="checkbox" checked={appearance.cursorBlink} onChange={e => setTerminalAppearance({ cursorBlink: e.target.checked })} /></label>
          <label className="bs-settings__row"><span>Scrollback lines<small>More history uses more memory per terminal. Reducing this trims older output.</small></span><input aria-label="Scrollback lines" type="number" min="100" max="50000" step="100" value={appearance.scrollback} onChange={e => setTerminalAppearance({ scrollback: Number(e.target.value) })} /></label>
          <label className="bs-settings__row"><span>Typed command colour<small>Colours what you type at the prompt so it stands apart from output. Applies to new shells only; open a new pane to see a change. If you use zsh-syntax-highlighting or similar, its own colours win over this.</small></span><span className="bs-settings__range-control"><select aria-label="Typed command colour" value={appearance.cmdColorMode} onChange={e => setTerminalAppearance({ cmdColorMode: e.target.value as CmdColorMode })}><option value="theme">Theme default ({resolveCmdColor({ ...appearance, cmdColorMode: 'theme' }) ?? 'none'})</option><option value="custom">Custom</option><option value="off">Off</option></select>{appearance.cmdColorMode === 'custom' && <input aria-label="Typed command colour hex" type="text" size={8} maxLength={7} defaultValue={appearance.cmdColorCustom} aria-invalid={!HEX_COLOR.test(appearance.cmdColorCustom)} onChange={e => { if (HEX_COLOR.test(e.target.value)) setTerminalAppearance({ cmdColorCustom: e.target.value }) }} />}{resolveCmdColor(appearance) && <i aria-hidden="true" style={{ background: resolveCmdColor(appearance)!, width: 14, height: 14, borderRadius: 3, display: 'inline-block' }} />}</span></label>
          <label className="bs-settings__row"><span>Copy on select<small>Finishing a mouse selection copies it. Hold Option while dragging to select inside Claude Code, Codex or Neovim when they capture the mouse. Cmd+C and Cmd+V always work.</small></span><input aria-label="Copy on select" type="checkbox" checked={appearance.copyOnSelect} onChange={e => setTerminalAppearance({ copyOnSelect: e.target.checked })} /></label>
          <label className="bs-settings__row"><span>macOS editing shortcuts<small>Cmd+Left/Right moves to line start/end, Cmd+Backspace deletes to line start, Cmd+Delete to line end, Option+Delete deletes the next word, Cmd+Up/Down scrolls to top/bottom, Shift+Enter adds a newline in Claude and Codex prompts. Option+Left/Right, Option+Backspace and Option-click to move the cursor always work. App shortcuts win when both match.</small></span><input aria-label="macOS editing shortcuts" type="checkbox" checked={appearance.macEditingKeys} onChange={e => setTerminalAppearance({ macEditingKeys: e.target.checked })} /></label>
          <p className="bs-settings__note">Unsplit to tabs keeps every session running. Close pane stops the selected shell or agent. Zoom temporarily fills the terminal area with one pane.</p>
          <button onClick={resetTerminalAppearance}>Restore terminal defaults</button>
        </>}
        {section === 'Notifications' && <>
          <p className="bs-settings__intro">A pane that finishes or needs you gets a yellow ring, and its terminal tab and workspace tab get a dot, until you focus it.</p>
          <label className="bs-settings__row"><span>Pane notifications<small>Triggered by the terminal bell, by OSC 9 / 99 / 777 notification sequences, and by an agent pane finishing a turn.</small></span><input aria-label="Pane notifications" type="checkbox" checked={notificationPrefs.enabled} onChange={e => setNotificationPreferences({ enabled: e.target.checked })} /></label>
          <label className="bs-settings__row"><span>Notify when a background terminal goes quiet<small>Marks a pane you are not looking at when it stops printing after at least four seconds of continuous output. This is how Claude Code, Codex and long builds are noticed without any setup; turn it off if a chatty process causes false alarms.</small></span><input aria-label="Notify when a background terminal goes quiet" type="checkbox" disabled={!notificationPrefs.enabled} checked={notificationPrefs.notifyOnQuiet} onChange={e => setNotificationPreferences({ notifyOnQuiet: e.target.checked })} /></label>
          <label className="bs-settings__row"><span>Switch to the pane that notified<small>Opens its workspace and tab and focuses it. Waits until you have stopped typing and no dialog is open, so keystrokes never land in the wrong pane.</small></span><input aria-label="Switch to the pane that notified" type="checkbox" disabled={!notificationPrefs.enabled} checked={notificationPrefs.autoSwitch} onChange={e => setNotificationPreferences({ autoSwitch: e.target.checked })} /></label>
          <div className="bs-settings__row"><span>Exact signals from Claude Code<small>Claude Code can tell a pane the moment it needs you or finishes, which conversation it is running (so a restart reopens that exact one), and how full its context and usage limits are. Sessions Beads Station starts for you already do this. Turn this on for <code>claude</code> you type yourself: it adds four hooks to <code>~/.claude/settings.json</code> and wraps your status line so it keeps showing exactly what it shows now (a backup is kept beside it; removing puts your status line back as it was). None of it does anything outside Beads Station. Codex reports a finished turn when started with <code>-c tui.notifications=true</code>.{agentHooks.error ? ` ${agentHooks.error}` : ''}</small></span><button aria-label="Exact signals from Claude Code" aria-pressed={agentHooks.installed} onClick={() => void setAgentHooksInstalled(!agentHooks.installed)}>{agentHooks.installed ? 'Remove hooks' : 'Add hooks'}</button></div>
          <label className="bs-settings__row"><span>macOS notifications in the background<small>When Beads Station is not the front app, a waiting pane also posts to Notification Center. macOS asks for permission the first time you turn this on.{systemDenied ? ' Permission was not granted; allow Beads Station under System Settings → Notifications.' : ''}</small></span><input aria-label="macOS notifications in the background" type="checkbox" disabled={!notificationPrefs.enabled} checked={notificationPrefs.systemNotifications} onChange={e => {
            if (!e.target.checked) { setNotificationPreferences({ systemNotifications: false }); return }
            void ensureSystemNotificationPermission().then(granted => { setSystemDenied(!granted); setNotificationPreferences({ systemNotifications: granted }) })
          }} /></label>
          <label className="bs-settings__row"><span>Show the count on the Dock icon</span><input aria-label="Show the count on the Dock icon" type="checkbox" disabled={!notificationPrefs.enabled} checked={notificationPrefs.dockBadge} onChange={e => setNotificationPreferences({ dockBadge: e.target.checked })} /></label>
          <h4>Sounds</h4>
          {([['waiting', 'Waiting for you', 'An agent asks a question, needs permission, or rings the terminal bell.'], ['responded', 'Agent responded', 'A turn finished or a background terminal went quiet after working.'], ['subagent', 'Subagent finished', 'Claude Code reports a subagent is done (needs the exact signals above).']] as [SoundEvent, string, string][]).map(([event, label, hint]) => (
            <div key={event} className="bs-settings__row"><span>{label}<small>{hint}</small></span>
              <input aria-label={`Sound: ${label}`} type="checkbox" checked={notificationPrefs.sounds[event].enabled} onChange={e => setNotificationPreferences({ sounds: { ...notificationPrefs.sounds, [event]: { ...notificationPrefs.sounds[event], enabled: e.target.checked } } })} />
              <select aria-label={`Sound choice: ${label}`} value={notificationPrefs.sounds[event].sound} onChange={e => setNotificationPreferences({ sounds: { ...notificationPrefs.sounds, [event]: { ...notificationPrefs.sounds[event], sound: e.target.value as SoundName } } })}>{SOUND_NAMES.map(name => <option key={name} value={name}>{name}</option>)}</select>
              <button aria-label={`Preview sound: ${label}`} onClick={() => previewSound(event)}>▶</button>
            </div>
          ))}
          <label className="bs-settings__row"><span>Sound volume<small>{Math.round(notificationPrefs.sounds.volume * 100)}%</small></span><input aria-label="Sound volume" type="range" min={0} max={100} value={Math.round(notificationPrefs.sounds.volume * 100)} onChange={e => setNotificationPreferences({ sounds: { ...notificationPrefs.sounds, volume: Number(e.target.value) / 100 } })} /></label>
          <label className="bs-settings__row"><span>Only when I'm not looking at that pane<small>Stay silent while this window is focused and the pane is the one on screen.</small></span><input aria-label="Only when I'm not looking at that pane" type="checkbox" checked={notificationPrefs.sounds.onlyWhenAway} onChange={e => setNotificationPreferences({ sounds: { ...notificationPrefs.sounds, onlyWhenAway: e.target.checked } })} /></label>
          <p className="bs-settings__note">{waitingPanes === 0 ? 'No panes are waiting.' : `${waitingPanes} pane${waitingPanes === 1 ? ' is' : 's are'} waiting.`} Jump to the latest one with {shortcutLabel(bindings.notificationJump) || 'the command palette'}, or list them all with {shortcutLabel(bindings.notificationPanel) || 'the command palette'}.</p>
          <button disabled={waitingPanes === 0} onClick={clearAllPaneNotifications}>Clear pane notifications</button>
        </>}
        {section === 'Keyboard shortcuts' && <>
          <p className="bs-settings__note">macOS keeps Command+Tab, Command+Space, Command+` and Command+H for itself, so they cannot be recorded. Control chords work instead (for example Control+Tab), and Control with a single key always goes to the shell.</p>
          <p className="bs-settings__intro">Choose Change beside any action, then press a more comfortable Command or Control shortcut. Leader chords are fixed and listed by context below.</p>
          <input className="bs-settings__search" aria-label="Search shortcuts" placeholder="Search commands…" value={search} onChange={e => setSearch(e.target.value)} />
          {error && <p role="alert">{error}</p>}
          {terminalPaneCommands.length > 0 && <section className="bs-settings__shortcut-group" aria-labelledby="terminal-pane-shortcuts-title">
            <h4 id="terminal-pane-shortcuts-title">Terminal pane controls</h4>
            <p className="bs-settings__note">Fullscreen, move between tiles, and resize the active split. Every shortcut below can be replaced or cleared.</p>
            {terminalPaneCommands.map(renderShortcut)}
          </section>}
          {otherCommands.length > 0 && <section className="bs-settings__shortcut-group" aria-labelledby="application-shortcuts-title">
            <h4 id="application-shortcuts-title">Application shortcuts</h4>
            {otherCommands.map(renderShortcut)}
          </section>}
          {visibleCommands.length === 0 && !'leader'.includes(search.toLowerCase()) && <p role="status">No matching shortcuts</p>}
          {(!search || 'leader'.includes(search.toLowerCase())) && <div className="bs-settings__leaders">
            <h4>Leader chords</h4>
            <p className="bs-settings__note">Space arms the leader in normal mode. Cmd/Ctrl+P arms it from any input. The second key depends on the focused surface.</p>
            {(['global', 'terminal'] as const).map(context => <section key={context} aria-label={`${context} leader chords`}>
              <strong>{context === 'global' ? 'Board, sidebar or chat' : 'Terminal pane'}</strong>
              {LEADER_SHORTCUTS[context].map(h => <div className="bs-settings__leader-row" key={`${context}-${h.key}`}><kbd>&lt;leader&gt; {h.key}</kbd><span>{h.label}</span></div>)}
            </section>)}
          </div>}
          <p className="bs-settings__note">Escape belongs to your editor. Fullscreen terminal focus defaults to Cmd/Ctrl+Shift+Enter and can be rebound above. Existing leader sequences are unchanged.</p>
          <button onClick={() => { resetBindings(); setError('') }}>Restore default shortcuts</button>
        </>}
        {section === 'Sessions' && <>
          <p className="bs-settings__intro">Agents start when you ask them to. Interactive chat uses the selected local adapter.</p>
          <label className="bs-settings__row"><span>Restore saved context on launch<small>Restores workspaces, layout, selected panes and bounded screen context. It never attaches a live process or starts a provider turn.</small></span><input aria-label="Restore saved context on launch" type="checkbox" checked={session.restoreContextOnLaunch} onChange={e => setSessionPreferences({ restoreContextOnLaunch: e.target.checked })} /></label>
          <label className="bs-settings__row"><span>Keep terminals running when Beads Station quits (experimental)<small>Shells started after you turn this on live in a small background process instead of the app. Quitting, a crash or an update leaves them running, with Claude Code, Codex or a dev server still inside, and the next launch reattaches each pane with its history. They do not survive logging out or restarting the Mac; then a pane falls back to its saved screen and the resume offer. Closing a pane or workspace still stops its shell.</small></span><input aria-label="Keep terminals running when Beads Station quits" type="checkbox" checked={session.keepTerminalsRunning} onChange={e => setSessionPreferences({ keepTerminalsRunning: e.target.checked })} /></label>
          <label className="bs-settings__row"><span>Start agents in<small>A terminal pane runs the real CLI beside your other panes. The chat panel is the older view at the bottom of the window.</small></span><select aria-label="Start agents in" value={session.chatSurface} onChange={e => setSessionPreferences({ chatSurface: e.target.value === 'panel' ? 'panel' : 'terminal' })}><option value="terminal">Terminal pane</option><option value="panel">Chat panel</option></select></label>
          <label className="bs-settings__row"><span>Claude Code command<small>Typed into the new pane exactly as written: <code>claude</code>, a shell alias, or flags such as <code>claude --dangerously-skip-permissions</code>. Also used to continue a restored conversation.</small></span><input aria-label="Claude Code command" spellCheck={false} value={session.claudeCommand} onChange={e => setSessionPreferences({ claudeCommand: e.target.value })} /></label>
          <label className="bs-settings__row"><span>Codex command<small>For example <code>codex --yolo</code>.</small></span><input aria-label="Codex command" spellCheck={false} value={session.codexCommand} onChange={e => setSessionPreferences({ codexCommand: e.target.value })} /></label>
          <label className="bs-settings__row"><span>Gemini command<small>The top bar's Gemini button types this, for example <code>gemini</code> or your own alias.</small></span><input aria-label="Gemini command" spellCheck={false} value={session.geminiCommand} onChange={e => setSessionPreferences({ geminiCommand: e.target.value })} /></label>
          <label className="bs-settings__row"><span>Editor command<small>Cmd+click on a file path in a terminal, and "Open in editor" elsewhere, type this with the file after it. Default <code>nvim</code>.</small></span><input aria-label="Editor command" spellCheck={false} value={session.editorCommand} onChange={e => setSessionPreferences({ editorCommand: e.target.value })} /></label>
          <label className="bs-settings__row"><span>Obsidian vault folder<small>Optional. A folder of markdown notes, for example <code>~/Documents/MyVault</code>. Pinned lists its notes and shows a chosen one formatted, read-only. Nothing is copied or changed, and only this folder is read.</small></span><input aria-label="Obsidian vault folder" spellCheck={false} placeholder="~/Documents/MyVault" value={session.obsidianVaultPath} onChange={e => setSessionPreferences({ obsidianVaultPath: e.target.value })} /></label>
          <label className="bs-settings__row"><span>Save a handoff note at … % used<small>When an agent's context or 5-hour limit reaches this, Beads Station writes a markdown note (goal, recent prompts, plan, changed files, resume command) to a Handoffs folder in your vault or notes folder and pins it. No model is asked. 0 turns it off.</small></span><input aria-label="Save a handoff note at percent used" type="number" min={0} max={100} step={1} value={session.handoffThreshold} onChange={e => setSessionPreferences({ handoffThreshold: Math.min(100, Math.max(0, Math.round(Number(e.target.value) || 0))) })} /></label>
          <label className="bs-settings__row"><span>Keep a journal of prompts I send to agents<small>Every prompt you submit in a Claude, Codex or Gemini pane is appended in full to a file in the app's data folder, so a crash or restart never loses a long one. Plain shells are never recorded. Open it from the command palette.</small></span><input aria-label="Keep a journal of prompts I send to agents" type="checkbox" checked={session.journalPrompts} onChange={e => setSessionPreferences({ journalPrompts: e.target.checked })} /></label>
          <label className="bs-settings__row"><span>Continue agent sessions automatically<small>Off: a restored Claude or Codex pane shows its conversation and waits for Enter. On: when such a pane is shown and its exact conversation is known, Beads Station starts a shell and reopens the CLI on it without asking. This starts a process per pane; whether reopening alone uses tokens has not been measured, and your next message is sent with the whole conversation as context.</small></span><input aria-label="Continue agent sessions automatically" type="checkbox" checked={session.autoResumeAgents} onChange={e => setSessionPreferences({ autoResumeAgents: e.target.checked })} /></label>
          <label className="bs-settings__row"><span>Interactive chat provider<small>Choose a supported provider for the developer chat pane. Availability checks only whether its CLI is installed; login stays owned by that CLI.</small></span><select aria-label="Interactive chat provider" value={interactiveProvider} onChange={e => setInteractiveChatProvider(e.target.value as InteractiveChatProvider)}>
            {(['claude', 'codex'] as const).map(name => {
              const status = providerAvailability(providerStatuses, name)
              const suffix = providerStatuses === null ? 'checking…' : status?.available ? 'available' : 'unavailable'
              return <option key={name} value={name} disabled={providerStatuses !== null && status?.available !== true}>{providerLabel(name)} ({suffix})</option>
            })}
          </select></label>
          {providerStatuses === null
            ? <p className="bs-settings__note" role="status">Checking supported local chat providers…</p>
            : <p className="bs-settings__note">Unavailable providers stay visible so a missing CLI is clear; they cannot be selected until installed.</p>}
          <label className="bs-settings__row"><span>Ask before resuming Claude<small>When starting chat, offer a choice for a previously observed Claude session. Turn off to resume it directly.</small></span><input type="checkbox" checked={session.askBeforeResume} onChange={e => setSessionPreferences({ askBeforeResume: e.target.checked })} /></label>
          <label className="bs-settings__row"><span>Confirm destructive actions<small>Ask before closing panes, workspaces, or the app. You can also choose “Don’t ask again” on a confirmation.</small></span><input aria-label="Confirm destructive actions" type="checkbox" checked={session.confirmDestructiveActions} onChange={e => setSessionPreferences({ confirmDestructiveActions: e.target.checked })} /></label>
          <p className="bs-settings__note">Opening a folder does not start an agent. A saved conversation is not proof of a running process; a session removed by Claude may no longer be resumable.</p>
        </>}
        {section === 'Recipes' && <RecipeSettings />}
        {section === 'About' && <>
          <p className="bs-settings__intro">Beads Station is a terminal-first workspace for local development.</p>
          <dl className="bs-settings__about">
            <div><dt>Version</dt><dd data-testid="app-version">v{appPackage.version}</dd></div>
            <div><dt>Build</dt><dd>Preview</dd></div>
            <div><dt>Updates</dt><dd data-testid="update-status" role="status">{updateSummary(update)}</dd></div>
          </dl>
          {update.status === 'error' && <p role="alert">{update.message}</p>}
          {update.status === 'ready' && <p className="bs-settings__note">The new version was downloaded, matched its published SHA-256 and signature check, and is waiting next to the installed app. Restart to update asks before closing your terminals and agents, then replaces the app and opens it again. Settings and shortcuts are kept. Nothing changes until you restart.</p>}
          {update.status === 'downloaded' && <p className="bs-settings__note">Saved to {abbreviatePath(update.path)}{update.checksumVerified ? ' (SHA-256 verified)' : ' (no published checksum to verify)'}. Quit Beads Station after saving your work, then drag the new app into Applications. Settings and shortcuts are kept.</p>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => void openUrl(RELEASE_NOTES_URL)}>Release notes</button>
            <button disabled={update.status === 'checking' || update.status === 'downloading' || update.status === 'preparing' || update.status === 'ready'} onClick={() => void checkForUpdates()}>Check for updates</button>
            {(update.status === 'available' || (update.status === 'error' && update.info?.newer)) && update.info?.asset && <>
              <button onClick={() => void prepareUpdate()}>Install {update.info.latest}</button>
              <button onClick={() => void downloadUpdate()}>Download only</button>
            </>}
            {update.status === 'ready' && <button onClick={() => void restartToUpdate()}>Restart to update</button>}
          </div>
          <label className="bs-settings__row"><span>Check for updates when the app starts<small>Reads this project’s GitHub releases once per launch. Nothing is installed automatically.</small></span><input aria-label="Check for updates when the app starts" type="checkbox" checked={checkOnLaunch} onChange={e => setCheckForUpdatesOnLaunch(e.target.checked)} /></label>
          {crashLog && <details className="bs-settings__note"><summary>Recent problems the app recovered from</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'text', WebkitUserSelect: 'text' }}>{crashLog}</pre></details>}
          <p className="bs-settings__note">This version is read from the application package metadata used to build the frontend.</p>
        </>}
      </main>
    </div>
  </dialog>, document.body)
}
