export interface SyncProjectSessionContext {
  projectId: string
  leaseId: string
  projectPath: string
}

export type SyncTokenPersistence = 'none' | 'os-backed' | 'session-only'

export interface SyncServerView {
  endpoint: string | null
  configured: boolean
  tokenPersistence: SyncTokenPersistence
}

export interface SyncBindingView {
  localProjectId: string
  remoteProjectId: string
  lastVersion: number
}

export interface SyncLeaseView {
  leaseId: string
  owner: string
  expiresAt: string
}

export interface SyncSnapshotView {
  version: number
  sha256: string
  byteSize: number
  createdAt: string
  originProjectId: string
  /** Hostname that uploaded this snapshot, or `unknown` for old metadata. */
  deviceName: string
  /** Versions this snapshot was based on. A forced overwrite records both sides. */
  parentVersions: number[]
  /** True when the upload intentionally replaced a newer remote head. */
  forced: boolean
}

export interface SyncHeadView {
  projectId: string
  headVersion: number
  lease: Omit<SyncLeaseView, 'leaseId'> | null
  snapshots: SyncSnapshotView[]
}

export interface SyncView {
  server: SyncServerView
  binding: SyncBindingView | null
  /** Main-process lease cache for this app session; it is not proof the remote lease is still live. */
  lease: SyncLeaseView | null
  /** This computer's hostname, used to label a divergent local branch. */
  deviceName: string
}

export type SyncErrorCode =
  | 'SYNC_INPUT_INVALID'
  | 'SYNC_NOT_CONFIGURED'
  | 'SYNC_CREDENTIAL_UNAVAILABLE'
  | 'SYNC_AUTH_FAILED'
  | 'SYNC_NETWORK_FAILED'
  | 'SYNC_REMOTE_INVALID'
  | 'SYNC_REMOTE_NOT_FOUND'
  | 'SYNC_RESTORE_TARGET_MISSING'
  | 'SYNC_RESTORE_TARGET_INVALID'
  | 'SYNC_RESTORE_TARGET_OPEN'
  | 'SYNC_LEASE_HELD'
  | 'SYNC_LEASE_REQUIRED'
  | 'SYNC_LEASE_EXPIRED'
  | 'SYNC_UPLOAD_IN_PROGRESS'
  | 'SYNC_RATE_LIMITED'
  | 'SYNC_SNAPSHOT_LIMIT_REACHED'
  | 'SYNC_VERSION_CONFLICT'
  | 'SYNC_ARCHIVE_FAILED'
  | 'SYNC_RESTORE_FAILED'
  | 'SYNC_LOCAL_STATE_NOT_SAVED'
  | 'SYNC_CANCELLED'
  | 'SYNC_FAILED'

export interface SyncFailure {
  success: false
  state: 'cancelled' | 'failed'
  errorCode: SyncErrorCode
}

export interface SyncConfigureRequest {
  projectSession: SyncProjectSessionContext
  endpoint: string
  token: string
}

export interface SyncServerConfigureRequest {
  endpoint: string
  token: string
}

export interface SyncRecoveryView {
  server: SyncServerView
  remoteProjectId: string | null
}

export interface SyncRemoteStatusRequest {
  remoteProjectId: string
}

export interface SyncRestoreTargetView {
  configured: boolean
  /** Display basename only; the renderer never needs the absolute path. */
  displayName: string | null
}

export interface SyncRemoteDownloadRequest {
  remoteProjectId: string
  version: number
  /** Omit to update the last restored copy for this remote project. */
  targetGrantId?: string
}

export interface SyncBindRequest {
  projectSession: SyncProjectSessionContext
  remoteProjectId: string
}

export interface SyncStatusRequest {
  projectSession: SyncProjectSessionContext
}

export interface SyncAcquireRequest {
  projectSession: SyncProjectSessionContext
  ttlSeconds?: number
}

export interface SyncReleaseRequest {
  projectSession: SyncProjectSessionContext
  leaseId: string
}

export interface SyncUploadRequest {
  projectSession: SyncProjectSessionContext
  /** Explicitly replace a newer remote head with this computer's snapshot. */
  force?: boolean
  /** The HEAD version the author saw when choosing this computer. */
  expectedHeadVersion?: number
}

export interface SyncDownloadRequest {
  projectSession: SyncProjectSessionContext
  version: number
  /** dialog:select-project-restore-target 签发的授权标识；渲染进程不得携带路径。 */
  targetGrantId: string
}

export interface SyncRestoreReceiptView {
  originProjectId: string
  targetProjectId: string
  targetProjectRoot: string
  snapshotGeneration: string
  portableDatabaseSha256: string
  requiresRuntimeFreezeGuard: true
}

export interface SyncChannels {
  'sync:view': {
    args: [projectSession: SyncProjectSessionContext]
    return: { success: true; view: SyncView } | SyncFailure
  }
  'sync:configure': {
    args: [request: SyncConfigureRequest]
    return: { success: true; view: SyncView } | SyncFailure
  }
  'sync:configure-server': {
    args: [request: SyncServerConfigureRequest]
    return: { success: true; server: SyncServerView } | SyncFailure
  }
  'sync:recovery-view': {
    args: []
    return: { success: true; view: SyncRecoveryView } | SyncFailure
  }
  'sync:remote-status': {
    args: [request: SyncRemoteStatusRequest]
    return: {
      success: true
      head: SyncHeadView
      restoreTarget: SyncRestoreTargetView
    } | SyncFailure
  }
  'sync:remote-download': {
    args: [request: SyncRemoteDownloadRequest]
    return: {
      success: true
      receipt: SyncRestoreReceiptView
      binding: SyncBindingView | null
      bindingSaved: boolean
      recentProjectUpdated: boolean
    } | SyncFailure
  }
  'sync:clear-config': {
    args: [projectSession: SyncProjectSessionContext]
    return: { success: true; view: SyncView } | SyncFailure
  }
  'sync:bind': {
    args: [request: SyncBindRequest]
    return: { success: true; binding: SyncBindingView } | SyncFailure
  }
  'sync:status': {
    args: [request: SyncStatusRequest]
    return: { success: true; head: SyncHeadView } | SyncFailure
  }
  'sync:acquire': {
    args: [request: SyncAcquireRequest]
    return: { success: true; lease: SyncLeaseView } | SyncFailure
  }
  'sync:release': {
    args: [request: SyncReleaseRequest]
    return: { success: true } | SyncFailure
  }
  'sync:upload': {
    args: [request: SyncUploadRequest]
    return: {
      success: true
      head: SyncHeadView
      binding: SyncBindingView
      bindingSaved: boolean
    } | SyncFailure
  }
  'sync:download': {
    args: [request: SyncDownloadRequest]
    return: {
      success: true
      receipt: SyncRestoreReceiptView
      binding: SyncBindingView | null
      bindingSaved: boolean
      recentProjectUpdated: boolean
    } | SyncFailure
  }
}
