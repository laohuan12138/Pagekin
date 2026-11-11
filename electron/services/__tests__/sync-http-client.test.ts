import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { SyncHttpClient } from '../sync-http-client'

// @ts-expect-error the standalone server is plain JavaScript and has no declaration file
import { createSyncServer } from '../../../sync-server/server.mjs'

const TOKEN = 'client-test-token-0123456789abcdef'
let root: string
let instance: { listen(options: { port: number; host: string }): Promise<{ port: number }>; close(): Promise<void> }
let client: SyncHttpClient

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pagekin-sync-client-'))
  instance = createSyncServer({ dataDir: root, token: TOKEN, leaseTtlSeconds: 120 })
  const address = await instance.listen({ port: 0, host: '127.0.0.1' })
  client = new SyncHttpClient({ endpoint: `http://127.0.0.1:${address.port}`, token: TOKEN })
})

afterAll(async () => {
  await instance?.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('SyncHttpClient', () => {
  it('checks auth, uploads a sealed archive, and verifies the download', async () => {
    await expect(client.check()).resolves.toBeUndefined()
    const projectId = randomUUID()
    await expect(client.status(projectId)).resolves.toMatchObject({
      projectId,
      headVersion: 0,
      lease: null,
      snapshots: [],
    })

    const lease = await client.acquireLease(projectId, 'test-machine')
    expect(lease).toMatchObject({ owner: 'test-machine' })
    expect(lease.expiresAt).toEqual(expect.any(String))

    const archivePath = path.join(root, 'upload.ainovel')
    const archive = Buffer.from('portable archive bytes', 'utf8')
    fs.writeFileSync(archivePath, archive)
    const digest = createHash('sha256').update(archive).digest('hex')

    const head = await client.uploadSnapshot({
      projectId,
      baseVersion: 0,
      leaseId: lease.leaseId,
      archivePath,
      originProjectId: 'origin-project',
      deviceName: 'test-machine',
    })
    expect(head).toMatchObject({
      headVersion: 1,
      snapshots: [{ version: 1, sha256: digest, byteSize: archive.length }],
    })

    const target = path.join(root, 'download.ainovel')
    await expect(client.downloadSnapshot({ projectId, version: 1, targetPath: target })).resolves.toEqual({
      sha256: digest,
      byteSize: archive.length,
    })
    expect(fs.readFileSync(target)).toEqual(archive)
    await expect(client.releaseLease(projectId, lease.leaseId)).resolves.toBe(true)
  })

  it('surfaces lease and version conflicts as stable errors', async () => {
    const projectId = randomUUID()
    const first = await client.acquireLease(projectId, 'machine-a')
    await expect(client.acquireLease(projectId, 'machine-b')).rejects.toMatchObject({
      status: 423,
      code: 'LEASE_HELD',
    })

    const archivePath = path.join(root, 'conflict.ainovel')
    fs.writeFileSync(archivePath, 'archive')
    await client.uploadSnapshot({
      projectId,
      baseVersion: 0,
      leaseId: first.leaseId,
      archivePath,
      originProjectId: 'origin',
      deviceName: 'test-machine',
    })
    await expect(client.uploadSnapshot({
      projectId,
      baseVersion: 0,
      leaseId: first.leaseId,
      archivePath,
      originProjectId: 'origin',
      deviceName: 'test-machine',
    })).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' })
  })
})
