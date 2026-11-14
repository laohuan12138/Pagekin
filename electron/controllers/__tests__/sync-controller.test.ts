import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SyncControllerDependencies } from '../sync-controller'
import { registerSyncController } from '../sync-controller'
import { SyncConfigStore } from '../../services/sync-config-store'
import { SyncHttpClient } from '../../services/sync-http-client'
import type {
  ExportPortableProjectInput,
  ExportPortableProjectReceipt,
  PortableAssetProvider,
} from '../../services/project-archive-service'
import type {
  RestorePortableProjectInput,
  RestorePortableProjectReceipt,
} from '../../services/project-restore-service'


const roots: string[] = []

function tempRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pagekin-sync-controller-'))
  roots.push(directory)
  return directory
}

function safeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => {
      const text = value.toString('utf8')
      if (!text.startsWith('encrypted:')) throw new Error('bad ciphertext')
      return text.slice('encrypted:'.length)
    },
  }
}

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('sync controller', () => {
  it('configures, binds, leases, uploads, and restores a remote snapshot', async () => {
    const root = tempRoot()
    const project = { projectId: 'local-project', leaseId: 'lease-1', projectPath: root }
    const handlers = new Map<string, (event: unknown, argument: unknown) => unknown>()
    const configStore = new SyncConfigStore({ rootPath: root, safeStorage: safeStorage() })
    const recent = vi.fn()
    const uploaded: Parameters<SyncHttpClient['uploadSnapshot']>[0][] = []
    const lease = { leaseId: 'remote-lease', owner: 'test-host', expiresAt: '2026-11-10T00:05:00.000Z' }
    let headVersion = 0
    let snapshots: Array<{ version: number; sha256: string; byteSize: number; createdAt: string; originProjectId: string }> = []
    const head = () => ({
      projectId: 'local-project',
      headVersion,
      lease: null,
      snapshots,
    })
    const client = {
      check: vi.fn(async () => undefined),
      status: vi.fn(async () => head()),
      acquireLease: vi.fn(async () => lease),
      releaseLease: vi.fn(async () => true),
      uploadSnapshot: vi.fn(async (input: Parameters<SyncHttpClient['uploadSnapshot']>[0]) => {
        uploaded.push(input)
        headVersion += 1
        snapshots = [...snapshots, {
          version: headVersion,
          sha256: 'a'.repeat(64),
          byteSize: 14,
          createdAt: '2026-11-10T00:00:00.000Z',
          originProjectId: 'local-project',
        }]
        return { ...head(), lease: { owner: lease.owner, expiresAt: lease.expiresAt } }
      }),
      downloadSnapshot: vi.fn(async (input: { targetPath: string; expectedSha?: string }) => {
        fs.writeFileSync(input.targetPath, 'remote archive')
        return { sha256: input.expectedSha ?? 'a'.repeat(64), byteSize: 14 }
      }),
    } as unknown as SyncHttpClient
    const exportPortableProject = async (input: ExportPortableProjectInput): Promise<ExportPortableProjectReceipt> => {
      fs.writeFileSync(input.targetArchivePath, 'local archive')
      return {
        originProjectId: project.projectId,
        snapshotGeneration: 'snapshot-1',
        targetSha256: 'b'.repeat(64),
        targetByteSize: 13,
        sourceEvidence: { schemaVersion: 9, schemaFingerprint: 'fingerprint', tableCount: 1, fieldCount: 1 },
        entryCount: 1,
        requiresRuntimeFreezeGuard: true,
      }
    }
    const restorePortableProject = async (input: RestorePortableProjectInput): Promise<RestorePortableProjectReceipt> => {
      fs.mkdirSync(path.join(input.targetProjectRoot, '.ai-novel'), { recursive: true })
      fs.writeFileSync(path.join(input.targetProjectRoot, '.ai-novel', 'project.db'), '')
      return {
        originProjectId: project.projectId,
        targetProjectId: 'restored-project',
        targetProjectRoot: input.targetProjectRoot,
        snapshotGeneration: input.archivePath,
        portableDatabaseSha256: 'c'.repeat(64),
        requiresRuntimeFreezeGuard: true,
      }
    }
    const portableAssets: PortableAssetProvider = {
      async snapshot() { return { files: [], verifyUnchanged: () => true } },
    }
    const deps: SyncControllerDependencies = {
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler) } },
      configStore,
      createClient: () => client,
      exportPortableProject,
      restorePortableProject,
      portableAssets,
      assertCurrentProjectContext: () => ({ ...project, rootPath: root }),
      getCurrentProjectPath: () => root,
      sameCanonicalProjectRoot: (left, right) => path.resolve(left) === path.resolve(right),
      getGlobalDataRoot: () => root,
      resolveRestoreTargetGrant: () => path.join(root, 'restored-target'),
      readRestoredProjectName: () => 'Restored',
      registerRecentProject: recent,
      now: () => new Date('2026-11-10T00:00:00.000Z'),
    }
    registerSyncController(deps)
    const call = async (channel: string, argument: unknown) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`missing handler: ${channel}`)
      return handler(null, argument)
    }

    const configured = await call('sync:configure', {
      projectSession: project,
      endpoint: 'http://127.0.0.1:8787',
      token: 'token',
    }) as { success: true; view: { server: { configured: boolean } } }
    expect(configured.success).toBe(true)
    expect(configured.view.server.configured).toBe(true)

    const bound = await call('sync:bind', { projectSession: project, remoteProjectId: 'local-project' }) as {
      success: true
      binding: { remoteProjectId: string; lastVersion: number }
    }
    expect(bound).toMatchObject({ success: true, binding: { remoteProjectId: 'local-project', lastVersion: 0 } })

    const acquired = await call('sync:acquire', { projectSession: project }) as { success: true; lease: { leaseId: string } }
    expect(acquired.lease.leaseId).toBe('remote-lease')

    const upload = await call('sync:upload', { projectSession: project }) as {
      success: true
      head: { headVersion: number }
      binding: { lastVersion: number }
      bindingSaved: boolean
    }
    expect(upload).toMatchObject({ success: true, head: { headVersion: 1 }, binding: { lastVersion: 1 }, bindingSaved: true })
    expect(uploaded).toHaveLength(1)
    expect(uploaded[0]).toMatchObject({
      projectId: 'local-project',
      baseVersion: 0,
      leaseId: 'remote-lease',
      deviceName: expect.any(String),
      force: false,
    })

    const status = await call('sync:status', { projectSession: project }) as { success: true; head: { headVersion: number } }
    expect(status.head.headVersion).toBe(1)

    const download = await call('sync:download', {
      projectSession: project,
      version: 1,
      targetGrantId: 'restore-grant',
    }) as {
      success: true
      receipt: { targetProjectId: string }
      binding: { localProjectId: string; lastVersion: number }
      bindingSaved: boolean
    }
    expect(download).toMatchObject({
      success: true,
      receipt: { targetProjectId: 'restored-project' },
      binding: { localProjectId: 'restored-project', lastVersion: 1 },
      bindingSaved: true,
    })
    expect(recent).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'restored-project', name: 'Restored' }))

    const standaloneConfigured = await call('sync:configure-server', {
      endpoint: 'http://127.0.0.1:8787',
      token: 'token',
    }) as { success: true; server: { configured: boolean } }
    expect(standaloneConfigured).toMatchObject({ success: true, server: { configured: true } })

    const remoteStatus = await call('sync:remote-status', { remoteProjectId: 'local-project' }) as {
      success: true
      head: { headVersion: number }
    }
    expect(remoteStatus).toMatchObject({ success: true, head: { headVersion: 1 } })

    const recoveryView = await call('sync:recovery-view', undefined) as {
      success: true
      view: { server: { endpoint: string | null; configured: boolean }; remoteProjectId: string | null }
    }
    expect(recoveryView.view).toMatchObject({
      server: { endpoint: 'http://127.0.0.1:8787/', configured: true },
      remoteProjectId: 'local-project',
    })

    const remoteDownload = await call('sync:remote-download', {
      remoteProjectId: 'local-project',
      version: 1,
      targetGrantId: 'standalone-grant',
    }) as {
      success: true
      receipt: { targetProjectId: string }
      binding: { localProjectId: string; lastVersion: number }
    }
    expect(remoteDownload).toMatchObject({
      success: true,
      receipt: { targetProjectId: 'restored-project' },
      binding: { localProjectId: 'restored-project', lastVersion: 1 },
    })

    const targetStatus = await call('sync:remote-status', { remoteProjectId: 'local-project' }) as {
      restoreTarget: { configured: boolean; displayName: string | null }
    }
    expect(targetStatus.restoreTarget).toEqual({ configured: true, displayName: 'restored-target' })

    const autoUpdate = await call('sync:remote-download', {
      remoteProjectId: 'local-project',
      version: 1,
    }) as {
      success: true
      receipt: { targetProjectRoot: string }
    }
    expect(autoUpdate.success).toBe(true)
    expect(fs.existsSync(path.join(root, 'restored-target', '.ai-novel', 'project.db'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'restored-target.pagekin-sync-backup'))).toBe(true)
  })
})
