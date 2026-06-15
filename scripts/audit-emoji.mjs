#!/usr/bin/env node
// audit-emoji.mjs
//
// Walks src/**/*.{tsx,ts,css} looking for emoji code points outside of
// comments and import statements. Beads Station rule: ZERO emoji glyphs in
// JSX text. Devicons via nerd-font CSS classes are OK.
//
// Emoji ranges scanned (per the Phase-4 worker contract):
//   U+2300–U+23FF  Miscellaneous Technical
//   U+2600–U+27BF  Misc Symbols + Dingbats
//   U+1F000–U+1F2FF Mahjong/Domino/Playing Card/Enclosed Alphanumeric Suppl.
//   U+1F300–U+1F5FF Misc Symbols and Pictographs
//   U+1F600–U+1F64F Emoticons
//   U+1F650–U+1F67F Ornamental Dingbats
//   U+1F680–U+1F6FF Transport and Map Symbols
//   U+1F700–U+1F77F Alchemical Symbols
//   U+1F780–U+1F7FF Geometric Shapes Extended
//   U+1F800–U+1F8FF Supplemental Arrows-C
//   U+1F900–U+1F9FF Supplemental Symbols and Pictographs
//   U+1FA00–U+1FAFF Symbols & Pictographs Extended-A / Chess Symbols
//
// NOT scanned (these are punctuation / geometric shapes used in chrome):
//   U+25BC ▼ down-arrow (used in Terminal collapse toggle)
//   U+203A › single right-pointing angle quote
//
// Outside-comment detection:
//   - line comments  // … to end of line
//   - block comments /* … */ across multiple lines
//   - import lines: any line whose trimmed start is "import " is allowed
//   - everything else (JSX text, attribute strings, identifiers, regexes) is
//     scanned strictly. This is intentionally a coarse-but-good-enough rule.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..')
const SRC_DIR = path.join(ROOT, 'src')

const EXTENSIONS = new Set(['.tsx', '.ts', '.css'])

// Returns true if the given code point sits inside one of the emoji ranges
// listed above.
function isEmojiCodePoint(cp) {
  return (
    (cp >= 0x2300 && cp <= 0x23FF) ||
    (cp >= 0x2600 && cp <= 0x27BF) ||
    (cp >= 0x1F000 && cp <= 0x1F2FF) ||
    (cp >= 0x1F300 && cp <= 0x1FAFF)
  )
}

async function walk(dir) {
  const out = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...(await walk(full)))
    } else if (e.isFile() && EXTENSIONS.has(path.extname(e.name))) {
      out.push(full)
    }
  }
  return out
}

// Build a parallel "is this character inside a comment / import-line" mask
// for the file. We do a single pass with a small state machine.
function buildSkipMask(source) {
  const mask = new Uint8Array(source.length)
  let i = 0
  let inLine = false
  let inBlock = false
  let inString = null // null | "'" | '"' | '`'
  let lineStart = 0

  const isImportLine = (start, end) => {
    // Return true if the trimmed line beginning at `start` (up to `end`
    // exclusive) starts with "import ".
    let p = start
    while (p < end && (source[p] === ' ' || source[p] === '\t')) p++
    return source.startsWith('import ', p) || source.startsWith('import{', p) || source.startsWith('import"', p) || source.startsWith("import'", p)
  }

  // First pass: mark comment regions.
  while (i < source.length) {
    const ch = source[i]
    if (inLine) {
      mask[i] = 1
      if (ch === '\n') inLine = false
      i++
      continue
    }
    if (inBlock) {
      mask[i] = 1
      if (ch === '*' && source[i + 1] === '/') {
        mask[i + 1] = 1
        i += 2
        inBlock = false
        continue
      }
      i++
      continue
    }
    if (inString) {
      // Track string-ness only to avoid mistaking // inside a string for a
      // comment. Don't mark string contents as skip — emoji *inside* string
      // literals are exactly what we want to flag.
      if (ch === '\\' && i + 1 < source.length) { i += 2; continue }
      if (ch === inString) { inString = null; i++; continue }
      i++
      continue
    }
    if (ch === '/' && source[i + 1] === '/') { mask[i] = 1; mask[i + 1] = 1; inLine = true; i += 2; continue }
    if (ch === '/' && source[i + 1] === '*') { mask[i] = 1; mask[i + 1] = 1; inBlock = true; i += 2; continue }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; i++; continue }
    if (ch === '\n') { lineStart = i + 1 }
    i++
  }

  // Second pass: mark import-line regions.
  let p = 0
  while (p < source.length) {
    const nl = source.indexOf('\n', p)
    const end = nl === -1 ? source.length : nl
    if (isImportLine(p, end)) {
      for (let q = p; q < end; q++) mask[q] = 1
    }
    if (nl === -1) break
    p = nl + 1
  }

  // Suppress lineStart unused-warning (not actually used).
  void lineStart
  return mask
}

function lineColOf(source, idx) {
  let line = 1
  let col = 1
  for (let i = 0; i < idx; i++) {
    if (source[i] === '\n') { line++; col = 1 } else { col++ }
  }
  return { line, col }
}

function contextWindow(source, idx, span = 60) {
  const half = Math.floor(span / 2)
  const start = Math.max(0, idx - half)
  const end = Math.min(source.length, idx + half)
  return source.slice(start, end).replace(/\n/g, '\\n')
}

async function main() {
  let files
  try {
    files = await walk(SRC_DIR)
  } catch (e) {
    console.error(`audit-emoji: cannot read ${SRC_DIR}: ${e.message}`)
    process.exit(1)
  }

  const violations = []
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8')
    const skip = buildSkipMask(source)

    // Iterate by code point; a high surrogate pair occupies indices i and i+1.
    let i = 0
    while (i < source.length) {
      const cp = source.codePointAt(i)
      const len = cp > 0xFFFF ? 2 : 1
      if (!skip[i] && isEmojiCodePoint(cp)) {
        const { line, col } = lineColOf(source, i)
        violations.push({
          file,
          line,
          col,
          glyph: String.fromCodePoint(cp),
          cp: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'),
          context: contextWindow(source, i),
        })
      }
      i += len
    }
  }

  if (violations.length > 0) {
    for (const v of violations) {
      const rel = path.relative(ROOT, v.file)
      console.error(`audit-emoji: ${rel}:${v.line}:${v.col}  ${v.glyph} (${v.cp})  ...${v.context}...`)
    }
    console.error(`audit-emoji: ${violations.length} violation${violations.length === 1 ? '' : 's'} across ${files.length} files`)
    process.exit(1)
  }

  console.log(`audit-emoji: 0 violations across ${files.length} files`)
  process.exit(0)
}

main().catch(e => {
  console.error('audit-emoji: unexpected error', e)
  process.exit(1)
})
