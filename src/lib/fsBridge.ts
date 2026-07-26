// RV3-B (Code-8ro) — FE wrappers for the fs.rs commands (list_dir/read_file).
// Thin invoke() calls; the file-nav pane loads lazily one directory per expand.

import { invoke } from '@tauri-apps/api/core';

export interface FsDirEntry {
  path: string;
  name: string;
  isDir: boolean;
}

export interface FsDirListing {
  entries: FsDirEntry[];
  truncated: boolean;
}

export interface FsFilePreview {
  path: string;
  content: string;
  truncated: boolean;
  binary: boolean;
  totalBytes: number;
}

export function listDir(path: string): Promise<FsDirListing> {
  return invoke<FsDirListing>('list_dir', { path });
}

export function readFile(path: string, maxBytes?: number): Promise<FsFilePreview> {
  return invoke<FsFilePreview>('read_file', { path, maxBytes: maxBytes ?? null });
}
