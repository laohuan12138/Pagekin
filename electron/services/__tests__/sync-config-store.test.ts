import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SyncConfigStore, normalizeSyncEndpoint, type SyncConfigStoreOptions } from '../sync-config-store'

const roots: string[] = []

function root(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pagekin-sync-config-'))
  roots.push(directory)
  return directory
}

function safeStorage(available = true): SyncConfigStoreOptions['safeStorage'] {
  return {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: value => {
      const text = value.toString('utf8')
      if (!text.startsWith('encrypted:')) throw new Error('bad ciphertext')
      return text.slice('encrypted:'.length)
    },
  }
}

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('SyncConfigStore', () => {
  it('persists the server and per-project binding without storing a plaintext token', () => {
    const directory = root()
    const store = new SyncConfigStore({ rootPath: directory, safeStorage: safeStorage() })
    const saved = store.saveServer('http://127.0.0.1:8787', 'secret-token')

    expect(saved).toEqual({
      endpoint: 'http://127.0.0.1:8787/',
      configured: true,
      tokenPersistence: 'os-backed',
    })
    expect(fs.readFileSync(path.join(directory, 'sync-service.json'), 'utf8')).not.toContain('secret-token')

    const binding = store.saveBinding('local-project', 'remote-project', 4)
    expect(binding).toEqual({ localProjectId: 'local-project', remoteProjectId: 'remote-project', lastVersion: 4 })

    const reopened = new SyncConfigStore({ rootPath: directory, safeStorage: safeStorage() })
    expect(reopened.resolveServer()).toEqual({
      endpoint: 'http://127.0.0.1:8787/',
      token: 'secret-token',
      persistence: 'os-backed',
    })
    expect(reopened.view('local-project')).toEqual({
      server: { endpoint: 'http://127.0.0.1:8787/', configured: true, tokenPersistence: 'os-backed' },
      binding: { localProjectId: 'local-project', remoteProjectId: 'remote-project', lastVersion: 4 },
    })
  })

  it('keeps the token session-only when OS encryption is unavailable', () => {
    const directory = root()
    const store = new SyncConfigStore({ rootPath: directory, safeStorage: safeStorage(false) })
    expect(store.saveServer('http://127.0.0.1:8787', 'secret-token')).toMatchObject({
      configured: true,
      tokenPersistence: 'session-only',
    })
    expect(store.resolveServer()).toMatchObject({ token: 'secret-token', persistence: 'session-only' })

    const reopened = new SyncConfigStore({ rootPath: directory, safeStorage: safeStorage(false) })
    expect(reopened.view('local-project').server).toMatchObject({ configured: false, tokenPersistence: 'none' })
  })

  it('invalidates bindings when the server changes', () => {
    const store = new SyncConfigStore({ rootPath: root(), safeStorage: safeStorage() })
    store.saveServer('http://127.0.0.1:8787', 'first-token')
    store.saveBinding('local-project', 'remote-project', 2)

    store.saveServer('https://sync.example.com', 'second-token')

    expect(store.getBinding('local-project')).toBeNull()
    expect(store.resolveServer()).toMatchObject({ endpoint: 'https://sync.example.com/', token: 'second-token' })
  })

  it('clears the server and all bindings together', () => {
    const store = new SyncConfigStore({ rootPath: root(), safeStorage: safeStorage() })
    store.saveServer('http://127.0.0.1:8787', 'secret-token')
    store.saveBinding('local-project', 'remote-project', 2)

    store.clearServer()

    expect(store.view('local-project')).toEqual({
      server: { endpoint: null, configured: false, tokenPersistence: 'none' },
      binding: null,
    })
    expect(store.resolveServer()).toBeNull()
  })

  it('accepts public HTTP endpoints and rejects unsafe project ids', () => {
    expect(normalizeSyncEndpoint('http://203.0.113.10:8088')).toBe('http://203.0.113.10:8088/')
    expect(normalizeSyncEndpoint('http://203.0.113.10.sslip.io:8088')).toBe('http://203.0.113.10.sslip.io:8088/')
    expect(normalizeSyncEndpoint('http://example.com')).toBe('http://example.com/')
    expect(normalizeSyncEndpoint('http://192.168.evil.com')).toBe('http://192.168.evil.com/')
    expect(normalizeSyncEndpoint('http://nas')).toBe('http://nas/')
    expect(normalizeSyncEndpoint('http://192.168.1.20:8787')).toBe('http://192.168.1.20:8787/')
    expect(normalizeSyncEndpoint('https://sync.example.com')).toBe('https://sync.example.com/')
    expect(() => normalizeSyncEndpoint('https://sync.example.com/base')).toThrow('SYNC_CONFIG_INVALID')
    expect(() => normalizeSyncEndpoint('https://sync.example.com/?token=x')).toThrow('SYNC_CONFIG_INVALID')

    const store = new SyncConfigStore({ rootPath: root(), safeStorage: safeStorage() })
    store.saveServer('http://203.0.113.10:8088', 'secret-token')
    expect(() => store.saveBinding('../escape', 'remote', 0)).toThrow('SYNC_CONFIG_INVALID')
    expect(() => store.saveBinding('local', 'remote/../escape', 0)).toThrow('SYNC_CONFIG_INVALID')
  })
})
