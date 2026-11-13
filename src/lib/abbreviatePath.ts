/** Shows the home folder as `~` so the UI (and screenshots) never print a user name. */
export function abbreviatePath(path: string): string {
  const match = path.match(/^\/Users\/[^/]+(\/.*)?$/)
  return match ? '~' + (match[1] ?? '') : path
}

/** Replaces every home-folder path inside a longer text, such as a shell command. */
export function abbreviatePathsIn(text: string): string {
  return text.replace(/\/Users\/[^/\s'"]+/g, '~')
}
