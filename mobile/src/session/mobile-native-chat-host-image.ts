import { useEffect, useMemo, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { nativeChatImageRead } from './mobile-session-read-operations'

// Mirrors the host cache's content-hash file names; any other host path is not fetchable.
const CACHED_IMAGE_NAME = /(?:^|[\\/])[0-9a-f]{64}\.(?:png|jpg|gif|webp|bmp|ico)$/
const MAX_CACHED_IMAGES = 16

export function isNativeChatCachedImagePath(path: string | undefined): path is string {
  return typeof path === 'string' && CACHED_IMAGE_NAME.test(path)
}

/** `retry` marks a refusal a later attempt may overcome (dropped link, busy host). */
export type NativeChatImageLoadResult = { uri: string } | { uri: null; retry: boolean }
export type NativeChatImageLoad = (path: string) => Promise<NativeChatImageLoadResult>

const SETTLED: NativeChatImageLoadResult = { uri: null, retry: false }
const TRANSIENT: NativeChatImageLoadResult = { uri: null, retry: true }
// A still-mounted row re-asks after a transient refusal, so a reconnect on the same client heals it.
const RETRY_DELAYS_MS = [2_000, 8_000, 30_000]

/** Fetches cached chat images as data: URIs, deduped and bounded, and stops asking a host
 *  that predates `nativeChat.readImage`. */
export class NativeChatHostImageLoader {
  private readonly images = new Map<string, Promise<NativeChatImageLoadResult>>()
  private unsupported = false

  constructor(private readonly client: RpcClient) {}

  load: NativeChatImageLoad = (path) => {
    const existing = this.images.get(path)
    if (existing) {
      // Refresh recency so the visible images outlive ones scrolled far away.
      this.images.delete(path)
      this.images.set(path, existing)
      return existing
    }
    if (this.unsupported || !isNativeChatCachedImagePath(path)) {
      return Promise.resolve(SETTLED)
    }
    const pending = this.fetch(path)
    this.images.set(path, pending)
    if (this.images.size > MAX_CACHED_IMAGES) {
      const oldest = this.images.keys().next().value
      if (oldest !== undefined) {
        this.images.delete(oldest)
      }
    }
    return pending
  }

  private async fetch(path: string): Promise<NativeChatImageLoadResult> {
    try {
      const response = await nativeChatImageRead.request(this.client, { path })
      const accepted = nativeChatImageRead.interpret(response)
      if (!accepted.accepted) {
        if (!response.ok && response.error.code === 'method_not_found') {
          this.unsupported = true
          return SETTLED
        }
        // An image over the transport budget stays over it; keep the result so remounts don't re-ask.
        if (!response.ok && response.error.message.includes('file_too_large')) {
          return SETTLED
        }
        this.images.delete(path)
        return TRANSIENT
      }
      const { content, mimeType, isImage } = accepted.value
      if (isImage !== true || !content || !mimeType) {
        return SETTLED
      }
      return { uri: `data:${mimeType};base64,${content}` }
    } catch {
      this.images.delete(path)
      return TRANSIENT
    }
  }
}

export function useNativeChatHostImageLoader(
  client: RpcClient | null
): NativeChatImageLoad | undefined {
  return useMemo(() => (client ? new NativeChatHostImageLoader(client).load : undefined), [client])
}

/** A cached host image as a loadable URI; null until (or unless) it arrives. */
export function useNativeChatHostImage(
  path: string | undefined,
  load: NativeChatImageLoad | undefined
): string | null {
  const [loaded, setLoaded] = useState<{ path: string; uri: string } | null>(null)
  const [attempt, setAttempt] = useState({ path, count: 0 })
  const [retryAfter, setRetryAfter] = useState<number | null>(null)
  const count = attempt.path === path ? attempt.count : 0

  useEffect(() => {
    if (!load || !isNativeChatCachedImagePath(path)) {
      return
    }
    let active = true
    void load(path).then((result) => {
      if (!active) {
        return
      }
      if (result.uri) {
        setLoaded({ path, uri: result.uri })
      } else if (result.uri === null && result.retry && count < RETRY_DELAYS_MS.length) {
        setRetryAfter(RETRY_DELAYS_MS[count])
      }
    })
    return () => {
      active = false
    }
  }, [path, load, count])

  useEffect(() => {
    if (retryAfter === null) {
      return
    }
    const timer = setTimeout(() => {
      setRetryAfter(null)
      setAttempt({ path, count: count + 1 })
    }, retryAfter)
    return () => clearTimeout(timer)
  }, [retryAfter, path, count])

  return loaded && loaded.path === path ? loaded.uri : null
}
