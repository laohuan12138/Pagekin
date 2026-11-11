import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createSyncServer } from './server.mjs'

const TOKEN = 'test-sync-token-0123456789abcdef'
let root
let instance
let baseUrl
let nowMs

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function projectId() {
  return randomUUID()
}

async function call(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(options.headers ?? {}),
    },
  })
}

async function acquire(id, body = { owner: 'machine-a' }) {
  const response = await call(`/v1/projects/${id}/lease`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { response, body: await response.json() }
}

async function upload(id, leaseId, bytes, baseVersion = 0, overrides = {}) {
  return call(`/v1/projects/${id}/snapshots?baseVersion=${baseVersion}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-sync-lease-id': leaseId,
      'x-sync-sha256': overrides.sha ?? sha256(bytes),
      'x-sync-origin-project-id': overrides.origin ?? 'origin-project',
      'x-sync-device-name': overrides.device ?? 'machine-a',
      ...(overrides.force ? { 'x-sync-force': '1' } : {}),
      ...(overrides.expectedHead === undefined
        ? {}
        : { 'x-sync-expected-head': String(overrides.expectedHead) }),
    },
    body: bytes,
  })
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pagekin-sync-server-'))
  nowMs = Date.parse('2026-11-10T00:00:00.000Z')
  instance = createSyncServer({
    dataDir: root,
    token: TOKEN,
    leaseTtlSeconds: 60,
    now: () => nowMs,
  })
  const address = await instance.listen({ port: 0, host: '127.0.0.1' })
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await instance?.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('self-hosted sync server', () => {
  it('rejects a malformed request target without crashing', async () => {
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: new URL(baseUrl).port, path: '//', method: 'GET' }, response => {
        response.resume()
        resolve(response.statusCode)
      })
      request.on('error', reject)
      request.end()
    })
    expect(status).toBe(400)
    const health = await call('/health')
    expect(health.status).toBe(200)
  })

  it('requires auth for health and project requests', async () => {
    const unauthorizedHealth = await fetch(`${baseUrl}/health`)
    expect(unauthorizedHealth.status).toBe(401)
    await expect(unauthorizedHealth.json()).resolves.toEqual({ error: 'AUTH_REQUIRED' })

    const health = await call('/health')
    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toEqual({ ok: true })

    const unauthorized = await fetch(`${baseUrl}/v1/projects/${projectId()}/status`)
    expect(unauthorized.status).toBe(401)
    await expect(unauthorized.json()).resolves.toEqual({ error: 'AUTH_REQUIRED' })
  })

  it('enforces one writer and versions immutable archives', async () => {
    const id = projectId()
    const empty = await call(`/v1/projects/${id}/status`)
    await expect(empty.json()).resolves.toMatchObject({
      projectId: id,
      headVersion: 0,
      lease: null,
      snapshots: [],
    })

    const first = await acquire(id, { owner: 'machine-a' })
    expect(first.response.status).toBe(200)
    const leaseId = first.body.lease.leaseId

    const second = await acquire(id, { owner: 'machine-b' })
    expect(second.response.status).toBe(423)
    expect(second.body).toMatchObject({
      error: 'LEASE_HELD',
      lease: { owner: 'machine-a' },
    })

    const archive = Buffer.from('first sealed archive', 'utf8')
    const uploaded = await upload(id, leaseId, archive)
    expect(uploaded.status).toBe(200)
    const uploadBody = await uploaded.json()
    expect(uploadBody).toMatchObject({
      headVersion: 1,
      snapshot: {
        version: 1,
        sha256: sha256(archive),
        byteSize: archive.length,
        originProjectId: 'origin-project',
      },
    })
    expect(uploadBody.lease).toEqual(expect.objectContaining({ owner: 'machine-a' }))

    const conflict = await upload(id, leaseId, Buffer.from('other'), 0)
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toEqual({ error: 'VERSION_CONFLICT' })

    const download = await call(`/v1/projects/${id}/snapshots/1`)
    expect(download.status).toBe(200)
    expect(download.headers.get('x-sync-sha256')).toBe(sha256(archive))
    expect(Buffer.from(await download.arrayBuffer())).toEqual(archive)

    const wrongSha = await upload(id, leaseId, Buffer.from('tampered'), 1, { sha: '0'.repeat(64) })
    expect(wrongSha.status).toBe(400)
    await expect(wrongSha.json()).resolves.toEqual({ error: 'SHA256_MISMATCH' })

    const missingBase = await call(`/v1/projects/${id}/snapshots`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-sync-lease-id': leaseId,
        'x-sync-sha256': sha256(Buffer.from('missing-base')),
      },
      body: Buffer.from('missing-base'),
    })
    expect(missingBase.status).toBe(400)
    await expect(missingBase.json()).resolves.toEqual({ error: 'INVALID_BASE_VERSION' })

    const release = await call(`/v1/projects/${id}/lease/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaseId }),
    })
    expect(release.status).toBe(200)
    await expect(release.json()).resolves.toEqual({ released: true })

    const afterRelease = await acquire(id, { owner: 'machine-b' })
    expect(afterRelease.response.status).toBe(200)
    expect(afterRelease.body.lease.owner).toBe('machine-b')
  })

  it('records which computer forced a divergent branch', async () => {
    const id = projectId()
    const lease = await acquire(id, { owner: 'machine-a' })
    const first = await upload(id, lease.body.lease.leaseId, Buffer.from('from-a'), 0, { device: 'machine-a' })
    expect(first.status).toBe(200)

    const conflict = await upload(id, lease.body.lease.leaseId, Buffer.from('from-b'), 0, { device: 'machine-b' })
    expect(conflict.status).toBe(409)

    const forced = await upload(id, lease.body.lease.leaseId, Buffer.from('from-b'), 0, {
      device: 'machine-b',
      force: true,
      expectedHead: 1,
    })
    expect(forced.status).toBe(200)
    await expect(forced.json()).resolves.toMatchObject({
      headVersion: 2,
      snapshot: {
        version: 2,
        deviceName: 'machine-b',
        parentVersions: [0, 1],
        forced: true,
      },
    })

    const status = await call(`/v1/projects/${id}/status`)
    await expect(status.json()).resolves.toMatchObject({
      headVersion: 2,
      snapshots: [
        { version: 1, deviceName: 'machine-a', parentVersions: [0], forced: false },
        { version: 2, deviceName: 'machine-b', parentVersions: [0, 1], forced: true },
      ],
    })
  })

  it('lets a different writer take over after lease expiry', async () => {
    const id = projectId()
    const first = await acquire(id, { owner: 'machine-a' })
    const oldLease = first.body.lease.leaseId

    nowMs += 61_000
    const status = await call(`/v1/projects/${id}/status`)
    await expect(status.json()).resolves.toEqual(expect.objectContaining({ lease: null }))

    const takeover = await acquire(id, { owner: 'machine-b' })
    expect(takeover.response.status).toBe(200)
    expect(takeover.body.lease.owner).toBe('machine-b')

    const staleUpload = await upload(id, oldLease, Buffer.from('stale'), 0)
    expect(staleUpload.status).toBe(423)
    await expect(staleUpload.json()).resolves.toEqual({ error: 'LEASE_REQUIRED' })
  })

  it('rate-limits repeated unauthenticated probes from one client', async () => {
    const limitedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pagekin-sync-rate-'))
    const limited = createSyncServer({ dataDir: limitedRoot, token: TOKEN, rateLimit: 2, rateWindowMs: 60_000 })
    const limitedAddress = await limited.listen({ port: 0, host: '127.0.0.1' })
    try {
      const url = `http://127.0.0.1:${limitedAddress.port}/health`
      expect((await fetch(url)).status).toBe(401)
      expect((await fetch(url)).status).toBe(401)
      const blocked = await fetch(url)
      expect(blocked.status).toBe(429)
      await expect(blocked.json()).resolves.toEqual({ error: 'RATE_LIMITED' })
      const authenticated = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } })
      expect(authenticated.status).toBe(200)
    } finally {
      await limited.close()
      fs.rmSync(limitedRoot, { recursive: true, force: true })
    }
  })

  it('enforces body and per-project snapshot caps', async () => {
    async function start(options) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pagekin-sync-cap-'))
      const server = createSyncServer({ dataDir: directory, token: TOKEN, ...options })
      const address = await server.listen({ port: 0, host: '127.0.0.1' })
      return { server, directory, base: `http://127.0.0.1:${address.port}` }
    }
    async function lease(base, id) {
      const response = await fetch(`${base}/v1/projects/${id}/lease`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ owner: 'cap-test' }),
      })
      return (await response.json()).lease.leaseId
    }
    async function send(base, id, leaseId, bytes, baseVersion) {
      return fetch(`${base}/v1/projects/${id}/snapshots?baseVersion=${baseVersion}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'x-sync-lease-id': leaseId,
          'x-sync-sha256': sha256(bytes),
        },
        body: bytes,
      })
    }

    const bodyLimited = await start({ maxBodyBytes: 4 })
    const snapshotLimited = await start({ maxSnapshots: 1 })
    const retentionLimited = await start({ maxSnapshots: 3, retainSnapshots: 2 })
    const projectLimited = await start({ maxProjects: 1 })
    try {
      const bodyId = projectId()
      const bodyLease = await lease(bodyLimited.base, bodyId)
      const tooLarge = await send(bodyLimited.base, bodyId, bodyLease, Buffer.from('12345'), 0)
      expect(tooLarge.status).toBe(413)
      await expect(tooLarge.json()).resolves.toEqual({ error: 'BODY_TOO_LARGE' })

      const snapshotId = projectId()
      const snapshotLease = await lease(snapshotLimited.base, snapshotId)
      expect((await send(snapshotLimited.base, snapshotId, snapshotLease, Buffer.from('a'), 0)).status).toBe(200)
      const overLimit = await send(snapshotLimited.base, snapshotId, snapshotLease, Buffer.from('b'), 1)
      expect(overLimit.status).toBe(409)
      await expect(overLimit.json()).resolves.toEqual({ error: 'SNAPSHOT_LIMIT_REACHED' })

      const retentionId = projectId()
      const retentionLease = await lease(retentionLimited.base, retentionId)
      for (const [version, body] of [[0, 'a'], [1, 'b'], [2, 'c']]) {
        expect((await send(retentionLimited.base, retentionId, retentionLease, Buffer.from(body), version)).status).toBe(200)
      }
      const retainedStatus = await fetch(`${retentionLimited.base}/v1/projects/${retentionId}/status`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      const retained = await retainedStatus.json()
      expect(retained.snapshots.map(snapshot => snapshot.version)).toEqual([2, 3])
      const snapshotsDir = path.join(
        retentionLimited.directory,
        'projects',
        createHash('sha256').update(retentionId).digest('hex'),
        'snapshots',
      )
      expect(fs.existsSync(path.join(snapshotsDir, 'v00000001.ainovel'))).toBe(false)
      expect(fs.existsSync(path.join(snapshotsDir, 'v00000002.ainovel'))).toBe(true)
      expect(fs.existsSync(path.join(snapshotsDir, 'v00000003.ainovel'))).toBe(true)

      expect(await lease(projectLimited.base, projectId())).toEqual(expect.any(String))
      const extraProject = await fetch(`${projectLimited.base}/v1/projects/${projectId()}/lease`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ owner: 'cap-test' }),
      })
      expect(extraProject.status).toBe(429)
      await expect(extraProject.json()).resolves.toEqual({ error: 'PROJECT_LIMIT_REACHED' })
    } finally {
      await bodyLimited.server.close()
      await snapshotLimited.server.close()
      await retentionLimited.server.close()
      await projectLimited.server.close()
      fs.rmSync(bodyLimited.directory, { recursive: true, force: true })
      fs.rmSync(snapshotLimited.directory, { recursive: true, force: true })
      fs.rmSync(retentionLimited.directory, { recursive: true, force: true })
      fs.rmSync(projectLimited.directory, { recursive: true, force: true })
    }
  })

  it('keeps uploads and downloads scoped to a safe project id', async () => {
    const traversal = await call('/v1/projects/..%2F..%2Fetc/status')
    expect(traversal.status).toBe(404)

    const id = projectId()
    const lease = await acquire(id)
    const archive = Buffer.from('scoped archive', 'utf8')
    await upload(id, lease.body.lease.leaseId, archive)

    const other = await call(`/v1/projects/${projectId()}/snapshots/1`)
    expect(other.status).toBe(404)
    await expect(other.json()).resolves.toEqual({ error: 'SNAPSHOT_NOT_FOUND' })
  })
})
