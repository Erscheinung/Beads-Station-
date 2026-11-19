/** Shows the home folder as `~` so the UI (and screenshots) never print a user name. */
export function abbreviatePath(path: string): string {
  const match = path.match(/^\/Users\/[^/]+(\/.*)?$/)
  return match ? '~' + (match[1] ?? '') : path
}

/** Replaces every home-folder path inside a longer text, such as a shell command. */
export function abbreviatePathsIn(text: string): string {
  return text.replace(/\/Users\/[^/\s'"]+/g, '~')
}

/**
 * The path inside a `file://` URL (OSC 7, a dragged `text/uri-list` line), decoded
 * once. Anything that is not a file URL is returned untouched, and a malformed
 * escape leaves the text as it came, so a path is never decoded twice or mangled.
 */
export function fileUrlToPath(text: string): string {
  const match = /^file:\/\/[^/]*(\/.*)$/i.exec(text.trim())
  if (!match) return text
  const raw = match[1].replace(/[?#].*$/, '')
  try { return decodeURIComponent(raw) } catch { return raw }
}
