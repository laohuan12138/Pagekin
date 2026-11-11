import path from 'node:path'

import type { SyncBindingView, SyncServerView } from '../../src/shared/sync-service'
import { tryReadJsonFile, writeJsonFile } from '../utils/config-utils'
import { getGlobalDataRoot } from './app-data-locator'
import type { SafeStorageLike } from './cloud-credential-store'

const STORE_FILE_NAME = 'sync-service.json'
const STORE_VERSION = 1
const MAX_ENDPOINT_LENGTH = 2_048
const MAX_TOKEN_BYTES = 64 * 1_024
const MAX_PROJECT_ID_LENGTH = 128
const MAX_BINDINGS = 2_048

export const SYNC_CREDENTIAL_SESSION_ONLY = 'SYNC_CREDENTIAL_SESSION_ONLY' as const

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

interface StoredServer {
  endpoint: string
  encryptedTokenBase64?: string
}

interface StoredBinding {
  remoteProjectId: string
  lastVersion: number
}

interface SyncDocument {
  version: typeof STORE_VERSION
  server: StoredServer | null
  bindings: Record<string, StoredBinding>
}

export interface ResolvedSyncServer {
  endpoint: string
  token: string
  persistence: 'os-backed' | 'session-only'
}

export interface SyncConfigView {
  server: SyncServerView
  binding: SyncBindingView | null
}

export interface SyncConfigStoreOptions {
  safeStorage: SafeStorageLike
  rootPath?: string
  platform?: NodeJS.Platform
}

function invalid(): never {
  throw new Error('SYNC_CONFIG_INVALID')
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function controlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))) return true
  }
  return false
}

export function normalizeSyncEndpoint(value: string): string {
  if (typeof value !== 'string') invalid()
  const candidate = value.trim()
  if (!candidate || candidate.length > MAX_ENDPOINT_LENGTH || controlCharacter(candidate)
    || candidate.includes('?') || candidate.includes('#')) invalid()
  let endpoint: URL
  try { endpoint = new URL(candidate) } catch { return invalid() }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) invalid()
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') invalid()
  if (endpoint.pathname !== '/' && endpoint.pathname !== '') invalid()
  endpoint.pathname = '/'
  return endpoint.toString()
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_TOKEN_BYTES
}

function validProjectId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_PROJECT_ID_LENGTH && PROJECT_ID.test(value)
}

function validBinding(value: unknown): value is StoredBinding {
  return record(value) && exactKeys(value, ['remoteProjectId', 'lastVersion'])
    && validProjectId(value.remoteProjectId)
    && Number.isInteger(value.lastVersion) && (value.lastVersion as number) >= 0
}

function parseDocument(value: unknown): SyncDocument {
  if (!record(value) || !exactKeys(value, ['version', 'server', 'bindings'])
    || value.version !== STORE_VERSION || !record(value.bindings)) invalid()
  let server: StoredServer | null = null
  if (value.server !== null) {
    if (!record(value.server) || !exactKeys(value.server, value.server.encryptedTokenBase64 === undefined
      ? ['endpoint'] : ['endpoint', 'encryptedTokenBase64'])) invalid()
    if (typeof value.server.endpoint !== 'string') invalid()
    const endpoint = normalizeSyncEndpoint(value.server.endpoint)
    if (endpoint !== value.server.endpoint) invalid()
    const encrypted = value.server.encryptedTokenBase64
    if (encrypted !== undefined
      && (typeof encrypted !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encrypted))) invalid()
    server = {
      endpoint,
      ...(encrypted === undefined ? {} : { encryptedTokenBase64: encrypted }),
    }
  }
  const entries = Object.entries(value.bindings)
  if (entries.length > MAX_BINDINGS) invalid()
  const bindings: Record<string, StoredBinding> = {}
  for (const [localProjectId, binding] of entries) {
    if (!validProjectId(localProjectId) || !validBinding(binding)) invalid()
    bindings[localProjectId] = { remoteProjectId: binding.remoteProjectId, lastVersion: binding.lastVersion }
  }
  return { version: STORE_VERSION, server, bindings }
}

export class SyncConfigStore {
  readonly #filePath: string
  readonly #safeStorage: SafeStorageLike
  readonly #platform: NodeJS.Platform
  #sessionToken: { endpoint: string; token: string } | null = null

  constructor(options: SyncConfigStoreOptions) {
    this.#safeStorage = options.safeStorage
    this.#platform = options.platform ?? process.platform
    this.#filePath = path.join(options.rootPath ?? getGlobalDataRoot(), STORE_FILE_NAME)
  }

  view(localProjectId: string): SyncConfigView {
    const document = this.#load()
    const resolved = this.#resolve(document)
    const binding = document.bindings[localProjectId]
    return {
      server: {
        endpoint: document.server?.endpoint ?? null,
        configured: Boolean(resolved?.token),
        tokenPersistence: resolved?.persistence ?? 'none',
      },
      binding: binding
        ? { localProjectId, remoteProjectId: binding.remoteProjectId, lastVersion: binding.lastVersion }
        : null,
    }
  }

  saveServer(endpointValue: string, token: string): SyncServerView {
    const endpoint = normalizeSyncEndpoint(endpointValue)
    if (!validToken(token)) invalid()
    let encryptedTokenBase64: string | undefined
    if (this.#persistentEncryptionAvailable()) {
      try {
        const encrypted = this.#safeStorage.encryptString(token).toString('base64')
        if (encrypted) encryptedTokenBase64 = encrypted
      } catch { /* Fall back to a session-only credential. */ }
    }
    const server: StoredServer = { endpoint, ...(encryptedTokenBase64 ? { encryptedTokenBase64 } : {}) }
    this.#sessionToken = encryptedTokenBase64 ? null : { endpoint, token }
    // A new server may not have the same remote projects; binding them silently
    // would let a later upload target an unrelated archive namespace.
    writeJsonFile(this.#filePath, { version: STORE_VERSION, server, bindings: {} } satisfies SyncDocument)
    return {
      endpoint,
      configured: true,
      tokenPersistence: encryptedTokenBase64 ? 'os-backed' : 'session-only',
    }
  }

  clearServer(): void {
    this.#sessionToken = null
    writeJsonFile(this.#filePath, {
      version: STORE_VERSION,
      server: null,
      bindings: {},
    } satisfies SyncDocument)
  }

  resolveServer(): ResolvedSyncServer | null {
    return this.#resolve(this.#load())
  }

  saveBinding(localProjectId: string, remoteProjectId: string, lastVersion: number): SyncBindingView {
    if (!validProjectId(localProjectId) || !validProjectId(remoteProjectId)
      || !Number.isInteger(lastVersion) || lastVersion < 0) invalid()
    const document = this.#load()
    if (!document.server) throw new Error('SYNC_NOT_CONFIGURED')
    document.bindings[localProjectId] = { remoteProjectId, lastVersion }
    writeJsonFile(this.#filePath, document)
    return { localProjectId, remoteProjectId, lastVersion }
  }

  getBinding(localProjectId: string): SyncBindingView | null {
    const binding = this.#load().bindings[localProjectId]
    return binding
      ? { localProjectId, remoteProjectId: binding.remoteProjectId, lastVersion: binding.lastVersion }
      : null
  }

  #load(): SyncDocument {
    const read = tryReadJsonFile<unknown>(this.#filePath)
    if (read.status === 'missing') return { version: STORE_VERSION, server: null, bindings: {} }
    if (read.status === 'error') invalid()
    return parseDocument(read.value)
  }

  #resolve(document: SyncDocument): ResolvedSyncServer | null {
    if (!document.server) return null
    if (this.#sessionToken?.endpoint === document.server.endpoint) {
      return { endpoint: document.server.endpoint, token: this.#sessionToken.token, persistence: 'session-only' }
    }
    if (!document.server.encryptedTokenBase64 || !this.#persistentEncryptionAvailable()) return null
    try {
      const token = this.#safeStorage.decryptString(Buffer.from(document.server.encryptedTokenBase64, 'base64'))
      if (!validToken(token)) return null
      return { endpoint: document.server.endpoint, token, persistence: 'os-backed' }
    } catch {
      return null
    }
  }

  #persistentEncryptionAvailable(): boolean {
    try {
      if (!this.#safeStorage.isEncryptionAvailable()) return false
      if (this.#platform !== 'linux') return true
      const backend = this.#safeStorage.getSelectedStorageBackend?.()
      return backend === 'gnome_libsecret' || backend === 'kwallet' || backend === 'kwallet5' || backend === 'kwallet6'
    } catch {
      return false
    }
  }
}
