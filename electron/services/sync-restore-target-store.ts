import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface SyncRestoreTarget {
  remoteProjectId: string
  targetRoot: string
}

interface StoredTarget {
  targetRoot: string
}

interface StoreDocument {
  version: 1
  targets: Record<string, StoredTarget>
  lastRemoteProjectId?: string
}

function emptyDocument(): StoreDocument {
  return { version: 1, targets: {} }
}

function parseDocument(value: unknown): StoreDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyDocument()
  const document = value as { version?: unknown; targets?: unknown; lastRemoteProjectId?: unknown }
  if (document.version !== 1 || !document.targets || typeof document.targets !== 'object' || Array.isArray(document.targets)) {
    return emptyDocument()
  }
  const targets: Record<string, StoredTarget> = {}
  for (const [remoteProjectId, raw] of Object.entries(document.targets)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const targetRoot = (raw as { targetRoot?: unknown }).targetRoot
    if (typeof targetRoot === 'string' && targetRoot.length > 0) {
      targets[remoteProjectId] = { targetRoot: path.resolve(targetRoot) }
    }
  }
  const last = typeof document.lastRemoteProjectId === 'string' && document.lastRemoteProjectId.length > 0
    ? document.lastRemoteProjectId
    : undefined
  return { version: 1, targets, ...(last ? { lastRemoteProjectId: last } : {}) }
}

/** App-data sidecar for the last restored copy of each remote project. */
export class SyncRestoreTargetStore {
  readonly #filePath: string

  constructor(options: { rootPath: string }) {
    this.#filePath = path.join(options.rootPath, 'sync-restore-targets.json')
  }

  #read(): StoreDocument {
    try {
      return parseDocument(JSON.parse(fs.readFileSync(this.#filePath, 'utf8')))
    } catch {
      return emptyDocument()
    }
  }

  #write(document: StoreDocument): void {
    const directory = path.dirname(this.#filePath)
    const temporaryPath = path.join(directory, `.${path.basename(this.#filePath)}.${process.pid}.${randomUUID()}.tmp`)
    fs.mkdirSync(directory, { recursive: true })
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(document, null, 2), { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(temporaryPath, this.#filePath)
    } finally {
      try { fs.unlinkSync(temporaryPath) } catch { /* Best effort. */ }
    }
  }

  get(remoteProjectId: string): SyncRestoreTarget | null {
    const target = this.#read().targets[remoteProjectId]
    return target ? { remoteProjectId, targetRoot: target.targetRoot } : null
  }

  save(remoteProjectId: string, targetRoot: string): void {
    const document = this.#read()
    document.targets[remoteProjectId] = { targetRoot: path.resolve(targetRoot) }
    document.lastRemoteProjectId = remoteProjectId
    this.#write(document)
  }

  remember(remoteProjectId: string): void {
    const document = this.#read()
    document.lastRemoteProjectId = remoteProjectId
    this.#write(document)
  }

  lastRemoteProjectId(): string | null {
    return this.#read().lastRemoteProjectId ?? null
  }

  clear(remoteProjectId: string): void {
    const document = this.#read()
    let changed = false
    if (remoteProjectId in document.targets) {
      delete document.targets[remoteProjectId]
      changed = true
    }
    if (document.lastRemoteProjectId === remoteProjectId) {
      delete document.lastRemoteProjectId
      changed = true
    }
    if (changed) this.#write(document)
  }
}
