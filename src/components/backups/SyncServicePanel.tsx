import { useEffect, useState } from 'react'
import { Cloud, Download, KeyRound, LockKeyhole, RefreshCw, Unplug, Upload } from 'lucide-react'

import type { ProjectData, ProjectSessionContext } from '../../shared/ipc-channels'
import type { SyncHeadView, SyncLeaseView, SyncView } from '../../shared/sync-service'
import { ipc } from '../../services/ipc-client'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { projectSessionContextFromProject } from '../../shared/project-session-context'
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

export default function SyncServicePanel() {
  const project = useProjectStore(state => state.currentProject)
  const session = projectSessionContextFromProject(project)
  const sessionKey = session
    ? `${session.projectId}\0${session.leaseId}\0${session.projectPath}`
    : project?.id ?? 'no-project'
  return <SyncServicePanelSession key={sessionKey} project={project} session={session} />
}

function SyncServicePanelSession({ project, session }: {
  project: ProjectData | null
  session: ProjectSessionContext | null
}) {
  const text = useLocaleStore(state => state.text)
  const [view, setView] = useState<SyncView | null>(null)
  const [head, setHead] = useState<SyncHeadView | null>(null)
  const [lease, setLease] = useState<SyncLeaseView | null>(null)
  const [endpoint, setEndpoint] = useState('')
  const [token, setToken] = useState('')
  const [remoteProjectId, setRemoteProjectId] = useState(project?.id ?? '')
  const [selectedVersion, setSelectedVersion] = useState(0)
  const [resolution, setResolution] = useState<'local' | 'remote' | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState(false)

  const explain = (code: string) => {
    switch (code) {
      case 'SYNC_INPUT_INVALID': return text('服务器地址或作品标识格式不正确。', 'The server address or project ID is invalid.')
      case 'SYNC_NOT_CONFIGURED': return text('还没有配置同步服务。', 'The sync server is not configured.')
      case 'SYNC_CREDENTIAL_UNAVAILABLE': return text('本机保存的同步令牌不可用，请重新填写。', 'The saved sync token is unavailable. Enter it again.')
      case 'SYNC_AUTH_FAILED': return text('服务器拒绝了这个令牌。', 'The server rejected this token.')
      case 'SYNC_NETWORK_FAILED': return text('连不上同步服务器，请检查地址、网络和 HTTPS。', 'Could not reach the sync server. Check the address, network and HTTPS.')
      case 'SYNC_REMOTE_INVALID': return text('服务器返回的数据不完整或校验失败。', 'The server returned invalid data or failed verification.')
      case 'SYNC_REMOTE_NOT_FOUND': return text('远端没有这个作品或这个快照版本。', 'The remote project or snapshot version does not exist.')
      case 'SYNC_LEASE_HELD': return text('另一台电脑正在写这个作品。等它释放写锁，或等租约过期。', 'Another computer is writing this project. Wait for it to release the lease or for the lease to expire.')
      case 'SYNC_LEASE_REQUIRED': return text('先获取写锁，再上传快照。', 'Acquire the write lease before uploading.')
      case 'SYNC_LEASE_EXPIRED': return text('写锁已过期，请重新获取。', 'The write lease expired. Acquire it again.')
      case 'SYNC_UPLOAD_IN_PROGRESS': return text('这个作品已有一个上传正在进行，等它结束后再试。', 'An upload for this project is already running. Wait for it to finish.')
      case 'SYNC_RATE_LIMITED': return text('请求太频繁，服务器暂时拒绝了。稍后再试。', 'Too many requests; the server temporarily rejected this one. Try again later.')
      case 'SYNC_SNAPSHOT_LIMIT_REACHED': return text('远端这个作品的快照数量已达上限。先在服务器上清理旧快照或调高上限。', 'The remote project reached its snapshot limit. Remove old snapshots on the server or raise the limit.')
      case 'SYNC_VERSION_CONFLICT': return text('远端已经有更新的版本。先刷新，再决定下载或重新绑定。', 'The remote has a newer version. Refresh, then download or rebind.')
      case 'SYNC_ARCHIVE_FAILED': return text('打包当前作品失败，项目没有上传。', 'Could not archive the current project; nothing was uploaded.')
      case 'SYNC_RESTORE_FAILED': return text('快照已下载，但恢复成项目副本失败。', 'The snapshot downloaded, but restoring it as a project copy failed.')
      case 'SYNC_LOCAL_STATE_NOT_SAVED': return text('同步设置没有保存成功，请检查本机数据目录。', 'The sync setting was not saved. Check the local data directory.')
      default: return text(`同步失败（${code || '未知错误'}）`, `Sync failed (${code || 'unknown error'})`)
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

  const applyView = (next: SyncView) => {
    setView(next)
    setEndpoint(next.server.endpoint ?? '')
    setRemoteProjectId(next.binding?.remoteProjectId ?? project?.id ?? '')
    if (!next.binding) {
      setHead(null)
      setLease(null)
      setSelectedVersion(0)
    }
  }

  const refreshStatus = async () => {
    if (!session) return
    const result = await ipc.invoke('sync:status', { projectSession: session })
    if (!result.success) throw new Error(result.errorCode)
    setHead(result.head)
    if (!result.head.lease) setLease(null)
    setSelectedVersion(current => current || result.head.snapshots.at(-1)?.version || 0)
  }

  const applyUpload = (result: {
    head: SyncHeadView
    binding: { remoteProjectId: string; lastVersion: number; localProjectId: string }
    bindingSaved: boolean
  }) => {
    setHead(result.head)
    setView(current => current ? { ...current, binding: result.binding } : current)
    const renewedUntil = result.head.lease?.expiresAt
    setLease(current => current && renewedUntil ? { ...current, expiresAt: renewedUntil } : current)
    return result
  }

  const ensureLease = async () => {
    if (lease && Date.parse(lease.expiresAt) > Date.now()) return lease
    if (!session) throw new Error('SYNC_LEASE_REQUIRED')
    const result = await ipc.invoke('sync:acquire', { projectSession: session })
    if (!result.success) throw new Error(result.errorCode)
    setLease(result.lease)
    return result.lease
  }

  const uploadCurrent = async (force: boolean, expectedHeadVersion?: number) => {
    if (!session) throw new Error('SYNC_NOT_CONFIGURED')
    await ensureLease()
    const result = await ipc.invoke('sync:upload', {
      projectSession: session,
      ...(force ? { force: true } : {}),
      ...(expectedHeadVersion === undefined ? {} : { expectedHeadVersion }),
    })
    if (!result.success) throw new Error(result.errorCode)
    applyUpload(result)
    return result
  }

  const downloadVersion = async (version: number) => {
    if (!session || !project) throw new Error('SYNC_NOT_CONFIGURED')
    const target = await ipc.invoke('dialog:select-project-restore-target', `${project.name}-同步副本`)
    if (!target) return null
    const result = await ipc.invoke('sync:download', { projectSession: session, version, targetGrantId: target.grantId })
    if (!result.success) throw new Error(result.errorCode)
    return result
  }

  const resolveWithLocal = () => run(async () => {
    if (!head) return
    const result = await uploadCurrent(true, head.headVersion)
    setResolution(null)
    setNotice({ kind: 'success', text: text(
      `已以本机 ${localDevice} 为准，强制覆盖远端版本 ${result.head.headVersion}。`,
      `Used ${localDevice} as authoritative and force-replaced the remote with version ${result.head.headVersion}.`,
    ) })
  })

  const resolveWithRemote = () => run(async () => {
    if (!head) return
    const result = await downloadVersion(head.headVersion)
    if (!result) return
    setResolution(null)
    setNotice({ kind: 'success', text: text(
      `已以远端 ${remoteDevice} 的版本 ${head.headVersion} 为准，恢复为新副本 ${result.receipt.targetProjectId}。本机原作品未改动。`,
      `Used ${remoteDevice}'s version ${head.headVersion} as authoritative and restored it as copy ${result.receipt.targetProjectId}. The current local project was not changed.`,
    ) })
  })

  useEffect(() => {
    if (!session || !project) return
    let active = true
    void (async () => {
      try {
        const result = await ipc.invoke('sync:view', session)
        if (!active) return
        if (!result.success) throw new Error(result.errorCode)
        applyView(result.view)
        if (result.view.binding) {
          const status = await ipc.invoke('sync:status', { projectSession: session })
          if (!active) return
          if (!status.success) throw new Error(status.errorCode)
          setHead(status.head)
          setSelectedVersion(status.head.snapshots.at(-1)?.version ?? 0)
        }
      } catch (error) {
        if (active) fail(failureCode(error))
      }
    })()
    return () => { active = false }
    // sessionKey is represented by the frozen project/session passed from the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.projectId, session?.leaseId, session?.projectPath, project?.id])

  if (!project || !session) {
    return <section className="space-y-3 rounded-lg border border-[var(--color-border)] p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><Cloud size={16} />{text('自建同步服务', 'Self-hosted sync')}</h3>
      <p className="text-sm">{text('请先打开一个作品，再配置同步。', 'Open a project before configuring sync.')}</p>
    </section>
  }

  const configured = view?.server.configured === true
  const binding = view?.binding ?? null
  const diverged = Boolean(binding && head && binding.lastVersion !== head.headVersion)
  const leaseActive = Boolean(lease)
  const localDevice = view?.deviceName || text('本机', 'This computer')
  const remoteSnapshot = head && binding
    ? head.snapshots.find(snapshot => snapshot.version === head.headVersion)
    : undefined
  const remoteDevice = remoteSnapshot?.deviceName || text('未知电脑', 'Unknown computer')

  return <section className="space-y-3 rounded-lg border border-[var(--color-border)] p-4" data-testid="sync-service-panel">
    <h3 className="flex items-center gap-2 text-sm font-semibold"><Cloud size={16} />{text('自建同步服务', 'Self-hosted sync')}</h3>
    <p className="text-xs text-[var(--color-text-muted)]">{text('只同步封存后的作品快照，不同步运行中的数据库。一次只允许一台电脑持有写锁；下载始终恢复成新副本。', 'Syncs sealed project snapshots, never the live database. One computer holds the write lease at a time; downloads always restore a new copy.')}</p>

    <div className="grid gap-3 sm:grid-cols-2">
      <div><Label htmlFor="sync-endpoint">{text('服务器地址', 'Server endpoint')}</Label><Input id="sync-endpoint" value={endpoint} placeholder="https://sync.example.com/" onChange={event => setEndpoint(event.target.value)} /></div>
      <div><Label htmlFor="sync-token">{text('访问令牌', 'Access token')}</Label><Input id="sync-token" type="password" value={token} onChange={event => setToken(event.target.value)} /></div>
      <div><Label htmlFor="sync-remote-project">{text('远端作品标识', 'Remote project ID')}</Label><Input id="sync-remote-project" value={remoteProjectId} onChange={event => setRemoteProjectId(event.target.value)} /></div>
      <div className="flex items-end">
        <p className="text-xs text-[var(--color-text-muted)]">
          {configured
            ? text(`已配置${view?.server.tokenPersistence === 'session-only' ? '（令牌仅本次会话）' : ''}`, `Configured${view?.server.tokenPersistence === 'session-only' ? ' (token for this session only)' : ''}`)
            : text('尚未配置', 'Not configured')}
        </p>
      </div>
    </div>

    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={busy || !endpoint.trim() || !token} onClick={() => void run(async () => {
        const result = await ipc.invoke('sync:configure', { projectSession: session, endpoint, token })
        if (!result.success) throw new Error(result.errorCode)
        applyView(result.view)
        setToken('')
        setNotice({ kind: 'success', text: text('同步服务已保存并通过令牌检查。', 'The sync server is saved and the token was accepted.') })
      })}><KeyRound size={14} />{text('保存并检查', 'Save and check')}</Button>
      <Button type="button" variant="outline" disabled={busy || !configured || !remoteProjectId.trim()} onClick={() => void run(async () => {
        const result = await ipc.invoke('sync:bind', { projectSession: session, remoteProjectId })
        if (!result.success) throw new Error(result.errorCode)
        setView(current => current ? { ...current, binding: result.binding } : current)
        setLease(null)
        await refreshStatus()
        setNotice({ kind: 'success', text: text(`已绑定远端作品 ${result.binding.remoteProjectId}，从版本 ${result.binding.lastVersion} 继续。`, `Bound remote project ${result.binding.remoteProjectId}; continuing from version ${result.binding.lastVersion}.`) })
      })}><LockKeyhole size={14} />{text('绑定远端作品', 'Bind remote project')}</Button>
      <Button type="button" variant="outline" disabled={busy || !configured || !binding} onClick={() => void run(refreshStatus)}><RefreshCw size={14} />{text('刷新状态', 'Refresh status')}</Button>
      <Button type="button" variant="outline" disabled={busy || !configured || !binding} onClick={() => void run(async () => {
        const result = await ipc.invoke('sync:acquire', { projectSession: session })
        if (!result.success) throw new Error(result.errorCode)
        setLease(result.lease)
        setNotice({ kind: 'success', text: text(`已获取写锁，有效到 ${new Date(result.lease.expiresAt).toLocaleTimeString()}。`, `Write lease acquired until ${new Date(result.lease.expiresAt).toLocaleTimeString()}.`) })
        await refreshStatus()
      })}><LockKeyhole size={14} />{text('获取写锁', 'Acquire write lease')}</Button>
      <Button type="button" variant="outline" disabled={busy || !lease} onClick={() => void run(async () => {
        if (!lease) return
        const result = await ipc.invoke('sync:release', { projectSession: session, leaseId: lease.leaseId })
        if (!result.success) throw new Error(result.errorCode)
        setLease(null)
        setNotice({ kind: 'success', text: text('写锁已释放。', 'The write lease is released.') })
        await refreshStatus()
      })}><Unplug size={14} />{text('释放写锁', 'Release lease')}</Button>
    </div>

    <p className="text-xs text-[var(--color-text-muted)]">{text('「绑定」会把远端当前 HEAD 视为已同步版本。若本机不是从该版本恢复的，请先下载对应版本，避免下一次上传覆盖远端内容。', 'Binding treats the remote HEAD as the already-synced version. If this copy did not come from that version, download it first so the next upload does not overwrite the remote.')}</p>
    {binding && <p className="text-xs">{text(`本机 ↔ 远端 ${binding.remoteProjectId}；本地已同步版本 ${binding.lastVersion}。`, `This copy ↔ remote ${binding.remoteProjectId}; locally synced version ${binding.lastVersion}.`)}</p>}
    {head && <p className="text-xs">{text(`远端 HEAD：版本 ${head.headVersion}${head.lease ? `；写锁属于 ${head.lease.owner}，到 ${new Date(head.lease.expiresAt).toLocaleString()}` : '；当前没有写锁'}。共 ${head.snapshots.length} 个快照，列表可滚动查看。`, `Remote HEAD: version ${head.headVersion}${head.lease ? `; write lease held by ${head.lease.owner} until ${new Date(head.lease.expiresAt).toLocaleString()}` : '; no write lease'}. ${head.snapshots.length} snapshots; scroll the list to view all.`)}</p>}
    {diverged && binding && head && (
      <section className="space-y-2 rounded border border-[var(--color-warning)] p-3 text-sm" aria-label={text('同步分叉处理', 'Sync divergence resolution')}>
        <h4 className="font-semibold">{text('同步分叉', 'Sync divergence')}</h4>
        <p>{text(
          `本机 ${localDevice} 基于版本 ${binding.lastVersion}；远端版本 ${head.headVersion} 由 ${remoteDevice} 上传。请选择以哪台电脑为准。`,
          `This computer ${localDevice} is based on version ${binding.lastVersion}; remote version ${head.headVersion} was uploaded by ${remoteDevice}. Choose which computer is authoritative.`,
        )}</p>
        <label className="flex items-start gap-2">
          <input type="radio" name="sync-resolution" checked={resolution === 'local'} onChange={() => setResolution('local')} />
          <span>{text(`以本机 ${localDevice} 为准，强制覆盖远端`, `Use ${localDevice} and force-replace the remote`)}</span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" name="sync-resolution" checked={resolution === 'remote'} onChange={() => setResolution('remote')} />
          <span>{text(`以远端 ${remoteDevice} 为准，下载为新副本`, `Use ${remoteDevice}'s remote version and download it as a new copy`)}</span>
        </label>
        <Button
          type="button"
          variant="outline"
          disabled={busy || resolution === null}
          onClick={() => void (resolution === 'local' ? resolveWithLocal() : resolveWithRemote())}
        >
          {resolution === 'local'
            ? text('强制以本机为准', 'Force this computer')
            : resolution === 'remote'
              ? text('以远端为准并下载副本', 'Use remote and download a copy')
              : text('先选择一台电脑', 'Choose a computer first')}
        </Button>
        <p className="text-xs text-[var(--color-text-muted)]">{text('本机选择会上传本机快照并覆盖远端 HEAD；远端选择不会改动当前作品，只下载选定版本为新副本。', 'The local choice uploads this computer’s snapshot and replaces the remote HEAD; the remote choice leaves the current project untouched and only downloads the selected version as a new copy.')}</p>
      </section>
    )}
    {head && head.snapshots.length > 0 && <ul className="max-h-96 space-y-2 overflow-y-auto pr-1">
      {[...head.snapshots].reverse().map(snapshot => <li key={snapshot.version} className="rounded border border-[var(--color-border)] p-2 text-xs">
        <label className="flex items-center gap-2"><input type="radio" name="sync-version" checked={selectedVersion === snapshot.version} onChange={() => setSelectedVersion(snapshot.version)} /><strong>{text(`版本 ${snapshot.version}`, `Version ${snapshot.version}`)}</strong></label>
        <p>{new Date(snapshot.createdAt).toLocaleString()} · {snapshot.byteSize.toLocaleString()} bytes · SHA-256 {snapshot.sha256.slice(0, 12)}…</p>
        <p>{text('上传电脑', 'Uploaded by')}: {snapshot.deviceName}{snapshot.forced ? text(' · 强制覆盖', ' · forced') : ''}</p>
        <p>{text('基于版本', 'Based on')}: {snapshot.parentVersions.length > 0 ? snapshot.parentVersions.join(' / ') : '—'} · {text('来源作品', 'Origin project')}: {snapshot.originProjectId}</p>
      </li>)}
    </ul>}

    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={busy || !binding} onClick={() => void run(async () => {
        const result = await uploadCurrent(false)
        setNotice({ kind: result.bindingSaved ? 'success' : 'info', text: result.bindingSaved
          ? text(`已上传为远端版本 ${result.head.headVersion}。`, `Uploaded as remote version ${result.head.headVersion}.`)
          : text(`已上传为远端版本 ${result.head.headVersion}，但本机绑定未保存；下次上传前请刷新并重新绑定。`, `Uploaded as remote version ${result.head.headVersion}, but the local binding was not saved. Refresh and rebind before the next upload.`) })
      })}><Upload size={14} />{text('上传当前作品快照', 'Upload current snapshot')}</Button>
      <Button type="button" variant="outline" disabled={busy || !configured || !binding || !selectedVersion} onClick={() => void run(async () => {
        const target = await ipc.invoke('dialog:select-project-restore-target', `${project.name}-同步副本`)
        if (!target) return
        const result = await ipc.invoke('sync:download', { projectSession: session, version: selectedVersion, targetGrantId: target.grantId })
        if (!result.success) throw new Error(result.errorCode)
        setNotice({ kind: 'success', text: text(`版本 ${selectedVersion} 已恢复为新副本 ${result.receipt.targetProjectId}：${result.receipt.targetProjectRoot}${result.bindingSaved ? '' : '；本地绑定未保存'}`, `Version ${selectedVersion} restored as copy ${result.receipt.targetProjectId}: ${result.receipt.targetProjectRoot}${result.bindingSaved ? '' : '; local binding not saved'}`) })
      })}><Download size={14} />{text('下载所选版本为副本', 'Download selected version as copy')}</Button>
      <Button type="button" variant="outline" disabled={busy || (!configured && !binding)} onClick={() => void run(async () => {
        const result = await ipc.invoke('sync:clear-config', session)
        if (!result.success) throw new Error(result.errorCode)
        applyView(result.view)
        setToken('')
        setHead(null)
        setLease(null)
        setNotice({ kind: 'success', text: text('本机同步配置已清除；远端快照没有删除。', 'Local sync configuration cleared; remote snapshots were not deleted.') })
      })}><Unplug size={14} />{text('清除本机同步配置', 'Clear local sync config')}</Button>
    </div>

    {lease && leaseActive && <p className="text-xs text-[var(--color-text-muted)]">{text(`本机持有写锁，有效到 ${new Date(lease.expiresAt).toLocaleString()}。上传后会自动续期。`, `This computer holds the write lease until ${new Date(lease.expiresAt).toLocaleString()}. Uploading renews it.`)}</p>}

    {notice && <p role={notice.kind === 'error' ? 'alert' : 'status'} className="text-sm" style={{ color: notice.kind === 'error' ? 'var(--color-error-text)' : notice.kind === 'success' ? 'var(--color-success-text)' : 'var(--color-text-secondary)' }}>{notice.text}</p>}
  </section>
}
