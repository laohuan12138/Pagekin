import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { ipcMain, safeStorage } from 'electron'

import type {
  SyncBindingView,
  SyncErrorCode,
  SyncFailure,
  SyncProjectSessionContext,
  SyncRestoreReceiptView,
  SyncServerView,
} from '../../src/shared/sync-service'
import { CANONICAL_PROJECT_DATABASE, CANONICAL_PROJECT_DIRECTORY } from '../../src/shared/project-format'
import { getCurrentProjectPath } from '../database'
import {
  normalizeSyncEndpoint,
  SyncConfigStore,
  type ResolvedSyncServer,
  type SyncConfigView,
} from '../services/sync-config-store'
import { SyncHttpClient, SyncHttpError } from '../services/sync-http-client'
import { SyncRestoreTargetStore, type SyncRestoreTarget } from '../services/sync-restore-target-store'
import { getGlobalDataRoot } from '../services/app-data-locator'
import { externalFileGrants } from '../services/external-file-grant-service'
import { projectAccess } from '../services/project-access'
import {
  exportPortableProject,
  type ExportPortableProjectInput,
  type ExportPortableProjectReceipt,
  type PortableAssetProvider,
} from '../services/project-archive-service'
import { createPortableProjectAssetProvider } from '../services/portable-project-assets'
import {
  restorePortableProject,
  type RestorePortableProjectInput,
  type RestorePortableProjectReceipt,
} from '../services/project-restore-service'
import { removeDirectoryWithWindowsRetry } from '../utils/remove-directory'
import { registerRecentProject, type RecentProject } from './project-controller'

const require = createRequire(import.meta.url)
const BetterSqlite = require('better-sqlite3') as typeof import('better-sqlite3')
const STAGING_DIRECTORY = 'sync-staging'
const DEFAULT_LEASE_TTL_SECONDS = 900
const MAX_LEASE_TTL_SECONDS = 3_600

interface SyncIpcRegistrar {
  handle(channel: string, handler: (_event: unknown, argument: unknown) => unknown): void
}

interface SyncConfigFacade {
  view(localProjectId: string): SyncConfigView
  saveServer(endpoint: string, token: string): SyncServerView
  clearServer(): void
  resolveServer(): ResolvedSyncServer | null
  saveBinding(localProjectId: string, remoteProjectId: string, lastVersion: number): SyncBindingView
  getBinding(localProjectId: string): SyncBindingView | null
}

interface SyncRestoreTargetFacade {
  get(remoteProjectId: string): SyncRestoreTarget | null
  save(remoteProjectId: string, targetRoot: string): void
  clear(remoteProjectId: string): void
}

interface ActiveLease {
  leaseId: string
  remoteProjectId: string
  expiresAt: string
}

export interface SyncControllerDependencies {
  ipc: SyncIpcRegistrar
  configStore: SyncConfigFacade
  createClient(endpoint: string, token: string): SyncHttpClient
  exportPortableProject(input: ExportPortableProjectInput): Promise<ExportPortableProjectReceipt>
  restorePortableProject(input: RestorePortableProjectInput): Promise<RestorePortableProjectReceipt>
  portableAssets: PortableAssetProvider
  assertCurrentProjectContext(context: SyncProjectSessionContext | undefined, currentProjectPath: string | null): {
    projectId: string
    leaseId: string
    rootPath: string
  }
  getCurrentProjectPath(): string | null
  sameCanonicalProjectRoot(left: string, right: string): boolean
  getGlobalDataRoot(): string
  restoreTargets?: SyncRestoreTargetFacade
  resolveRestoreTargetGrant(event: unknown, grantId: string): string
  readRestoredProjectName(projectRoot: string): string
  registerRecentProject(project: RecentProject): void
  now(): Date
}

class SyncControllerError extends Error {
  constructor(readonly code: SyncErrorCode) {
    super(code)
    this.name = 'SyncControllerError'
  }
}

function fail(code: SyncErrorCode): never {
  throw new SyncControllerError(code)
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SYNC_INPUT_INVALID')
  return value as Record<string, unknown>
}

function string(value: unknown): string {
  if (typeof value !== 'string' || !value) fail('SYNC_INPUT_INVALID')
  return value
}

function integer(value: unknown, minimum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum) fail('SYNC_INPUT_INVALID')
  return value as number
}

function projectSession(value: unknown): SyncProjectSessionContext {
  const source = record(value)
  return {
    projectId: string(source.projectId),
    leaseId: string(source.leaseId),
    projectPath: string(source.projectPath),
  }
}

function remoteProjectId(value: unknown): string {
  const candidate = string(value)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(candidate)) fail('SYNC_INPUT_INVALID')
  return candidate
}

function senderId(event: unknown): number {
  if (!event || typeof event !== 'object' || !('sender' in event)) fail('SYNC_INPUT_INVALID')
  const sender = event.sender
  if (!sender || typeof sender !== 'object' || !('id' in sender) || typeof sender.id !== 'number') {
    fail('SYNC_INPUT_INVALID')
  }
  return sender.id
}

function mapHttpCode(error: SyncHttpError): SyncErrorCode {
  if (error.status === 401) return 'SYNC_AUTH_FAILED'
  if (error.status === 404) return 'SYNC_REMOTE_NOT_FOUND'
  if (error.code === 'UPLOAD_IN_PROGRESS') return 'SYNC_UPLOAD_IN_PROGRESS'
  if (error.code === 'TOO_MANY_UPLOADS' || error.status === 429) return 'SYNC_RATE_LIMITED'
  if (error.code === 'SNAPSHOT_LIMIT_REACHED') return 'SYNC_SNAPSHOT_LIMIT_REACHED'
  if (error.status === 409) return 'SYNC_VERSION_CONFLICT'
  if (error.status === 423) {
    if (error.code === 'LEASE_EXPIRED') return 'SYNC_LEASE_EXPIRED'
    if (error.code === 'LEASE_REQUIRED') return 'SYNC_LEASE_REQUIRED'
    return 'SYNC_LEASE_HELD'
  }
  if (error.status === 413) return 'SYNC_REMOTE_INVALID'
  if (error.code === 'SHA256_MISMATCH' || error.code === 'REMOTE_INVALID') return 'SYNC_REMOTE_INVALID'
  if (error.status >= 500) return 'SYNC_FAILED'
  return 'SYNC_FAILED'
}

function errorCode(error: unknown): SyncErrorCode {
  if (error instanceof SyncControllerError) return error.code
  if (error instanceof SyncHttpError) return mapHttpCode(error)
  if (error instanceof TypeError || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))) {
    return 'SYNC_NETWORK_FAILED'
  }
  if (error instanceof Error) {
    if (error.message === 'SYNC_NOT_CONFIGURED') return 'SYNC_NOT_CONFIGURED'
    if (error.message === 'SYNC_CONFIG_INVALID') return 'SYNC_INPUT_INVALID'
    if (error.message === 'PORTABLE_RESTORE_CANCELLED') return 'SYNC_CANCELLED'
    if (error.message === 'PORTABLE_RESTORE_INVALID' || error.message === 'PORTABLE_RESTORE_TARGET_EXISTS') {
      return 'SYNC_RESTORE_FAILED'
    }
  }
  return 'SYNC_FAILED'
}

function failure(error: unknown): SyncFailure {
  const code = errorCode(error)
  return {
    success: false,
    state: code === 'SYNC_CANCELLED' ? 'cancelled' : 'failed',
    errorCode: code,
  }
}

function createStagingRoot(dataRoot: string): string {
  const parent = path.join(path.resolve(dataRoot), STAGING_DIRECTORY)
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  const root = fs.mkdtempSync(path.join(parent, 'sync-'))
  try { fs.chmodSync(root, 0o700) } catch { /* Windows may not expose POSIX modes. */ }
  return root
}

async function removeStagingRoot(dataRoot: string, stagingRoot: string): Promise<void> {
  const parent = path.join(path.resolve(dataRoot), STAGING_DIRECTORY)
  const relative = path.relative(parent, stagingRoot)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return
  try {
    await removeDirectoryWithWindowsRetry(stagingRoot)
  } catch { /* Best effort: the uploaded or restored data is already committed. */ }
}

function isCanonicalProjectRoot(projectRoot: string): boolean {
  try {
    return fs.statSync(projectRoot).isDirectory()
      && fs.existsSync(path.join(projectRoot, CANONICAL_PROJECT_DIRECTORY, CANONICAL_PROJECT_DATABASE))
  } catch {
    return false
  }
}

function readRestoredProjectName(projectRoot: string): string {
  const database = new BetterSqlite(
    path.join(projectRoot, CANONICAL_PROJECT_DIRECTORY, CANONICAL_PROJECT_DATABASE),
    { readonly: true, fileMustExist: true },
  )
  try {
    const row = database.prepare("SELECT project_name FROM project_core WHERE id = 'main'").get() as {
      project_name?: unknown
    } | undefined
    const name = typeof row?.project_name === 'string' ? row.project_name.trim() : ''
    if (!name) throw new Error('RESTORED_PROJECT_NAME_INVALID')
    return name
  } finally {
    database.close()
  }
}

function productionDependencies(): SyncControllerDependencies {
  return {
    ipc: {
      handle(channel, handler) {
        ipcMain.handle(channel, (event, argument) => handler(event, argument))
      },
    },
    configStore: new SyncConfigStore({ safeStorage }),
    createClient: (endpoint, token) => new SyncHttpClient({ endpoint, token }),
    exportPortableProject,
    restorePortableProject,
    portableAssets: createPortableProjectAssetProvider(),
    assertCurrentProjectContext: (context, currentPath) => projectAccess.assertCurrentProjectContext(context, currentPath),
    getCurrentProjectPath,
    sameCanonicalProjectRoot: (left, right) => projectAccess.sameCanonicalProjectRoot(left, right),
    getGlobalDataRoot,
    resolveRestoreTargetGrant: (event, grantId) => externalFileGrants.resolveExactPath({
      grantId,
      webContentsId: senderId(event),
      operation: 'create',
    }),
    readRestoredProjectName,
    registerRecentProject,
    now: () => new Date(),
  }
}

export function registerSyncController(injected?: SyncControllerDependencies): void {
  const deps = injected ?? productionDependencies()
  const leases = new Map<string, ActiveLease>()
  const restoreTargets = deps.restoreTargets ?? new SyncRestoreTargetStore({ rootPath: deps.getGlobalDataRoot() })

  const active = (raw: unknown) => deps.assertCurrentProjectContext(projectSession(raw), deps.getCurrentProjectPath())
  const server = () => {
    const resolved = deps.configStore.resolveServer()
    if (!resolved?.token) fail('SYNC_NOT_CONFIGURED')
    return resolved
  }
  const binding = (localProjectId: string) => {
    const current = deps.configStore.getBinding(localProjectId)
    if (!current) fail('SYNC_NOT_CONFIGURED')
    return current
  }
  const clientFor = () => {
    const resolved = server()
    return { client: deps.createClient(resolved.endpoint, resolved.token), resolved }
  }
  const configureServer = async (endpointValue: unknown, tokenValue: unknown) => {
    const endpoint = normalizeSyncEndpoint(string(endpointValue))
    const token = string(tokenValue)
    const client = deps.createClient(endpoint, token)
    await client.check()
    deps.configStore.saveServer(endpoint, token)
    leases.clear()
  }
  const viewFor = (localProjectId: string) => {
    const current = deps.configStore.view(localProjectId)
    const cached = leases.get(localProjectId)
    const lease = cached && Date.parse(cached.expiresAt) > deps.now().getTime()
      ? { leaseId: cached.leaseId, owner: os.hostname(), expiresAt: cached.expiresAt }
      : null
    if (!lease) leases.delete(localProjectId)
    return { ...current, lease, deviceName: os.hostname() }
  }
  const restoreTargetView = (remoteProjectId: string) => {
    const target = restoreTargets.get(remoteProjectId)
    if (!target || !isCanonicalProjectRoot(target.targetRoot)) {
      return { configured: false as const, displayName: null }
    }
    return { configured: true as const, displayName: path.basename(target.targetRoot) }
  }

  deps.ipc.handle('sync:view', (_event, raw) => {
    try {
      const project = active(raw)
      return { success: true as const, view: viewFor(project.projectId) }
    } catch (error) {
      return failure(error)
    }
  })

  deps.ipc.handle('sync:configure', async (_event, raw) => {
    try {
      const request = record(raw)
      const project = active(request.projectSession)
      await configureServer(request.endpoint, request.token)
      return { success: true as const, view: viewFor(project.projectId) }
    } catch (error) {
      return failure(error)
    }
  })

  deps.ipc.handle('sync:configure-server', async (_event, raw) => {
    try {
      const request = record(raw)
      await configureServer(request.endpoint, request.token)
      return { success: true as const, server: deps.configStore.view('').server }
    } catch (error) {
      return failure(error)
    }
  })

  deps.ipc.handle('sync:remote-status', async (_event, raw) => {
    try {
      const remote = remoteProjectId(record(raw).remoteProjectId)
      const { client } = clientFor()
      return {
        success: true as const,
        head: await client.status(remote),
        restoreTarget: restoreTargetView(remote),
      }
    } catch (error) {
      return failure(error)
    }
  })

  deps.ipc.handle('sync:clear-config', (_event, raw) => {
    try {
      const project = active(raw)
      deps.configStore.clearServer()
      leases.clear()
      return { success: true as const, view: viewFor(project.projectId) }
    } catch (error) {
      return failure(error)
    }
  })

  deps.ipc.handle('sync:bind', async (_event, raw) => {
    try {
      const request = record(raw)
      const project = active(request.projectSession)
      const remote = remoteProjectId(request.remoteProjectId)
      const { client } = clientFor()
      const head = await client.status(remote)
      const saved = deps.configStore.saveBinding(project.projectId, remote, head.headVersion)
      leases.delete(project.projectId)
      return { success: true as const, binding: saved }
    } catch (error) {
      return failure(error)
    }
  })

  deps.ipc.handle('sync:status', async (_event, raw) => {
    try {
      const project = active(record(raw).projectSession)
      const current = binding(project.projectId)
      const { client } = clientFor()
      return { success: true as const, head: await client.status(current.remoteProjectId) }
    } catch (error) {
      return failure(error)
    }
  })

  deps.ipc.handle('sync:acquire', async (_event, raw) => {
    try {
      const request = record(raw)
      const project = active(request.projectSession)
      const current = binding(project.projectId)
      const ttl = request.ttlSeconds === undefined
        ? DEFAULT_LEASE_TTL_SECONDS
        : Math.min(MAX_LEASE_TTL_SECONDS, integer(request.ttlSeconds, 30))
      const cached = leases.get(project.projectId)
      const { client } = clientFor()
      const lease = await client.acquireLease(
        current.remoteProjectId,
        os.hostname(),
        ttl,
        cached?.remoteProjectId === current.remoteProjectId ? cached.leaseId : undefined,
      )
      leases.set(project.projectId, {
        leaseId: lease.leaseId,
        remoteProjectId: current.remoteProjectId,
        expiresAt: lease.expiresAt,
      })
      return { success: true as const, lease }
    } catch (error) {
      return failure(error)
    }
  })

  deps.ipc.handle('sync:release', async (_event, raw) => {
    try {
      const request = record(raw)
      const project = active(request.projectSession)
      const current = binding(project.projectId)
      const leaseId = string(request.leaseId)
      const { client } = clientFor()
      await client.releaseLease(current.remoteProjectId, leaseId)
      if (leases.get(project.projectId)?.leaseId === leaseId) leases.delete(project.projectId)
      return { success: true as const }
    } catch (error) {
      return failure(error)
    }
  })

  deps.ipc.handle('sync:upload', async (_event, raw) => {
    let stagingRoot: string | null = null
    try {
      const request = record(raw)
      const session = projectSession(request.projectSession)
      const project = active(session)
      const force = request.force === true
      const expectedHeadVersion = request.expectedHeadVersion === undefined
        ? undefined
        : integer(request.expectedHeadVersion, 0)
      const current = binding(project.projectId)
      const cached = leases.get(project.projectId)
      if (!cached || Date.parse(cached.expiresAt) <= deps.now().getTime()) fail('SYNC_LEASE_REQUIRED')
      const { client } = clientFor()
      const dataRoot = deps.getGlobalDataRoot()
      stagingRoot = createStagingRoot(dataRoot)
      const archivePath = path.join(stagingRoot, 'snapshot.ainovel')
      const receipt = await deps.exportPortableProject({
        sourceProjectRoot: project.rootPath,
        projectSession: session,
        targetArchivePath: archivePath,
        attemptParentPath: stagingRoot,
        assets: deps.portableAssets,
        assertCurrentContext(context, sourceProjectRoot) {
          const checked = deps.assertCurrentProjectContext(context, deps.getCurrentProjectPath())
          return deps.sameCanonicalProjectRoot(checked.rootPath, sourceProjectRoot)
        },
      }).catch(() => fail('SYNC_ARCHIVE_FAILED'))
      const currentAfterExport = deps.configStore.getBinding(project.projectId)
      if (!currentAfterExport
        || currentAfterExport.remoteProjectId !== current.remoteProjectId
        || currentAfterExport.lastVersion !== current.lastVersion) {
        fail('SYNC_VERSION_CONFLICT')
      }
      const head = await client.uploadSnapshot({
        projectId: current.remoteProjectId,
        baseVersion: current.lastVersion,
        leaseId: cached.leaseId,
        archivePath,
        originProjectId: receipt.originProjectId,
        deviceName: os.hostname(),
        force,
        expectedHeadVersion,
      })
      let saved: SyncBindingView
      let bindingSaved = true
      try {
        saved = deps.configStore.saveBinding(project.projectId, current.remoteProjectId, head.headVersion)
      } catch {
        saved = { ...current, lastVersion: head.headVersion }
        bindingSaved = false
      }
      return { success: true as const, head, binding: saved, bindingSaved }
    } catch (error) {
      return failure(error)
    } finally {
      if (stagingRoot) await removeStagingRoot(deps.getGlobalDataRoot(), stagingRoot)
    }
  })

  const restoreRemoteSnapshot = async (
    event: unknown,
    remote: string,
    version: number,
    targetGrantId?: string,
  ) => {
    let stagingRoot: string | null = null
    let temporaryTarget: string | null = null
    let replacingTarget = false
    try {
      let targetProjectRoot: string
      if (targetGrantId !== undefined) {
        try { targetProjectRoot = deps.resolveRestoreTargetGrant(event, targetGrantId) }
        catch { fail('SYNC_INPUT_INVALID') }
      } else {
        const remembered = restoreTargets.get(remote)
        if (!remembered) fail('SYNC_RESTORE_TARGET_MISSING')
        targetProjectRoot = remembered.targetRoot
        if (!isCanonicalProjectRoot(targetProjectRoot)) fail('SYNC_RESTORE_TARGET_INVALID')
        const current = deps.getCurrentProjectPath()
        if (current && deps.sameCanonicalProjectRoot(current, targetProjectRoot)) {
          fail('SYNC_RESTORE_TARGET_OPEN')
        }
        replacingTarget = true
        temporaryTarget = path.join(
          path.dirname(targetProjectRoot),
          `.${path.basename(targetProjectRoot)}.pagekin-sync-${randomUUID()}`,
        )
      }
      const restoreTarget = temporaryTarget ?? targetProjectRoot
      const { client } = clientFor()
      const head = await client.status(remote)
      const snapshot = head.snapshots.find(candidate => candidate.version === version)
      if (!snapshot) fail('SYNC_REMOTE_NOT_FOUND')
      const dataRoot = deps.getGlobalDataRoot()
      stagingRoot = createStagingRoot(dataRoot)
      const archivePath = path.join(stagingRoot, 'snapshot.ainovel')
      await client.downloadSnapshot({
        projectId: remote,
        version,
        targetPath: archivePath,
        expectedSha: snapshot.sha256,
      })
        .catch(error => {
          if (error instanceof SyncHttpError && error.code === 'SHA256_MISMATCH') fail('SYNC_REMOTE_INVALID')
          throw error
        })
      const receipt = await deps.restorePortableProject({ archivePath, targetProjectRoot: restoreTarget })
        .catch(() => fail('SYNC_RESTORE_FAILED'))

      if (replacingTarget) {
        const backupRoot = `${targetProjectRoot}.pagekin-sync-backup`
        try { fs.rmSync(backupRoot, { recursive: true, force: true }) }
        catch { fail('SYNC_RESTORE_TARGET_INVALID') }
        try { fs.renameSync(targetProjectRoot, backupRoot) }
        catch { fail('SYNC_RESTORE_TARGET_INVALID') }
        try {
          fs.renameSync(restoreTarget, targetProjectRoot)
        } catch {
          try { fs.renameSync(backupRoot, targetProjectRoot) } catch { /* Preserve the backup. */ }
          fail('SYNC_RESTORE_TARGET_INVALID')
        }
      }

      try { restoreTargets.save(remote, targetProjectRoot) }
      catch { /* The restored copy remains usable even if its auto-update target was not saved. */ }

      let bindingSaved = false
      let saved: SyncBindingView | null = null
      try {
        saved = deps.configStore.saveBinding(receipt.targetProjectId, remote, version)
        bindingSaved = true
      } catch { /* The restored project remains authoritative even if its local binding is lost. */ }
      let recentProjectUpdated = false
      try {
        deps.registerRecentProject({
          name: deps.readRestoredProjectName(targetProjectRoot),
          path: targetProjectRoot,
          projectId: receipt.targetProjectId,
          updatedAt: deps.now().toISOString(),
        })
        recentProjectUpdated = true
      } catch { /* The restored project remains on disk and can be opened explicitly. */ }
      const view: SyncRestoreReceiptView = {
        originProjectId: receipt.originProjectId,
        targetProjectId: receipt.targetProjectId,
        targetProjectRoot,
        snapshotGeneration: receipt.snapshotGeneration,
        portableDatabaseSha256: receipt.portableDatabaseSha256,
        requiresRuntimeFreezeGuard: true,
      }
      return { receipt: view, binding: saved, bindingSaved, recentProjectUpdated }
    } finally {
      if (temporaryTarget) {
        try { fs.rmSync(temporaryTarget, { recursive: true, force: true }) } catch { /* Best effort. */ }
      }
      if (stagingRoot) await removeStagingRoot(deps.getGlobalDataRoot(), stagingRoot)
    }
  }

  deps.ipc.handle('sync:download', async (event, raw) => {
    try {
      const request = record(raw)
      const project = active(request.projectSession)
      const current = binding(project.projectId)
      return {
        success: true as const,
        ...await restoreRemoteSnapshot(
          event,
          current.remoteProjectId,
          integer(request.version, 1),
          string(request.targetGrantId),
        ),
      }
    } catch (error) {
      return failure(error)
    }
  })

  deps.ipc.handle('sync:remote-download', async (event, raw) => {
    try {
      const request = record(raw)
      return {
        success: true as const,
        ...await restoreRemoteSnapshot(
          event,
          remoteProjectId(request.remoteProjectId),
          integer(request.version, 1),
          request.targetGrantId === undefined ? undefined : string(request.targetGrantId),
        ),
      }
    } catch (error) {
      return failure(error)
    }
  })
}
