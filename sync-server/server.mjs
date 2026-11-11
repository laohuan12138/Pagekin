import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const MAX_OWNER_LENGTH = 128
const MAX_JSON_BYTES = 64 * 1024
const DEFAULT_MAX_BODY_BYTES = 512 * 1024 * 1024
const DEFAULT_LEASE_TTL_SECONDS = 900
const MAX_LEASE_TTL_SECONDS = 3600
const DEFAULT_RATE_LIMIT = 120
const DEFAULT_RATE_WINDOW_MS = 60_000
const MAX_RATE_ENTRIES = 10_000
const DEFAULT_MAX_CONCURRENT_UPLOADS = 4
const DEFAULT_MAX_SNAPSHOTS = 500
const DEFAULT_MAX_PROJECTS = 1_000

class SyncServerError extends Error {
  constructor(status, code) {
    super(code)
    this.status = status
    this.code = code
  }
}

function fail(status, code) {
  throw new SyncServerError(status, code)
}

function validProjectId(value) {
  return typeof value === 'string' && PROJECT_ID.test(value)
}

function cleanLabel(value, fallback) {
  if (typeof value !== 'string') return fallback
  const cleaned = Array.from(value.trim(), character => (
    character.codePointAt(0) < 0x20 || character.codePointAt(0) === 0x7f ? '-' : character
  )).join('').slice(0, MAX_OWNER_LENGTH)
  return cleaned || fallback
}

function iso(ms) {
  return new Date(ms).toISOString()
}

function safeEqual(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function sendJson(response, status, value) {
  if (response.destroyed || response.writableEnded || response.headersSent) return
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  response.end(body)
}

function sendText(response, status, code) {
  sendJson(response, status, { error: code })
}

async function readBody(request, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > limit) fail(413, 'BODY_TOO_LARGE')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(request) {
  const body = await readBody(request, MAX_JSON_BYTES)
  try {
    const value = JSON.parse(body.toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'INVALID_JSON')
    return value
  } catch (error) {
    if (error instanceof SyncServerError) throw error
    fail(400, 'INVALID_JSON')
  }
}

function atomicWrite(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, filePath)
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }) } catch { /* best effort */ }
    throw error
  }
}

function parseHead(value, projectId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.format !== 1 || value.projectId !== projectId
    || !Number.isInteger(value.headVersion) || value.headVersion < 0
    || !Array.isArray(value.snapshots)
    || !(value.lease === null || typeof value.lease === 'object')) {
    fail(500, 'REMOTE_STATE_INVALID')
  }
  const snapshots = value.snapshots.map(snapshot => {
    if (!snapshot || typeof snapshot !== 'object'
      || !Number.isInteger(snapshot.version) || snapshot.version < 1
      || typeof snapshot.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(snapshot.sha256)
      || !Number.isInteger(snapshot.byteSize) || snapshot.byteSize < 0
      || typeof snapshot.createdAt !== 'string'
      || typeof snapshot.originProjectId !== 'string') {
      fail(500, 'REMOTE_STATE_INVALID')
    }
    if (snapshot.deviceName !== undefined && typeof snapshot.deviceName !== 'string') {
      fail(500, 'REMOTE_STATE_INVALID')
    }
    if (snapshot.parentVersions !== undefined
      && (!Array.isArray(snapshot.parentVersions)
        || snapshot.parentVersions.some(version => !Number.isInteger(version) || version < 0))) {
      fail(500, 'REMOTE_STATE_INVALID')
    }
    if (snapshot.forced !== undefined && typeof snapshot.forced !== 'boolean') {
      fail(500, 'REMOTE_STATE_INVALID')
    }
    return {
      version: snapshot.version,
      sha256: snapshot.sha256,
      byteSize: snapshot.byteSize,
      createdAt: snapshot.createdAt,
      originProjectId: snapshot.originProjectId,
      deviceName: snapshot.deviceName ?? 'unknown',
      parentVersions: snapshot.parentVersions ?? [Math.max(0, snapshot.version - 1)],
      forced: snapshot.forced === true,
    }
  })
  const lease = value.lease === null ? null : (() => {
    const candidate = value.lease
    if (typeof candidate.leaseId !== 'string' || !candidate.leaseId
      || typeof candidate.owner !== 'string' || !candidate.owner
      || typeof candidate.expiresAt !== 'string') fail(500, 'REMOTE_STATE_INVALID')
    return { leaseId: candidate.leaseId, owner: candidate.owner, expiresAt: candidate.expiresAt }
  })()
  return {
    format: 1,
    projectId,
    headVersion: value.headVersion,
    snapshots,
    lease,
  }
}

/**
 * Single-writer, immutable-snapshot sync service.
 *
 * It deliberately does not understand SQLite or the desktop project. Clients
 * upload sealed `.ainovel` archives; the server only enforces auth, one writer
 * at a time, optimistic version checks, and byte integrity.
 */
export function createSyncServer(options) {
  const dataDir = path.resolve(options.dataDir)
  const token = options.token
  if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') === 0) throw new Error('SYNC_TOKEN_REQUIRED')
  if (Buffer.byteLength(token, 'utf8') < 24) throw new Error('SYNC_TOKEN_TOO_SHORT')
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const now = options.now ?? (() => Date.now())
  const defaultLeaseTtlSeconds = options.leaseTtlSeconds ?? DEFAULT_LEASE_TTL_SECONDS
  const rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT
  const rateWindowMs = options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS
  const maxConcurrentUploads = Math.max(1, options.maxConcurrentUploads ?? DEFAULT_MAX_CONCURRENT_UPLOADS)
  const maxSnapshots = Math.max(1, options.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS)
  const configuredRetain = Number(options.retainSnapshots ?? 0)
  const retainSnapshots = Number.isFinite(configuredRetain)
    && configuredRetain > 0
    && configuredRetain < maxSnapshots
    ? Math.floor(configuredRetain)
    : 0
  const maxProjects = Math.max(1, options.maxProjects ?? DEFAULT_MAX_PROJECTS)
  const trustProxy = options.trustProxy ?? false
  const projectsDir = path.join(dataDir, 'projects')
  fs.mkdirSync(projectsDir, { recursive: true, mode: 0o700 })

  const locks = new Map()
  const rate = new Map()
  const uploads = new Set()
  const authRateKey = `token:${createHash('sha256').update(token).digest('hex')}`
  const authRateLimit = rateLimit <= 0 ? 0 : rateLimit * 5

  function clientIp(request) {
    const forwarded = trustProxy && typeof request.headers['x-forwarded-for'] === 'string'
      ? request.headers['x-forwarded-for'].split(',').at(-1).trim()
      : request.socket.remoteAddress ?? 'unknown'
    return forwarded.startsWith('::ffff:') ? forwarded.slice('::ffff:'.length) : forwarded
  }

  function allowRequest(key, limit) {
    if (limit <= 0) return true
    const current = now()
    const entry = rate.get(key)
    if (!entry || current >= entry.resetAt) {
      rate.set(key, { count: 1, resetAt: current + rateWindowMs })
      if (rate.size > MAX_RATE_ENTRIES) {
        for (const stale of rate.keys()) {
          if (rate.size <= MAX_RATE_ENTRIES) break
          rate.delete(stale)
        }
      }
      return true
    }
    if (entry.count >= limit) return false
    entry.count += 1
    return true
  }

  function withProjectLock(projectId, operation) {
    const previous = locks.get(projectId) ?? Promise.resolve()
    const current = previous.then(operation, operation)
    const tail = current.then(() => undefined, () => undefined)
    locks.set(projectId, tail)
    void tail.then(() => {
      if (locks.get(projectId) === tail) locks.delete(projectId)
    })
    return current
  }

  function projectDirectory(projectId) {
    if (!validProjectId(projectId)) fail(400, 'INVALID_PROJECT_ID')
    // Hash the id so case-insensitive filesystems and Windows device names
    // cannot alias or reject a project directory.
    return path.join(projectsDir, createHash('sha256').update(projectId).digest('hex'))
  }

  function headPath(projectId) {
    return path.join(projectDirectory(projectId), 'head.json')
  }

  function snapshotPath(projectId, version) {
    return path.join(projectDirectory(projectId), 'snapshots', `v${String(version).padStart(8, '0')}.ainovel`)
  }

  function pruneOldSnapshots(projectId, head) {
    if (retainSnapshots <= 0) return
    while (head.snapshots.length > retainSnapshots) {
      const oldest = head.snapshots[0]
      try { fs.rmSync(snapshotPath(projectId, oldest.version), { force: true }) }
      catch { return }
      head.snapshots.shift()
    }
  }

  function readHead(projectId) {
    const file = headPath(projectId)
    if (!fs.existsSync(file)) {
      return { format: 1, projectId, headVersion: 0, snapshots: [], lease: null }
    }
    try {
      return parseHead(JSON.parse(fs.readFileSync(file, 'utf8')), projectId)
    } catch (error) {
      if (error instanceof SyncServerError) throw error
      fail(500, 'REMOTE_STATE_INVALID')
    }
  }

  function writeHead(head) {
    atomicWrite(headPath(head.projectId), Buffer.from(`${JSON.stringify(head, null, 2)}\n`, 'utf8'))
  }

  function effectiveLease(head) {
    if (!head.lease) return null
    return Date.parse(head.lease.expiresAt) > now() ? head.lease : null
  }

  function publicHead(head) {
    const lease = effectiveLease(head)
    return {
      projectId: head.projectId,
      headVersion: head.headVersion,
      lease: lease ? { owner: lease.owner, expiresAt: lease.expiresAt } : null,
      snapshots: head.snapshots,
    }
  }

  function authorized(request) {
    const header = request.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
    return safeEqual(header.slice('Bearer '.length), token)
  }

  async function acquireLease(projectId, request) {
    const body = await readJson(request)
    const owner = cleanLabel(body.owner, 'unknown-client')
    const requestedTtl = body.ttlSeconds === undefined ? defaultLeaseTtlSeconds : body.ttlSeconds
    if (!Number.isInteger(requestedTtl) || requestedTtl < 30 || requestedTtl > MAX_LEASE_TTL_SECONDS) {
      fail(400, 'INVALID_LEASE_TTL')
    }
    return withProjectLock(projectId, () => {
      const head = readHead(projectId)
      if (!fs.existsSync(headPath(projectId))) {
        const count = fs.readdirSync(projectsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).length
        if (count >= maxProjects) fail(429, 'PROJECT_LIMIT_REACHED')
      }
      const active = effectiveLease(head)
      if (active && active.leaseId !== body.leaseId) {
        return { status: 423, body: { error: 'LEASE_HELD', lease: { owner: active.owner, expiresAt: active.expiresAt } } }
      }
      const lease = {
        leaseId: active?.leaseId ?? randomUUID(),
        owner,
        expiresAt: iso(now() + requestedTtl * 1000),
      }
      if (active && active.owner !== owner) lease.owner = active.owner
      head.lease = lease
      writeHead(head)
      return { status: 200, body: { lease } }
    })
  }

  function releaseLease(projectId, request) {
    return readJson(request).then(body => withProjectLock(projectId, () => {
      const head = readHead(projectId)
      const active = effectiveLease(head)
      if (!active || active.leaseId !== body.leaseId) {
        return { status: 200, body: { released: false } }
      }
      head.lease = null
      writeHead(head)
      return { status: 200, body: { released: true } }
    }))
  }

  async function uploadSnapshot(projectId, request, url) {
    const rawBaseVersion = url.searchParams.get('baseVersion')
    if (rawBaseVersion === null) fail(400, 'INVALID_BASE_VERSION')
    const baseVersion = Number(rawBaseVersion)
    if (!Number.isInteger(baseVersion) || baseVersion < 0) fail(400, 'INVALID_BASE_VERSION')
    const leaseId = request.headers['x-sync-lease-id']
    if (typeof leaseId !== 'string' || !leaseId) fail(423, 'LEASE_REQUIRED')
    const expectedSha = request.headers['x-sync-sha256']
    if (typeof expectedSha !== 'string' || !/^[0-9a-f]{64}$/u.test(expectedSha)) fail(400, 'INVALID_SHA256')
    const originProjectId = cleanLabel(request.headers['x-sync-origin-project-id'], 'unknown-project')
    const deviceName = cleanLabel(request.headers['x-sync-device-name'], 'unknown-device')
    const force = request.headers['x-sync-force'] === '1'
    const expectedHeadHeader = request.headers['x-sync-expected-head']
    let expectedHead = null
    if (expectedHeadHeader !== undefined) {
      if (typeof expectedHeadHeader !== 'string') fail(400, 'INVALID_EXPECTED_HEAD')
      expectedHead = Number(expectedHeadHeader)
      if (!Number.isInteger(expectedHead) || expectedHead < 0) fail(400, 'INVALID_EXPECTED_HEAD')
    }
    if (force && expectedHead === null) fail(400, 'EXPECTED_HEAD_REQUIRED')
    if (uploads.has(projectId)) fail(409, 'UPLOAD_IN_PROGRESS')
    if (uploads.size >= maxConcurrentUploads) fail(429, 'TOO_MANY_UPLOADS')
    uploads.add(projectId)
    let uploadTemp = null
    try {
      // Validate the writer and renew the lease before reading a potentially
      // large body. Otherwise a slow upload can outlive the lease it started with.
      await withProjectLock(projectId, () => {
        const head = readHead(projectId)
        const active = effectiveLease(head)
        if (!active) fail(423, 'LEASE_EXPIRED')
        if (active.leaseId !== leaseId) fail(423, 'LEASE_REQUIRED')
        if (force ? baseVersion > head.headVersion : head.headVersion !== baseVersion) {
          fail(409, 'VERSION_CONFLICT')
        }
        if (force && expectedHead !== null && head.headVersion !== expectedHead) {
          fail(409, 'VERSION_CONFLICT')
        }
        if (retainSnapshots <= 0 && head.snapshots.length >= maxSnapshots) throw new SyncServerError(409, 'SNAPSHOT_LIMIT_REACHED')
        head.lease = { ...active, expiresAt: iso(now() + defaultLeaseTtlSeconds * 1000) }
        writeHead(head)
      })
      const snapshotsDir = path.join(projectDirectory(projectId), 'snapshots')
      fs.mkdirSync(snapshotsDir, { recursive: true, mode: 0o700 })
      uploadTemp = path.join(snapshotsDir, `.upload-${randomUUID()}.tmp`)
      let byteSize = 0
      const digest = createHash('sha256')
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          byteSize += chunk.length
          if (byteSize > maxBodyBytes) {
            callback(new SyncServerError(413, 'BODY_TOO_LARGE'))
            return
          }
          digest.update(chunk)
          callback(null, chunk)
        },
      })
      try {
        await pipeline(
          request,
          limiter,
          fs.createWriteStream(uploadTemp, { flags: 'wx', mode: 0o600 }),
        )
      } catch (error) {
        fs.rmSync(uploadTemp, { force: true })
        uploadTemp = null
        throw error
      }
      if (byteSize === 0) {
        fs.rmSync(uploadTemp, { force: true })
        uploadTemp = null
        fail(400, 'EMPTY_ARCHIVE')
      }
      const actualSha = digest.digest('hex')
      if (actualSha !== expectedSha) {
        fs.rmSync(uploadTemp, { force: true })
        uploadTemp = null
        fail(400, 'SHA256_MISMATCH')
      }

      return await withProjectLock(projectId, () => {
        const head = readHead(projectId)
        const active = effectiveLease(head)
        if (!active) fail(423, 'LEASE_EXPIRED')
        if (active.leaseId !== leaseId) fail(423, 'LEASE_REQUIRED')
        if (force ? baseVersion > head.headVersion : head.headVersion !== baseVersion) {
          throw new SyncServerError(409, 'VERSION_CONFLICT')
        }
        if (force && expectedHead !== null && head.headVersion !== expectedHead) {
          throw new SyncServerError(409, 'VERSION_CONFLICT')
        }
        if (retainSnapshots <= 0 && head.snapshots.length >= maxSnapshots) {
          throw new SyncServerError(409, 'SNAPSHOT_LIMIT_REACHED')
        }
        const version = head.headVersion + 1
        const parentVersions = force
          ? [...new Set([baseVersion, head.headVersion])].sort((left, right) => left - right)
          : [baseVersion]
        const target = snapshotPath(projectId, version)
        if (fs.existsSync(target)) fs.rmSync(target, { force: true })
        fs.renameSync(uploadTemp, target)
        uploadTemp = null
        const snapshot = {
          version,
          sha256: actualSha,
          byteSize,
          createdAt: iso(now()),
          originProjectId,
          deviceName,
          parentVersions,
          forced: force,
        }
        head.headVersion = version
        head.snapshots.push(snapshot)
        pruneOldSnapshots(projectId, head)
        head.lease = { ...active, expiresAt: iso(now() + defaultLeaseTtlSeconds * 1000) }
        writeHead(head)
        return { status: 200, body: { ...publicHead(head), snapshot } }
      })
    } finally {
      if (uploadTemp) {
        try { fs.rmSync(uploadTemp, { force: true }) } catch { /* best effort */ }
      }
      uploads.delete(projectId)
    }
  }

  async function route(request, response) {
    let url
    try {
      url = new URL(request.url ?? '/', 'http://sync.local')
    } catch {
      sendText(response, 400, 'INVALID_URL')
      return
    }
    const authenticated = authorized(request)
    const key = authenticated ? authRateKey : `ip:${clientIp(request)}`
    if (!allowRequest(key, authenticated ? authRateLimit : rateLimit)) {
      sendText(response, 429, 'RATE_LIMITED')
      return
    }
    if (!authenticated) {
      sendText(response, 401, 'AUTH_REQUIRED')
      return
    }
    if (url.pathname === '/health') {
      sendJson(response, 200, { ok: true })
      return
    }
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] !== 'v1' || parts[1] !== 'projects' || !validProjectId(parts[2])) {
      sendText(response, 404, 'NOT_FOUND')
      return
    }
    const projectId = parts[2]
    try {
      if (parts.length === 4 && parts[3] === 'status' && request.method === 'GET') {
        const head = await withProjectLock(projectId, () => readHead(projectId))
        sendJson(response, 200, publicHead(head))
        return
      }
      if (parts.length === 4 && parts[3] === 'lease' && request.method === 'POST') {
        const result = await acquireLease(projectId, request)
        sendJson(response, result.status, result.body)
        return
      }
      if (parts.length === 5 && parts[3] === 'lease' && parts[4] === 'release' && request.method === 'POST') {
        const result = await releaseLease(projectId, request)
        sendJson(response, result.status, result.body)
        return
      }
      if (parts.length === 4 && parts[3] === 'snapshots' && request.method === 'GET') {
        const head = await withProjectLock(projectId, () => readHead(projectId))
        sendJson(response, 200, { projectId, headVersion: head.headVersion, snapshots: head.snapshots })
        return
      }
      if (parts.length === 4 && parts[3] === 'snapshots' && request.method === 'POST') {
        const result = await uploadSnapshot(projectId, request, url)
        sendJson(response, result.status, result.body)
        return
      }
      if (parts.length === 5 && parts[3] === 'snapshots' && request.method === 'GET') {
        const version = Number(parts[4])
        if (!Number.isInteger(version) || version < 1) fail(400, 'INVALID_VERSION')
        const head = await withProjectLock(projectId, () => readHead(projectId))
        const snapshot = head.snapshots.find(candidate => candidate.version === version)
        if (!snapshot) {
          sendText(response, 404, 'SNAPSHOT_NOT_FOUND')
          return
        }
        const file = snapshotPath(projectId, version)
        if (!fs.existsSync(file)) {
          sendText(response, 404, 'SNAPSHOT_NOT_FOUND')
          return
        }
        const stat = fs.statSync(file)
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(stat.size),
          'x-sync-version': String(version),
          'x-sync-sha256': snapshot.sha256,
          'cache-control': 'no-store',
        })
        void pipeline(fs.createReadStream(file), response).catch(() => {
          response.destroy()
        })
        return
      }
      sendText(response, 404, 'NOT_FOUND')
    } catch (error) {
      if (response.headersSent) {
        response.destroy()
        return
      }
      if (error instanceof SyncServerError) {
        sendText(response, error.status, error.code)
        return
      }
      console.error('[sync-server] request failed', { name: error?.name, code: error?.code })
      sendText(response, 500, 'SYNC_SERVER_FAILED')
    }
  }

  const server = http.createServer((request, response) => {
    response.on('error', () => { /* client aborted or response already closed */ })
    void route(request, response).catch(error => {
      console.error('[sync-server] route failed', { name: error?.name, code: error?.code })
      if (response.headersSent) response.destroy()
      else sendText(response, 500, 'SYNC_SERVER_FAILED')
    })
  })
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })
  server.requestTimeout = 600_000
  server.headersTimeout = 30_000
  server.keepAliveTimeout = 5_000
  server.maxHeadersCount = 100

  return {
    server,
    dataDir,
    listen({ port = 8787, host = '127.0.0.1' } = {}) {
      return new Promise((resolve, reject) => {
        const onError = error => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          const address = server.address()
          resolve({ port: typeof address === 'object' && address ? address.port : port, host })
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, host)
      })
    },
    close() {
      return new Promise(resolve => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}

const isEntryPoint = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isEntryPoint) {
  process.on('unhandledRejection', error => {
    console.error('[sync-server] unhandled rejection', { name: error?.name, code: error?.code })
  })
  const token = process.env.SYNC_TOKEN
  if (!token) {
    console.error('SYNC_TOKEN is required. Set it to a long random secret.')
    process.exit(1)
  }
  const dataDir = path.resolve(process.env.SYNC_DATA_DIR ?? 'sync-data')
  const port = Number(process.env.SYNC_PORT ?? 8787)
  const host = process.env.SYNC_HOST ?? '127.0.0.1'
  const configuredRateLimit = Number(process.env.SYNC_RATE_LIMIT ?? DEFAULT_RATE_LIMIT)
  const configuredRateWindow = Number(process.env.SYNC_RATE_WINDOW_MS ?? DEFAULT_RATE_WINDOW_MS)
  const configuredUploads = Number(process.env.SYNC_MAX_UPLOADS ?? DEFAULT_MAX_CONCURRENT_UPLOADS)
  const configuredBodyBytes = Number(process.env.SYNC_MAX_BODY_BYTES ?? DEFAULT_MAX_BODY_BYTES)
  const configuredSnapshots = Number(process.env.SYNC_MAX_SNAPSHOTS ?? DEFAULT_MAX_SNAPSHOTS)
  const configuredRetain = Number(process.env.SYNC_RETAIN_SNAPSHOTS ?? 0)
  const configuredProjects = Number(process.env.SYNC_MAX_PROJECTS ?? DEFAULT_MAX_PROJECTS)
  const instance = createSyncServer({
    dataDir,
    token,
    rateLimit: Number.isFinite(configuredRateLimit) ? configuredRateLimit : DEFAULT_RATE_LIMIT,
    rateWindowMs: Number.isFinite(configuredRateWindow) && configuredRateWindow > 0
      ? configuredRateWindow
      : DEFAULT_RATE_WINDOW_MS,
    maxConcurrentUploads: Number.isFinite(configuredUploads) && configuredUploads > 0
      ? configuredUploads
      : DEFAULT_MAX_CONCURRENT_UPLOADS,
    maxBodyBytes: Number.isFinite(configuredBodyBytes) && configuredBodyBytes > 0
      ? configuredBodyBytes
      : DEFAULT_MAX_BODY_BYTES,
    maxSnapshots: Number.isFinite(configuredSnapshots) && configuredSnapshots > 0
      ? configuredSnapshots
      : DEFAULT_MAX_SNAPSHOTS,
    retainSnapshots: Number.isFinite(configuredRetain) && configuredRetain > 0
      ? configuredRetain
      : 0,
    maxProjects: Number.isFinite(configuredProjects) && configuredProjects > 0
      ? configuredProjects
      : DEFAULT_MAX_PROJECTS,
    trustProxy: process.env.SYNC_TRUST_PROXY === '1',
  })
  instance.listen({ port, host }).then(({ port: actualPort }) => {
    console.log(`[sync-server] listening on ${host}:${actualPort}; data=${dataDir}`)
  }).catch(error => {
    console.error('[sync-server] failed to start', { name: error?.name, code: error?.code })
    process.exit(1)
  })
  const shutdown = () => {
    void instance.close().finally(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
