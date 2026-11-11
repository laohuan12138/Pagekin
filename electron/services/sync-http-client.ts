import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'

import type { SyncHeadView, SyncLeaseView, SyncSnapshotView } from '../../src/shared/sync-service'

export class SyncHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
    this.name = 'SyncHttpError'
  }
}

export interface SyncHttpClientOptions {
  endpoint: string
  token: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxDownloadBytes?: number
}

type SyncRequestInit = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> }

const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export class SyncHttpClient {
  readonly #endpoint: string
  readonly #token: string
  readonly #fetch: typeof fetch
  readonly #timeoutMs: number
  readonly #maxDownloadBytes: number

  constructor(options: SyncHttpClientOptions) {
    this.#endpoint = options.endpoint.endsWith('/') ? options.endpoint : `${options.endpoint}/`
    this.#token = options.token
    this.#fetch = options.fetchImpl ?? fetch
    this.#timeoutMs = options.timeoutMs ?? 600_000
    this.#maxDownloadBytes = options.maxDownloadBytes ?? 512 * 1024 * 1024
  }

  async check(): Promise<void> {
    // A read-only status call verifies the bearer token without creating state.
    await this.status('sync-probe')
  }

  async status(projectId: string): Promise<SyncHeadView> {
    return this.#json<SyncHeadView>(`v1/projects/${encodeURIComponent(projectId)}/status`, { method: 'GET' })
  }

  async acquireLease(projectId: string, owner: string, ttlSeconds = 900, leaseId?: string): Promise<SyncLeaseView> {
    const body = await this.#json<{ lease: SyncLeaseView }>(`v1/projects/${encodeURIComponent(projectId)}/lease`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner, ttlSeconds, ...(leaseId ? { leaseId } : {}) }),
    })
    if (!body.lease?.leaseId) throw new SyncHttpError(502, 'REMOTE_INVALID')
    return body.lease
  }

  async releaseLease(projectId: string, leaseId: string): Promise<boolean> {
    const body = await this.#json<{ released: boolean }>(`v1/projects/${encodeURIComponent(projectId)}/lease/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaseId }),
    })
    return body.released === true
  }

  async listSnapshots(projectId: string): Promise<SyncSnapshotView[]> {
    const body = await this.#json<{ snapshots: SyncSnapshotView[] }>(`v1/projects/${encodeURIComponent(projectId)}/snapshots`, { method: 'GET' })
    return body.snapshots
  }

  async uploadSnapshot(input: {
    projectId: string
    baseVersion: number
    leaseId: string
    archivePath: string
    originProjectId: string
    deviceName: string
    force?: boolean
    expectedHeadVersion?: number
  }): Promise<SyncHeadView> {
    const archive = await fs.readFile(input.archivePath)
    const digest = sha256(archive)
    const url = `v1/projects/${encodeURIComponent(input.projectId)}/snapshots?baseVersion=${input.baseVersion}`
    return this.#json<SyncHeadView>(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-sync-lease-id': input.leaseId,
        'x-sync-sha256': digest,
        'x-sync-origin-project-id': input.originProjectId,
        'x-sync-device-name': input.deviceName,
        ...(input.force ? { 'x-sync-force': '1' } : {}),
        ...(input.expectedHeadVersion === undefined
          ? {}
          : { 'x-sync-expected-head': String(input.expectedHeadVersion) }),
      },
      body: new Uint8Array(archive),
    })
  }

  async downloadSnapshot(input: {
    projectId: string
    version: number
    targetPath: string
    expectedSha?: string
  }): Promise<{ sha256: string; byteSize: number }> {
    const response = await this.#fetch(new URL(`v1/projects/${encodeURIComponent(input.projectId)}/snapshots/${input.version}`, this.#endpoint), {
      method: 'GET',
      headers: { authorization: `Bearer ${this.#token}` },
      signal: AbortSignal.timeout(this.#timeoutMs),
    })
    if (!response.ok) throw await this.#failure(response)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > this.#maxDownloadBytes) {
      await response.body?.cancel()
      throw new SyncHttpError(413, 'DOWNLOAD_TOO_LARGE')
    }
    if (!response.body) throw new SyncHttpError(502, 'REMOTE_INVALID')
    const reader = response.body.getReader()
    const digest = createHash('sha256')
    let byteSize = 0
    const handle = await fs.open(input.targetPath, 'wx', 0o600)
    let failure: unknown = null
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        byteSize += value.byteLength
        if (byteSize > this.#maxDownloadBytes) {
          await reader.cancel()
          failure = new SyncHttpError(413, 'DOWNLOAD_TOO_LARGE')
          break
        }
        digest.update(value)
        await handle.write(value)
      }
    } catch (error) {
      failure = error
    } finally {
      await handle.close().catch(() => undefined)
    }
    if (failure) {
      await fs.rm(input.targetPath, { force: true })
      throw failure
    }
    const actual = digest.digest('hex')
    const expected = response.headers.get('x-sync-sha256') || input.expectedSha || ''
    if (!expected || actual !== expected || (input.expectedSha && actual !== input.expectedSha)) {
      await fs.rm(input.targetPath, { force: true })
      throw new SyncHttpError(502, 'SHA256_MISMATCH')
    }
    return { sha256: actual, byteSize }
  }

  async #json<T>(pathname: string, init: SyncRequestInit): Promise<T> {
    const response = await this.#fetch(new URL(pathname, this.#endpoint), {
      ...init,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(this.#timeoutMs),
    })
    if (!response.ok) throw await this.#failure(response)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > MAX_JSON_RESPONSE_BYTES) {
      throw new SyncHttpError(413, 'REMOTE_INVALID')
    }
    const value = await response.json()
    if (!value || typeof value !== 'object') throw new SyncHttpError(502, 'REMOTE_INVALID')
    return value as T
  }

  async #failure(response: Response): Promise<SyncHttpError> {
    let code = 'SYNC_SERVER_FAILED'
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > 64 * 1024) {
      return new SyncHttpError(response.status, 'REMOTE_INVALID')
    }
    try {
      const value = await response.json() as { error?: unknown }
      if (typeof value.error === 'string' && value.error) code = value.error
    } catch { /* keep the stable fallback */ }
    return new SyncHttpError(response.status, code)
  }
}
