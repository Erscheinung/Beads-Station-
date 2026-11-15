// A which-key style cheat sheet: every shortcut on one screen, grouped by what
// you are trying to do. Opens with its own shortcut or the keyboard icon in the
// top bar; Escape, a click outside or the same shortcut closes it.

import { useEffect, useState } from 'react'
import { COMMANDS, LEADER_SHORTCUTS, shortcutLabel, useCommandBindings } from '../state/commands'

interface Group { title: string; match: (id: string) => boolean }

const GROUPS: readonly Group[] = [
  { title: 'Go to', match: id => id === 'toggleSkin' || id === 'designer' || id === 'terminal' || id.startsWith('designer.') || id === 'palette' || id === 'settings' || id === 'shortcuts' },
  { title: 'Panes', match: id => /^(focus|resize|split|zoomPane|closePane|fullscreen|unsplit|restoreSplit|joinTabs|browser|files)/.test(id) },
  { title: 'Tabs and workspaces', match: id => /^(terminal(Previous|Next|Move|Select)|workspace|newTab|closeWorkspace)/.test(id) },
  { title: 'Agents', match: id => /^(launch|chatPanel|agent|notification)/.test(id) },
]

export function ShortcutSheet() {
  const [open, setOpen] = useState(false)
  const bindings = useCommandBindings()
  useEffect(() => {
    const toggle = () => setOpen(value => !value)
    window.addEventListener('shortcuts:open', toggle)
    return () => window.removeEventListener('shortcuts:open', toggle)
  }, [])
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])
  if (!open) return null

  const bound = COMMANDS.filter(command => bindings[command.id])
  const taken = new Set<string>()
  const groups = GROUPS.map(group => {
    const rows = bound.filter(command => !taken.has(command.id) && group.match(command.id))
    rows.forEach(command => taken.add(command.id))
    return { title: group.title, rows }
  })
  const other = bound.filter(command => !taken.has(command.id))
  // Nine "select N" rows say one thing.
  const collapse = (rows: typeof bound) => {
    const out: { label: string; keys: string }[] = []
    for (const command of rows) {
      const numbered = /^(.*) (\d)$/.exec(command.label)
      const keys = shortcutLabel(bindings[command.id])
      if (numbered && /\d$/.test(keys)) {
        if (numbered[2] === '1') out.push({ label: `${numbered[1]} 1–9`, keys: keys.replace(/\d$/, '1–9') })
        continue
      }
      out.push({ label: command.label, keys })
    }
    return out
  }

  return <div className="bs-shortcuts__overlay" onMouseDown={() => setOpen(false)}>
    <div className="bs-shortcuts" role="dialog" aria-label="Keyboard shortcuts" onMouseDown={event => event.stopPropagation()}>
      <header><strong>Keyboard shortcuts</strong><span>Change any of these in Settings → Shortcuts · Esc closes</span></header>
      <div className="bs-shortcuts__grid">
        {[...groups, { title: 'Everything else', rows: other }].filter(group => group.rows.length > 0).map(group => (
          <section key={group.title}>
            <h4>{group.title}</h4>
            {collapse(group.rows).map(row => <div className="bs-shortcuts__row" key={row.label}><kbd>{row.keys}</kbd><span>{row.label}</span></div>)}
          </section>
        ))}
        <section>
          <h4>Leader (Space, or Cmd/Ctrl+P from any input)</h4>
          {LEADER_SHORTCUTS.terminal.map(row => <div className="bs-shortcuts__row" key={row.key}><kbd>Space {row.key}</kbd><span>{row.label}</span></div>)}
        </section>
      </div>
    </div>
  </div>
}
