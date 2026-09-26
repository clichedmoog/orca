import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { supportsPosixFileModes } from '../daemon/daemon-private-file-modes'
import {
  hydrateNativeChatImageRefs,
  NATIVE_CHAT_IMAGE_CACHE_MAX_BYTES
} from './transcript-image-cache'

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const DATA_URL = `data:image/png;base64,${PNG_1PX}`

function messageWithUrl(url: string): NativeChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    blocks: [
      { type: 'text', text: 'here' },
      { type: 'image-ref', url }
    ],
    timestamp: null,
    source: 'transcript'
  }
}

function freshCacheDir(): string {
  return mkdtempSync(join(tmpdir(), 'nnc-img-'))
}

describe('hydrateNativeChatImageRefs', () => {
  it('persists data: bytes to the cache and rewrites to a path ref', async () => {
    const cacheDir = freshCacheDir()
    const [hydrated] = await hydrateNativeChatImageRefs([messageWithUrl(DATA_URL)], { cacheDir })
    const ref = hydrated.blocks[1]
    expect(ref.type).toBe('image-ref')
    if (ref.type !== 'image-ref') {
      return
    }
    expect(ref.url).toBeUndefined()
    expect(ref.path).toMatch(/\.png$/)
    expect(ref.path!.startsWith(cacheDir)).toBe(true)
    expect(readFileSync(ref.path!).toString('base64')).toBe(PNG_1PX)
  })

  it('writes cache files privately on posix', async () => {
    const cacheDir = freshCacheDir()
    const [hydrated] = await hydrateNativeChatImageRefs([messageWithUrl(DATA_URL)], { cacheDir })
    const ref = hydrated.blocks[1]
    if (ref.type !== 'image-ref' || !ref.path) {
      throw new Error('expected a hydrated path ref')
    }
    expect(existsSync(ref.path)).toBe(true)
    if (supportsPosixFileModes()) {
      expect(statSync(ref.path).mode & 0o777).toBe(0o600)
    }
  })

  it('never rewrites an existing cache entry (write-once by content hash)', async () => {
    const cacheDir = freshCacheDir()
    const digest = createHash('sha256').update(Buffer.from(PNG_1PX, 'base64')).digest('hex')
    const cached = join(cacheDir, `${digest}.png`)
    writeFileSync(cached, 'stale-bytes')
    const [hydrated] = await hydrateNativeChatImageRefs([messageWithUrl(DATA_URL)], { cacheDir })
    const ref = hydrated.blocks[1]
    if (ref.type !== 'image-ref') {
      throw new Error('expected an image-ref')
    }
    expect(ref.path).toBe(cached)
    expect(readFileSync(cached, 'utf8')).toBe('stale-bytes')
  })

  it('passes remote urls and existing paths through untouched', async () => {
    const cacheDir = freshCacheDir()
    const remote = messageWithUrl('https://x.test/shot.png')
    const local: NativeChatMessage = {
      ...messageWithUrl(DATA_URL),
      blocks: [{ type: 'image-ref', path: '/tmp/pasted.png' }]
    }
    const [a, b] = await hydrateNativeChatImageRefs([remote, local], { cacheDir })
    expect(a.blocks).toEqual(remote.blocks)
    expect(b.blocks).toEqual(local.blocks)
  })

  it('leaves oversized payloads inline instead of caching (fail-open)', async () => {
    const cacheDir = freshCacheDir()
    const big = `data:image/png;base64,${'A'.repeat(NATIVE_CHAT_IMAGE_CACHE_MAX_BYTES + 1)}`
    const [hydrated] = await hydrateNativeChatImageRefs([messageWithUrl(big)], { cacheDir })
    expect(hydrated.blocks[1]).toEqual({ type: 'image-ref', url: big })
  })

  it('leaves malformed data: urls inline (fail-open)', async () => {
    const cacheDir = freshCacheDir()
    const bad = 'data:image/png;base64,%%%not-base64%%%'
    const [hydrated] = await hydrateNativeChatImageRefs([messageWithUrl(bad)], { cacheDir })
    expect(hydrated.blocks[1]).toEqual({ type: 'image-ref', url: bad })
  })
})
