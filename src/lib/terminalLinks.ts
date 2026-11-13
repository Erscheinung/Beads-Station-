// Pure helpers for Command+click links in terminal output.

/** Only http and https ever open; javascript:, file:, data: and the rest do not. */
export function isOpenableWebUrl(uri: string): boolean {
  try {
    const url = new URL(uri.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export interface PathMatch { text: string; start: number; end: number }

const MARKDOWN_PATH = /(?<![\w:/@.~-])(?:\.{1,2}\/|\/)?[\w@+.-]+(?:\/[\w@+.-]+)*\.(?:md|markdown)(?![\w/-]|\.\w)/gi

/** Paths in one line of terminal text that end in .md or .markdown. URLs and ~ paths are skipped. */
export function findMarkdownPaths(line: string): PathMatch[] {
  const found: PathMatch[] = []
  for (const match of line.matchAll(MARKDOWN_PATH)) {
    const start = match.index ?? 0
    found.push({ text: match[0], start, end: start + match[0].length })
  }
  return found
}

/** The folder holding a markdown path, resolved against the pane's folder. Null when it cannot be an absolute path. */
export function markdownDirectory(path: string, cwd: string): string | null {
  if (!cwd.startsWith('/') && !path.startsWith('/')) return null
  const joined = path.startsWith('/') ? path : `${cwd}/${path}`
  const parts: string[] = []
  for (const part of joined.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  parts.pop() // the file name
  return `/${parts.join('/')}`
}
