// Code-6w0: Tauri event names may only contain alphanumerics, `-`, `/`, `:`,
// `_`. Project ids are directory basenames (see src-tauri/src/projects.rs), so
// a repo like `All Doors` produces a space that makes every listen()/emit()
// for its channels fail with "invalid args `event` for command `listen`:
// Event name must include only alphanumeric characters, `-`, `/`, `:` and
// `_`." — the chat pane then renders zero frames.
//
// Sanitize the id ONLY where it becomes an event-channel string; map keys and
// command args keep the raw id. Must stay byte-identical to the Rust `chan_id`
// in src-tauri/src/claude.rs so both sides derive the same channel.
export function chanId(id: string): string {
  return id.replace(/[^a-zA-Z0-9\-/:_]/g, '_')
}
