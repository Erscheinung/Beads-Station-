// The native menu bar sends command ids; they run exactly as the palette runs them.
import { openUrl } from '@tauri-apps/plugin-opener'
import { COMMANDS, dispatchCommand, type CommandId } from '../state/commands'
import { safeListen } from './listenerRegistry'

export function isMenuCommand(id: unknown): id is CommandId {
  return COMMANDS.some(command => command.id === id)
}

export async function installNativeMenu(): Promise<void> {
  await safeListen<string>('menu:command', event => { if (isMenuCommand(event.payload)) dispatchCommand(event.payload) })
  await safeListen<string>('menu:link', event => { void openUrl(event.payload).catch(() => {}) })
}
