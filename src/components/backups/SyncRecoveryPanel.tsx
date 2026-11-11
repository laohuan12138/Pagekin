import { useState } from 'react'
import { CloudDownload, RefreshCw } from 'lucide-react'

import { ipc } from '../../services/ipc-client'
import type { SyncHeadView, SyncRestoreTargetView } from '../../shared/sync-service'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'

type Notice = { kind: 'error' | 'success' | 'info'; text: string } | null

function failureCode(error: unknown): string {
  if (error && typeof error === 'object' && 'errorCode' in error) {
    const code = error.errorCode
    if (typeof code === 'string') return code
  }
  return error instanceof Error ? error.message : ''
}

export default function SyncRecoveryPanel() {
  const text = useLocaleStore(state => state.text)
  const [endpoint, setEndpoint] = useState('')
  const [token, setToken] = useState('')
  const [remoteProjectId, setRemoteProjectId] = useState('')
  const [connected, setConnected] = useState(false)
  const [head, setHead] = useState<SyncHeadView | null>(null)
  const [restoreTarget, setRestoreTarget] = useState<SyncRestoreTargetView>({ configured: false, displayName: null })
  const [selectedVersion, setSelectedVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)

  const explain = (code: string) => {
    switch (code) {
      case 'SYNC_INPUT_INVALID': return text('服务器地址、令牌或远端作品标识格式不正确。', 'The server address, token, or remote project ID is invalid.')
      case 'SYNC_NOT_CONFIGURED': return text('还没有配置同步服务。', 'The sync server is not configured.')
      case 'SYNC_AUTH_FAILED': return text('服务器拒绝了这个令牌。', 'The server rejected this token.')
      case 'SYNC_NETWORK_FAILED': return text('连不上同步服务器，请检查地址和网络。', 'Could not reach the sync server. Check the address and network.')
      case 'SYNC_REMOTE_NOT_FOUND': return text('远端没有这个作品或这个快照版本。', 'The remote project or snapshot version does not exist.')
      case 'SYNC_RESTORE_TARGET_MISSING': return text('还没有可更新的恢复副本，请先另存为新副本。', 'There is no restored copy to update yet. Save a new copy first.')
      case 'SYNC_RESTORE_TARGET_INVALID': return text('上次恢复的副本目录不存在或不是有效项目，请另存为新副本。', 'The last restored copy is missing or is not a valid project. Save a new copy.')
      case 'SYNC_RESTORE_TARGET_OPEN': return text('要更新的副本正在打开，请先关闭该项目再试。', 'The copy being updated is open. Close that project first.')
      case 'SYNC_RESTORE_FAILED': return text('快照已下载，但恢复成项目副本失败。', 'The snapshot downloaded, but restoring it as a project copy failed.')
      default: return text(`同步恢复失败（${code || '未知错误'}）`, `Sync recovery failed (${code || 'unknown error'})`)
    }
  }

  const fail = (code: string) => setNotice({ kind: 'error', text: explain(code) })
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setNotice(null)
    try {
      await action()
    } catch (error) {
      fail(failureCode(error))
    } finally {
      setBusy(false)
    }
  }

  const loadRemote = () => run(async () => {
    const configured = await ipc.invoke('sync:configure-server', {
      endpoint: endpoint.trim(),
      token,
    })
    if (!configured.success) throw new Error(configured.errorCode)
    const result = await ipc.invoke('sync:remote-status', {
      remoteProjectId: remoteProjectId.trim(),
    })
    if (!result.success) throw new Error(result.errorCode)
    setConnected(true)
    setToken('')
    setHead(result.head)
    setRestoreTarget(result.restoreTarget)
    setSelectedVersion(result.head.snapshots.at(-1)?.version ?? 0)
    setNotice({
      kind: 'success',
      text: text(
        `已连接远端作品 ${result.head.projectId}，当前版本 ${result.head.headVersion}。请选择版本后点击“下载并恢复为新副本”。`,
        `Connected to remote ${result.head.projectId}; current version ${result.head.headVersion}. Select a version, then choose “Download and restore as copy”.`,
      ),
    })
  })

  const refreshRemote = () => run(async () => {
    const result = await ipc.invoke('sync:remote-status', {
      remoteProjectId: remoteProjectId.trim(),
    })
    if (!result.success) throw new Error(result.errorCode)
    setHead(result.head)
    setRestoreTarget(result.restoreTarget)
    setSelectedVersion(result.head.snapshots.at(-1)?.version ?? 0)
    setNotice({
      kind: 'success',
      text: text(
        `已刷新远端作品 ${result.head.projectId}，当前版本 ${result.head.headVersion}。`,
        `Refreshed remote ${result.head.projectId}; current version ${result.head.headVersion}.`,
      ),
    })
  })

  const restore = (useRemembered: boolean) => run(async () => {
    if (!head || !selectedVersion) throw new Error('SYNC_REMOTE_NOT_FOUND')
    let targetGrantId: string | undefined
    if (!useRemembered) {
      const target = await ipc.invoke('dialog:select-project-restore-target', text('同步恢复副本', 'Synced copy'))
      if (!target) return
      targetGrantId = target.grantId
    }
    const result = await ipc.invoke('sync:remote-download', {
      remoteProjectId: remoteProjectId.trim(),
      version: selectedVersion,
      ...(targetGrantId ? { targetGrantId } : {}),
    })
    if (!result.success) throw new Error(result.errorCode)
    await useProjectStore.getState().loadRecentProjects().catch(() => {})
    setRestoreTarget(current => ({
      configured: true,
      displayName: current.displayName
        ?? result.receipt.targetProjectRoot.split(/[\\/]/u).filter(Boolean).at(-1)
        ?? null,
    }))
    setNotice({
      kind: result.recentProjectUpdated ? 'success' : 'info',
      text: result.recentProjectUpdated
        ? text(
          `版本 ${selectedVersion} 已恢复到 ${result.receipt.targetProjectRoot}${useRemembered ? '；旧副本已保留为 .pagekin-sync-backup' : ''}`,
          `Version ${selectedVersion} restored to ${result.receipt.targetProjectRoot}${useRemembered ? '; the previous copy is kept as .pagekin-sync-backup' : ''}`,
        )
        : text(
          `版本 ${selectedVersion} 已恢复到 ${result.receipt.targetProjectRoot}，但书房记录没有更新。请用“打开作品”选择这个目录。`,
          `Version ${selectedVersion} restored to ${result.receipt.targetProjectRoot}, but the bookshelf was not updated. Open that folder with “Open project”.`,
        ),
    })
  })

  return <section className="space-y-3 rounded-lg border border-[var(--color-border)] p-4" data-testid="sync-recovery-panel">
    <h3 className="flex items-center gap-2 text-sm font-semibold"><CloudDownload size={16} />{text('自建同步恢复', 'Self-hosted sync recovery')}</h3>
    <p className="text-xs text-[var(--color-text-muted)]">{text('连接只读取远端版本列表。第一次下载选择目录并另存为新副本；之后“更新已恢复副本”会直接覆盖上次目录，旧副本保留为 .pagekin-sync-backup。', 'Connecting only reads the remote version list. The first download chooses a folder and saves a new copy; later “Update restored copy” replaces that folder and keeps the previous copy as .pagekin-sync-backup.')}</p>

    <div className="grid gap-3 sm:grid-cols-2">
      <div><Label htmlFor="sync-recovery-endpoint">{text('服务器地址', 'Server endpoint')}</Label><Input id="sync-recovery-endpoint" value={endpoint} placeholder="http://sync.example.com:8088" onChange={event => {
        setEndpoint(event.target.value)
        setConnected(false)
        setHead(null)
      }} /></div>
      <div><Label htmlFor="sync-recovery-token">{text('访问令牌', 'Access token')}</Label><Input id="sync-recovery-token" type="password" value={token} onChange={event => {
        setToken(event.target.value)
        setConnected(false)
        setHead(null)
      }} /></div>
      <div><Label htmlFor="sync-recovery-remote">{text('远端作品标识', 'Remote project ID')}</Label><Input id="sync-recovery-remote" value={remoteProjectId} onChange={event => {
        setRemoteProjectId(event.target.value)
        setHead(null)
      }} /></div>
    </div>

    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={busy || !endpoint.trim() || !token || !remoteProjectId.trim()} onClick={() => void loadRemote()}>
        <CloudDownload size={14} />{text('连接并读取版本', 'Connect and load versions')}
      </Button>
      {connected && <Button type="button" variant="outline" disabled={busy || !remoteProjectId.trim()} onClick={() => void refreshRemote()}>
        <RefreshCw size={14} />{text('刷新远端版本', 'Refresh remote versions')}
      </Button>}
      {restoreTarget.configured && <p className="w-full text-xs text-[var(--color-text-muted)]">{text(`上次恢复目录：${restoreTarget.displayName ?? '已记录'}`, `Last restored folder: ${restoreTarget.displayName ?? 'remembered'}`)}</p>}
      {restoreTarget.configured
        ? <>
          <Button type="button" disabled={busy || !head || !selectedVersion} onClick={() => void restore(true)}>
            <CloudDownload size={14} />{text('更新已恢复副本', 'Update restored copy')}
          </Button>
          <Button type="button" variant="outline" disabled={busy || !head || !selectedVersion} onClick={() => void restore(false)}>
            <CloudDownload size={14} />{text('另存为新副本', 'Save as a new copy')}
          </Button>
        </>
        : <Button type="button" disabled={busy || !head || !selectedVersion} onClick={() => void restore(false)}>
          <CloudDownload size={14} />{text('下载并恢复为新副本', 'Download and restore as copy')}
        </Button>}
    </div>

    {head && <div className="space-y-2">
      <p className="text-xs">{text(`远端 HEAD：版本 ${head.headVersion}。共 ${head.snapshots.length} 个快照，列表可滚动查看。`, `Remote HEAD: version ${head.headVersion}. ${head.snapshots.length} snapshots; scroll the list to view all.`)}</p>
      {head.snapshots.length === 0
        ? <p className="text-xs text-[var(--color-text-muted)]">{text('远端还没有快照。', 'The remote has no snapshots yet.')}</p>
        : <ul className="max-h-96 space-y-2 overflow-y-auto pr-1">
          {[...head.snapshots].reverse().map(snapshot => <li key={snapshot.version} className="rounded border border-[var(--color-border)] p-2 text-xs">
            <label className="flex items-center gap-2"><input type="radio" name="sync-recovery-version" checked={selectedVersion === snapshot.version} onChange={() => setSelectedVersion(snapshot.version)} /><strong>{text(`版本 ${snapshot.version}`, `Version ${snapshot.version}`)}</strong></label>
            <p>{new Date(snapshot.createdAt).toLocaleString()} · {snapshot.byteSize.toLocaleString()} bytes · SHA-256 {snapshot.sha256.slice(0, 12)}…</p>
            <p>{text('上传电脑', 'Uploaded by')}: {snapshot.deviceName} · {text('来源作品', 'Origin project')}: {snapshot.originProjectId}</p>
          </li>)}
        </ul>}
    </div>}

    {notice && <p role={notice.kind === 'error' ? 'alert' : 'status'} className="text-sm" style={{ color: notice.kind === 'error' ? 'var(--color-error-text)' : notice.kind === 'success' ? 'var(--color-success-text)' : 'var(--color-text-secondary)' }}>{notice.text}</p>}
  </section>
}
