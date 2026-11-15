// Pinned: an Obsidian vault (any folder of markdown notes) shown read-only.
// The Rust side (`pinned.rs`) lists and reads notes confined to the folder;
// this file is the pure part: filtering and tidying a note for display.

import { invoke } from '@tauri-apps/api/core'

export interface VaultNote { rel: string; name: string; modifiedMs: number; size: number }
export interface VaultList { notes: VaultNote[]; truncated: boolean }
export interface VaultNoteContent { rel: string; content: string; truncated: boolean }

export const listVault = (vault: string) => invoke<VaultList>('vault_list', { vault })
export const readVaultNote = (vault: string, rel: string) => invoke<VaultNoteContent>('vault_read', { vault, rel })

/** Notes whose path contains every word of the query, case-insensitively. */
export function filterNotes(notes: VaultNote[], query: string): VaultNote[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return words.length === 0 ? notes : notes.filter(note => words.every(word => note.rel.toLowerCase().includes(word)))
}

/**
 * Obsidian flavour made readable: the YAML properties block is dropped,
 * `[[Note|label]]` and `[[Note]]` become their label, and `![[embed]]` a
 * plain mention. Nothing is fetched or resolved.
 */
export function prepareNote(raw: string): string {
  const body = raw.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '')
  return body
    .replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (_, target: string) => `(embedded: ${target})`)
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]|]+)\]\]/g, '$1')
}

/** The vault folder joined with a note's relative path. */
export function notePath(vault: string, rel: string): string {
  return `${vault.replace(/\/+$/, '')}/${rel}`
}
