import { useEffect, useMemo, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { nativeChatImageRead } from './mobile-session-read-operations'

// Mirrors the host cache's content-hash file names; any other host path is not fetchable.
const CACHED_IMAGE_NAME = /(?:^|[\\/])[0-9a-f]{64}\.(?:png|jpg|gif|webp|bmp|ico)$/
const MAX_CACHED_IMAGES = 16

export function isNativeChatCachedImagePath(path: string | undefined): path is string {
  return typeof path === 'string' && CACHED_IMAGE_NAME.test(path)
}

export type NativeChatImageLoad = (path: string) => Promise<string | null>

/** Fetches cached chat images as data: URIs, deduped and bounded, and stops asking a host
 *  that predates `nativeChat.readImage`. */
export class NativeChatHostImageLoader {
  private readonly images = new Map<string, Promise<string | null>>()
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
      return Promise.resolve(null)
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

  private async fetch(path: string): Promise<string | null> {
    try {
      const response = await nativeChatImageRead.request(this.client, { path })
      const accepted = nativeChatImageRead.interpret(response)
      if (!accepted.accepted) {
        if (!response.ok && response.error.code === 'method_not_found') {
          this.unsupported = true
        }
        // A transient refusal (dropped link, busy host) may succeed on a later render.
        this.images.delete(path)
        return null
      }
      const { content, mimeType, isImage } = accepted.value
      if (isImage !== true || !content || !mimeType) {
        return null
      }
      return `data:${mimeType};base64,${content}`
    } catch {
      this.images.delete(path)
      return null
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
  useEffect(() => {
    if (!load || !isNativeChatCachedImagePath(path)) {
      return
    }
    let active = true
    void load(path).then((uri) => {
      if (active && uri) {
        setLoaded({ path, uri })
      }
    })
    return () => {
      active = false
    }
  }, [path, load])
  return loaded && loaded.path === path ? loaded.uri : null
}
