import { useEffect, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'

export const ARTIFACT_SCHEMA_VERSION = 1
const STORAGE = 'beads-station.designer-artifacts.v1'
const MAX_FILES = 256
const MAX_FILE_BYTES = 256 * 1024
const MAX_TOTAL_BYTES = 4 * 1024 * 1024
const listeners = new Set<() => void>()

export type ArtifactRunStatus = 'needs_review' | 'idle' | 'starting' | 'running' | 'failed' | 'cancelled' | 'unknown'
export interface ArtifactIdentity {
  workspaceId: string
  ticketId: string
  runId: string
  attemptId: string
}
export interface ArtifactFile {
  path: string
  status: string
  size: number
  contentHash: string
  content?: string | null
  binary: boolean
  truncated: boolean
}
export interface ArtifactRevision extends ArtifactIdentity {
  schemaVersion: number
  revisionId: string
  capturedAt: number
  workspacePath: string
  sourceRevision?: string | null
  revisionHash: string
  files: ArtifactFile[]
  diff?: string | null
  validation: string[]
}
export interface ArtifactApproval extends ArtifactIdentity {
  revisionId: string
  revisionHash: string
  approvedAt: number
}
export interface ArtifactFeedback extends ArtifactIdentity {
  feedbackId: string
  createdAt: number
  text: string
}
interface ArtifactStore {
  schemaVersion: number
  revisions: ArtifactRevision[]
  approvals: ArtifactApproval[]
  feedback: ArtifactFeedback[]
}

const EMPTY: ArtifactStore = { schemaVersion: ARTIFACT_SCHEMA_VERSION, revisions: [], approvals: [], feedback: [] }
let store = readStore()

function safeStoredRevision(value: unknown): value is ArtifactRevision {
  if (!value || typeof value !== 'object') return false
  const revision = value as Partial<ArtifactRevision>
  if (revision.schemaVersion !== ARTIFACT_SCHEMA_VERSION || typeof revision.revisionId !== 'string' || typeof revision.revisionHash !== 'string' || typeof revision.workspacePath !== 'string' || !revision.workspacePath.startsWith('/') || !validIdentity(revision as ArtifactIdentity) || !Array.isArray(revision.files) || revision.files.length > MAX_FILES) return false
  let total = 0
  return revision.files.every(file => {
    if (!file || typeof file.path !== 'string' || file.path.startsWith('/') || file.path.split(/[\\/]/).includes('..') || file.path.length > 1024 || typeof file.contentHash !== 'string' || !file.contentHash || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES) return false
    const contentLength = typeof file.content === 'string' ? file.content.length : 0
    total += contentLength
    return contentLength <= MAX_FILE_BYTES && total <= MAX_TOTAL_BYTES
  })
}

function safeStoredApproval(value: unknown): value is ArtifactApproval {
  if (!value || typeof value !== 'object') return false
  const approval = value as Partial<ArtifactApproval>
  return validIdentity(approval as ArtifactIdentity)
    && typeof approval.revisionId === 'string'
    && typeof approval.revisionHash === 'string'
    && Number.isFinite(approval.approvedAt)
}

function safeStoredFeedback(value: unknown): value is ArtifactFeedback {
  if (!value || typeof value !== 'object') return false
  const feedback = value as Partial<ArtifactFeedback>
  return validIdentity(feedback as ArtifactIdentity)
    && typeof feedback.feedbackId === 'string'
    && typeof feedback.text === 'string'
    && feedback.text.length > 0
    && feedback.text.length <= 10_000
    && Number.isFinite(feedback.createdAt)
}

function readStore(): ArtifactStore {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE) ?? '') as Partial<ArtifactStore>
    if (!value || !Array.isArray(value.revisions) || !Array.isArray(value.approvals) || !Array.isArray(value.feedback)) return { ...EMPTY }
    return {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      revisions: value.revisions.filter(safeStoredRevision).slice(-50),
      approvals: value.approvals.filter(safeStoredApproval).slice(-50),
      feedback: value.feedback.filter(safeStoredFeedback).slice(-100),
    }
  } catch { return { ...EMPTY } }
}

function sameIdentity(a: ArtifactIdentity, b: ArtifactIdentity): boolean {
  return a.workspaceId === b.workspaceId && a.ticketId === b.ticketId && a.runId === b.runId && a.attemptId === b.attemptId
}
function sameTicket(a: ArtifactIdentity, b: ArtifactIdentity): boolean {
  return a.workspaceId === b.workspaceId && a.ticketId === b.ticketId
}
function emit() {
  // Rust owns the immutable content. Keep only a lightweight browser cache so
  // multiple bounded revisions cannot exhaust WebView localStorage.
  const persisted = {
    ...store,
    revisions: store.revisions.map(revision => ({
      ...revision, diff: null, files: revision.files.map(file => ({ ...file, content: null })),
    })),
  }
  try { localStorage.setItem(STORAGE, JSON.stringify(persisted)) } catch { /* in-memory state remains usable */ }
  listeners.forEach(listener => listener())
}
function patchStore(patch: Partial<ArtifactStore>) {
  store = { ...store, ...patch }
  emit()
}

function validIdentity(identity: ArtifactIdentity): boolean {
  return [identity.workspaceId, identity.ticketId, identity.runId, identity.attemptId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value))
}
function validateRevision(value: unknown, identity: ArtifactIdentity): ArtifactRevision {
  if (!value || typeof value !== 'object') throw new Error('Artifact capture returned no revision.')
  const revision = value as Partial<ArtifactRevision>
  if (revision.schemaVersion !== ARTIFACT_SCHEMA_VERSION || typeof revision.revisionId !== 'string' || typeof revision.revisionHash !== 'string' || !validIdentity(revision as ArtifactIdentity) || !sameIdentity(revision as ArtifactIdentity, identity) || typeof revision.workspacePath !== 'string' || !revision.workspacePath.startsWith('/') || !Array.isArray(revision.files) || revision.files.length > MAX_FILES) {
    throw new Error('Artifact capture returned an invalid revision.')
  }
  let total = 0
  const files = revision.files.map(file => {
    if (!file || typeof file.path !== 'string' || file.path.startsWith('/') || file.path.split(/[\\/]/).includes('..') || file.path.length > 1024 || typeof file.contentHash !== 'string' || !file.contentHash) throw new Error('Artifact contains an unsafe path.')
    const content: string | null = file.content == null ? null : String(file.content)
    const contentLength = content?.length ?? 0
    const size = Number(file.size ?? contentLength)
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) throw new Error('Artifact file size exceeds the safe bound.')
    if (contentLength > MAX_FILE_BYTES) throw new Error('Artifact file preview exceeds the safe bound.')
    total += contentLength
    if (total > MAX_TOTAL_BYTES) throw new Error('Artifact preview exceeds the safe bound.')
    return { path: file.path, status: String(file.status ?? ''), size, contentHash: file.contentHash, content, binary: Boolean(file.binary), truncated: Boolean(file.truncated) }
  })
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION, revisionId: revision.revisionId, capturedAt: Number(revision.capturedAt ?? Date.now()),
    workspaceId: identity.workspaceId, ticketId: identity.ticketId, runId: identity.runId, attemptId: identity.attemptId,
    workspacePath: revision.workspacePath, sourceRevision: typeof revision.sourceRevision === 'string' ? revision.sourceRevision : null, revisionHash: revision.revisionHash, files,
    diff: typeof revision.diff === 'string' ? revision.diff.slice(0, 512 * 1024) : null,
    validation: Array.isArray(revision.validation) ? revision.validation.slice(0, 32).map(String) : [],
  }
}

function validateApproval(value: unknown, revision: ArtifactRevision): ArtifactApproval {
  if (!value || typeof value !== 'object') throw new Error('Artifact approval is invalid.')
  const approval = value as Partial<ArtifactApproval>
  if (!validIdentity(approval as ArtifactIdentity) || !sameIdentity(approval as ArtifactIdentity, revision) || approval.revisionId !== revision.revisionId || approval.revisionHash !== revision.revisionHash || !Number.isFinite(approval.approvedAt)) {
    throw new Error('Artifact approval does not match the exact revision.')
  }
  return {
    workspaceId: revision.workspaceId, ticketId: revision.ticketId, runId: revision.runId, attemptId: revision.attemptId,
    revisionId: revision.revisionId, revisionHash: revision.revisionHash, approvedAt: Number(approval.approvedAt),
  }
}

export function latestArtifact(identity: ArtifactIdentity): ArtifactRevision | null {
  return [...store.revisions].reverse().find(revision => sameIdentity(revision, identity)) ?? null
}
export function currentApproval(identity: ArtifactIdentity): ArtifactApproval | null {
  return [...store.approvals].reverse().find(approval => sameIdentity(approval, identity)) ?? null
}
export function artifactFeedback(identity: ArtifactIdentity): ArtifactFeedback[] {
  return store.feedback.filter(feedback => sameTicket(feedback, identity))
}

export async function captureArtifact(identity: ArtifactIdentity, workspacePath: string): Promise<ArtifactRevision> {
  if (!validIdentity(identity)) throw new Error('Artifact identity is invalid.')
  if (!workspacePath || !workspacePath.startsWith('/')) throw new Error('Artifact workspace path must be absolute.')
  const raw = await invoke<ArtifactRevision>('artifact_capture', { args: { ...identity, workspacePath } })
  const revision = validateRevision(raw, identity)
  patchStore({ revisions: [...store.revisions.filter(old => old.revisionId !== revision.revisionId), revision].slice(-50) })
  return revision
}

export async function reconcileArtifactReview(identity: ArtifactIdentity): Promise<void> {
  if (!validIdentity(identity)) return
  const raw = await invoke<{ revision?: unknown; approval?: unknown }>('artifact_review', { args: identity })
  const revision = raw?.revision ? validateRevision(raw.revision, identity) : null
  const approval = revision && raw?.approval ? validateApproval(raw.approval, revision) : null
  patchStore({
    revisions: [
      ...store.revisions.filter(old => !sameIdentity(old, identity)),
      ...(revision ? [revision] : []),
    ].slice(-50),
    approvals: [
      ...store.approvals.filter(old => !sameTicket(old, identity)),
      ...(approval ? [approval] : []),
    ].slice(-50),
  })
}

export function requestArtifactChanges(identity: ArtifactIdentity, text: string): ArtifactFeedback {
  if (!validIdentity(identity)) throw new Error('Artifact identity is invalid.')
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 10_000) throw new Error('Revision feedback must be between 1 and 10000 characters.')
  const feedback: ArtifactFeedback = { ...identity, feedbackId: crypto.randomUUID(), createdAt: Date.now(), text: trimmed }
  // A revision request is a new attempt boundary. Retain the old revision and
  // feedback for auditability, but remove approval for this ticket immediately.
  patchStore({ feedback: [...store.feedback, feedback].slice(-100), approvals: store.approvals.filter(approval => !sameTicket(approval, identity)) })
  return feedback
}

export async function approveArtifact(revision: ArtifactRevision, status: ArtifactRunStatus): Promise<ArtifactApproval> {
  if (status !== 'needs_review') throw new Error('Only a run in needs_review can be approved.')
  const current = latestArtifact(revision)
  if (!current || current.revisionId !== revision.revisionId || current.revisionHash !== revision.revisionHash || !sameIdentity(current, revision)) throw new Error('This artifact revision is stale.')
  const reference = {
    workspaceId: revision.workspaceId, ticketId: revision.ticketId, runId: revision.runId, attemptId: revision.attemptId,
    revisionId: revision.revisionId, revisionHash: revision.revisionHash,
  }
  const verified = await invoke<boolean>('artifact_verify', { args: { revision: reference } })
  if (verified !== true) throw new Error('Workspace changed after capture; capture a new revision before approving.')
  const approval = validateApproval(
    await invoke<ArtifactApproval>('artifact_approve', { args: { revision: reference } }),
    revision,
  )
  patchStore({ approvals: [...store.approvals.filter(old => !sameTicket(old, revision)), approval].slice(-50) })
  return approval
}

export function useArtifactReview(identity: ArtifactIdentity, status: ArtifactRunStatus) {
  useEffect(() => {
    void reconcileArtifactReview(identity).catch(() => { /* cached review remains readable while backend is unavailable */ })
  }, [identity.workspaceId, identity.ticketId, identity.runId, identity.attemptId])
  const snapshot = useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => store, () => store)
  const revision = [...snapshot.revisions].reverse().find(candidate => sameIdentity(candidate, identity)) ?? null
  const approval = [...snapshot.approvals].reverse().find(candidate => sameIdentity(candidate, identity)) ?? null
  return { revision, approval: status === 'needs_review' ? approval : null, feedback: snapshot.feedback.filter(item => sameTicket(item, identity)) }
}

export function resetArtifactStoreForTests() {
  store = { ...EMPTY, revisions: [], approvals: [], feedback: [] }
  try { localStorage.removeItem(STORAGE) } catch { /* test environments may not provide storage */ }
  listeners.forEach(listener => listener())
}
