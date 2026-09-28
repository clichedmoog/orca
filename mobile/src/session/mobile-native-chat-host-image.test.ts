import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  isNativeChatCachedImagePath,
  NativeChatHostImageLoader
} from './mobile-native-chat-host-image'

const HASH = 'a'.repeat(64)
const CACHED = `/Users/me/Library/Application Support/orca/native-chat-images/${HASH}.png`

/** The loader reaches only these members, so the rest of the client is a fake. */
type ImageClientParts = { sendRequest: unknown; getGeneration: () => number }

function fakeClient(sendRequest: unknown): RpcClient {
  const parts: ImageClientParts = { sendRequest, getGeneration: () => 0 }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The loader calls `sendRequest` and `getGeneration` and nothing else on the client; every other member is unreachable from it.
  return parts as RpcClient
}

function imageReply(content: string): unknown {
  return {
    id: 'img',
    ok: true,
    result: { content, isBinary: true, isImage: true, mimeType: 'image/png' },
    _meta: { runtimeId: 'runtime-1' }
  }
}

function failure(code: string): unknown {
  return { id: 'img', ok: false, error: { code, message: code }, _meta: { runtimeId: 'r' } }
}

describe('isNativeChatCachedImagePath', () => {
  it('accepts only content-hash cache file names, on posix and windows hosts', () => {
    expect(isNativeChatCachedImagePath(CACHED)).toBe(true)
    expect(
      isNativeChatCachedImagePath(`C:\\Users\\me\\orca\\native-chat-images\\${HASH}.jpg`)
    ).toBe(true)
    expect(isNativeChatCachedImagePath('/tmp/screenshot.png')).toBe(false)
    expect(isNativeChatCachedImagePath(`/tmp/x${HASH}.png`)).toBe(false)
    expect(isNativeChatCachedImagePath(undefined)).toBe(false)
  })
})

describe('NativeChatHostImageLoader', () => {
  it('fetches a cached image once and returns a data: URI', async () => {
    const sendRequest = vi.fn().mockResolvedValue(imageReply('AAAA'))
    const loader = new NativeChatHostImageLoader(fakeClient(sendRequest))
    const [first, second] = await Promise.all([loader.load(CACHED), loader.load(CACHED)])
    expect(first).toBe('data:image/png;base64,AAAA')
    expect(second).toBe(first)
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest.mock.calls[0][0]).toBe('nativeChat.readImage')
  })

  it('never asks the host for a path outside its image cache', async () => {
    const sendRequest = vi.fn()
    const loader = new NativeChatHostImageLoader(fakeClient(sendRequest))
    await expect(loader.load('/tmp/pasted.png')).resolves.toBeNull()
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('stops asking a host that predates nativeChat.readImage', async () => {
    const sendRequest = vi.fn().mockResolvedValue(failure('method_not_found'))
    const loader = new NativeChatHostImageLoader(fakeClient(sendRequest))
    await expect(loader.load(CACHED)).resolves.toBeNull()
    await expect(loader.load(CACHED.replace('.png', '.jpg'))).resolves.toBeNull()
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('retries a path after a transient refusal', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(failure('runtime_unavailable'))
      .mockResolvedValueOnce(imageReply('BBBB'))
    const loader = new NativeChatHostImageLoader(fakeClient(sendRequest))
    await expect(loader.load(CACHED)).resolves.toBeNull()
    await expect(loader.load(CACHED)).resolves.toBe('data:image/png;base64,BBBB')
  })
})
