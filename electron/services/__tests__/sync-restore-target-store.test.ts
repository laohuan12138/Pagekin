import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SyncRestoreTargetStore } from '../sync-restore-target-store'

const roots: string[] = []

function root(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pagekin-sync-restore-target-'))
  roots.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('SyncRestoreTargetStore', () => {
  it('persists the last remote project used for recovery', () => {
    const directory = root()
    const store = new SyncRestoreTargetStore({ rootPath: directory })
    store.save('remote-a', path.join(directory, 'copy-a'))
    expect(store.lastRemoteProjectId()).toBe('remote-a')

    const reopened = new SyncRestoreTargetStore({ rootPath: directory })
    expect(reopened.lastRemoteProjectId()).toBe('remote-a')
    expect(reopened.get('remote-a')?.targetRoot).toBe(path.join(directory, 'copy-a'))

    reopened.remember('remote-b')
    expect(reopened.lastRemoteProjectId()).toBe('remote-b')

    reopened.clear('remote-b')
    expect(reopened.lastRemoteProjectId()).toBeNull()
    expect(reopened.get('remote-a')?.targetRoot).toBe(path.join(directory, 'copy-a'))
  })
})
