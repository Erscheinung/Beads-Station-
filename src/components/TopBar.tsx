// One top bar for both skins.
//
//   [mark] Terminal | Designer: Requests Session History Pinned ...   <context>   [claude][codex][gemini]   <status>  [search] [keys] [gear]
//
// The left strip is a list of places: the Terminal and every Designer view, so
// any of them is one click (or one palette entry, or one shortcut) from
// anywhere. The launchers start a CLI in a new terminal pane, on a click only.

import type { ReactNode } from 'react'
import { ProviderMarkPath } from './ProviderMark'
import { DESIGNER_VIEWS, getDesignerView, openDesignerView, useDesignerView } from '../state/designerNav'
import { setSkin, type Skin } from '../state/skin'
import { LAUNCHERS, agentLaunchCommand, useSessionPreferences, type LauncherId } from '../state/sessionPreferences'
import { agentStartCommand } from '../state/agentHooks'
import { launchInTerminalPane, typeIntoActiveShell } from '../state/termPanes'
import { setFocused } from '../state/vim'
import { openPalette } from '../state/palette'
import { openSettings } from '../state/settings'
import { shortcutLabel, useCommandBindings } from '../state/commands'

// Marks live in ProviderMark.tsx so the Designer views use the same ones.

/** The line typed into the new pane for a launcher. Claude and Codex also get the app's waiting signals. */
export function launcherCommand(id: LauncherId): string {
  return id === 'gemini' ? agentLaunchCommand('gemini') : agentStartCommand(id)
}

/** Start a CLI in a new pane beside the active one. Only ever called from an explicit click or command. */
export function startLauncher(id: LauncherId): void {
  setSkin('terminal')
  launchInTerminalPane(launcherCommand(id))
  setFocused('terminal')
  typeIntoActiveShell()
}

export interface LauncherOverride {
  /** Accessible name; defaults to "Start <CLI> chat". */
  label?: string
  disabled?: boolean
  title?: string
  onStart?: () => void
}

export function TopBar({ skin, context, status, launchers }: {
  skin: Skin
  /** Controls that belong to the current skin (layout picker, tier toggle). */
  context?: ReactNode
  /** Transient status buttons (waiting panes, update available). */
  status?: ReactNode
  launchers?: Partial<Record<LauncherId, LauncherOverride>>
}) {
  const view = useDesignerView()
  const bindings = useCommandBindings()
  // Re-render when a launcher command changes: it is shown in the tooltip.
  useSessionPreferences()
  const hint = (id: string) => bindings[id] ? ` (${shortcutLabel(bindings[id])})` : ''

  return <header className="bs-toolbar bs-topbar bs-app-chrome" data-skin={skin}>
    <span className="bs-topbar__mark" title="Beads Station" aria-hidden />
    <nav className="bs-topbar__places" aria-label="Views">
      <button className="bs-topbar__place" aria-pressed={skin === 'terminal'} onClick={() => setSkin('terminal')} title={`Terminal${hint('toggleSkin')}`}>
        <span className="codicon codicon-terminal" aria-hidden /> Terminal
      </button>
      <span className="bs-topbar__sep" aria-hidden />
      <button className="bs-topbar__place bs-topbar__place--group" aria-pressed={skin === 'designer'} onClick={() => openDesignerView(getDesignerView())} title={`Designer: back to the view you last used${hint('toggleSkin')}`}>Designer</button>
      {DESIGNER_VIEWS.map(item => (
        <button
          key={item.id}
          className="bs-topbar__place bs-topbar__place--view"
          aria-pressed={skin === 'designer' && view === item.id}
          title={`${item.purpose}${hint(`designer.${item.id}`)}`}
          onClick={() => openDesignerView(item.id)}
        >{item.label}</button>
      ))}
    </nav>
    {context && <div className="bs-topbar__context">{context}</div>}
    <span className="bs-topbar__spacer" />
    <div className="bs-topbar__launchers" role="group" aria-label="Start an agent in a new pane">
      {LAUNCHERS.map(({ id, label }) => {
        const override = launchers?.[id]
        return <button
          key={id}
          className={`bs-topbar__launcher bs-topbar__launcher--${id}`}
          aria-label={override?.label ?? `Start ${label} chat`}
          title={override?.title ?? `Start ${label} in a new pane: ${agentLaunchCommand(id)}`}
          disabled={override?.disabled}
          onClick={override?.onStart ?? (() => startLauncher(id))}
        ><svg className="bs-topbar__glyph" viewBox="0 0 16 16" width="14" height="14" aria-hidden><ProviderMarkPath id={id} /></svg><span className="bs-topbar__launcher-name" aria-hidden>{label}</span></button>
      })}
    </div>
    {status}
    <button className="bs-topbar__icon" aria-label="Commands" title="Open command palette" onClick={openPalette}><span className="codicon codicon-search" aria-hidden /><kbd>{shortcutLabel(bindings.palette)}</kbd></button>
    <button className="bs-topbar__icon" aria-label="Shortcut cheat sheet" title={`Every keyboard shortcut on one screen${hint("shortcuts")}`} onClick={() => window.dispatchEvent(new Event('shortcuts:open'))}><span className="codicon codicon-keyboard" aria-hidden /></button>
    <button className="bs-topbar__icon" aria-label="Settings" title="Open settings" onClick={openSettings}><span className="codicon codicon-settings-gear" aria-hidden /></button>
  </header>
}
