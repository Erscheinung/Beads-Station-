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

// ---------- File paths: Command+click opens them in the editor ----------

export interface FileMatch extends PathMatch {
  /** The path alone, without any :line:col suffix. */
  path: string
  line: number | null
  col: number | null
}

const FILE_PATH = /(?<![\w:/@.~-])((?:~\/|\.{1,2}\/|\/)?[\w@+.-]+(?:\/[\w@+.-]+)*\.[A-Za-z][A-Za-z0-9]{0,9})(?::(\d+)(?::(\d+))?)?(?![\w/-]|\.\w)/g

// A bare name with no folder is only a file when its ending says so: "e.g",
// "example.com" and "v0.2" are not.
const BARE_FILE_ENDINGS = new Set(('md markdown txt json jsonl yaml yml toml rs ts tsx js jsx mjs cjs css scss html svelte vue py rb go java kt swift c h cc cpp hpp cs sh zsh bash fish lua vim sql xml plist lock log conf ini csv nsh').split(' '))

/** File paths in one line of terminal text, each with an optional `:line[:col]`. URLs are skipped. */
export function findFilePaths(line: string): FileMatch[] {
  const found: FileMatch[] = []
  for (const match of line.matchAll(FILE_PATH)) {
    const path = match[1]
    if (!path.includes('/') && !BARE_FILE_ENDINGS.has(path.slice(path.lastIndexOf('.') + 1).toLowerCase())) continue
    const start = match.index ?? 0
    found.push({
      text: match[0], start, end: start + match[0].length, path,
      line: match[2] ? Number(match[2]) : null,
      col: match[3] ? Number(match[3]) : null,
    })
  }
  return found
}

/**
 * The path to hand to the editor: absolute paths are normalised, `~/…` is left
 * for the shell to expand, and a relative path is joined to `cwd`. Null when a
 * relative path has no absolute folder to stand on.
 */
export function resolveLinkedPath(path: string, cwd: string | null | undefined): string | null {
  if (path === '~' || path.startsWith('~/')) return path
  if (!path.startsWith('/') && !cwd?.startsWith('/')) return null
  const parts: string[] = []
  for (const part of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

function quotePath(path: string): string {
  const quote = (word: string) => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
  // The shell only expands an unquoted leading ~.
  return path.startsWith('~/') ? `~/${quote(path.slice(2))}` : quote(path)
}

const VI_LIKE = new Set(['nvim', 'vim', 'vi'])
const GOTO_STYLE = new Set(['code', 'cursor', 'codium', 'windsurf'])
const COLON_STYLE = new Set(['zed', 'subl', 'hx'])

function editorProgram(editor: string): string {
  const first = editor.trim().split(/\s+/)[0] ?? ''
  return first.slice(first.lastIndexOf('/') + 1)
}

/** True when the foreground program of a pane is an editor that takes `:edit`. */
export function isViProgram(program: string | null | undefined): boolean {
  return VI_LIKE.has(program ?? '')
}

/** True when the configured editor is one whose running instance can be reused with `:edit`. */
export function isViEditor(editor: string): boolean {
  return VI_LIKE.has(editorProgram(editor))
}

/** The shell line that opens a file in the editor, at a line (and column) when given. */
export function editorOpenCommand(editor: string, path: string, line: number | null = null, col: number | null = null): string {
  const program = editorProgram(editor)
  const file = quotePath(path)
  const at = line && line > 0 ? line : null
  if (VI_LIKE.has(program)) {
    if (at && col && col > 0) return `${editor} '+call cursor(${at},${col})' ${file}`
    return at ? `${editor} +${at} ${file}` : `${editor} ${file}`
  }
  const position = at ? `:${at}${col && col > 0 ? `:${col}` : ''}` : ''
  if (GOTO_STYLE.has(program)) return position ? `${editor} --goto ${quotePath(`${path}${position}`)}` : `${editor} ${file}`
  if (COLON_STYLE.has(program)) return `${editor} ${quotePath(`${path}${position}`)}`
  return `${editor} ${file}`
}

/**
 * Keys that open a file in a vi-like editor that is already running: Escape to
 * leave any mode, `:edit`, then the column as a normal-mode motion.
 */
export function viEditKeys(path: string, line: number | null = null, col: number | null = null): string {
  const escaped = path.replace(/([\\ %#|"'$`*?\[\]{}])/g, '\\$1')
  const at = line && line > 0 ? `+${line} ` : ''
  return `\x1b:edit ${at}${escaped}\r${at && col && col > 1 ? `${col}|` : ''}`
}
