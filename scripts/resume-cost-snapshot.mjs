#!/usr/bin/env node
// What does reopening a conversation cost, before any message is sent?
//
// This script starts nothing and sends nothing. It reads one session file and
// prints its size and recorded token totals, so the same session can be
// compared before and after a manual resume:
//
//   node scripts/resume-cost-snapshot.mjs claude <session-id>   > before.txt
//   (resume that session in a terminal, wait 30 s, send NOTHING, quit the CLI)
//   node scripts/resume-cost-snapshot.mjs claude <session-id>   > after.txt
//   diff before.txt after.txt
//
// Limits: a request the CLI makes without writing a transcript record (a
// title or summary call, for example) does not show up here. Check the CLI's
// own /cost or /status and the provider's usage page for the same minute too.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [provider, id] = process.argv.slice(2)
if (!['claude', 'codex'].includes(provider) || !/^[0-9a-f-]{36}$/i.test(id ?? '')) {
  console.error('usage: resume-cost-snapshot.mjs <claude|codex> <session-id>')
  process.exit(2)
}

function find(dir, matches, depth = 0) {
  if (depth > 6) return null
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isFile() && matches(entry.name)) return path
    if (entry.isDirectory()) { const found = find(path, matches, depth + 1); if (found) return found }
  }
  return null
}

const file = provider === 'claude'
  ? find(join(homedir(), '.claude', 'projects'), name => name === `${id}.jsonl`)
  : find(join(homedir(), '.codex', 'sessions'), name => name.startsWith('rollout-') && name.endsWith(`${id}.jsonl`))
if (!file) { console.error('No session file found for that id.'); process.exit(1) }

const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
const totals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
const seen = new Set()
let records = 0
for (const line of lines) {
  let record
  try { record = JSON.parse(line) } catch { continue }
  records += 1
  if (provider === 'claude') {
    const usage = record?.message?.usage
    const key = record?.message?.id
    if (!usage || !key || seen.has(key)) continue // one message is written on several lines
    seen.add(key)
    totals.input += usage.input_tokens ?? 0
    totals.output += usage.output_tokens ?? 0
    totals.cacheRead += usage.cache_read_input_tokens ?? 0
    totals.cacheCreate += usage.cache_creation_input_tokens ?? 0
  } else {
    const usage = record?.payload?.info?.total_token_usage // running total: the last one wins
    if (!usage) continue
    totals.input = usage.input_tokens ?? 0
    totals.output = usage.output_tokens ?? 0
    totals.cacheRead = usage.cached_input_tokens ?? 0
  }
}

console.log(`provider     ${provider}`)
console.log(`bytes        ${statSync(file).size}`)
console.log(`records      ${records}`)
console.log(`input        ${totals.input}`)
console.log(`output       ${totals.output}`)
console.log(`cache read   ${totals.cacheRead}`)
console.log(`cache write  ${totals.cacheCreate}`)
