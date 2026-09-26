import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type {
  NativeChatBlock,
  NativeChatImageRefBlock,
  NativeChatMessage
} from '../../shared/native-chat-types'
import { isKnownRasterImageMimeType } from '../../shared/raster-image-preview-limits'
import {
  PRIVATE_FILE_MODE,
  ensurePrivateDir,
  tightenPathMode
} from '../daemon/daemon-private-file-modes'

// Per-image persist cap. Screenshots are 100KB–3MB in practice; 8 MiB bounds a
// runaway capture without touching real ones. Maintainer-adjustable (#23246).
export const NATIVE_CHAT_IMAGE_CACHE_MAX_BYTES = 8 * 1024 * 1024
const CACHE_DIR_NAME = 'native-chat-images'

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.split('/', 2)[1] ?? '') {
    case 'jpeg':
    case 'jpg':
    case 'pjpeg':
      return 'jpg'
    case 'ico':
    case 'vnd.microsoft.icon':
    case 'x-icon':
      return 'ico'
    case 'bmp':
    case 'x-bmp':
    case 'x-ms-bmp':
      return 'bmp'
    case 'apng':
      return 'png'
    default:
      return 'png'
  }
}

function parseInlineImage(url: string): { mimeType: string; bytes: Buffer } | null {
  const match = /^data:([^;,]+);base64,(.*)$/is.exec(url.trim())
  if (!match) {
    return null
  }
  const mimeType = match[1].split(';', 1)[0].trim().toLowerCase()
  if (!isKnownRasterImageMimeType(mimeType)) {
    return null
  }
  const payload = match[2].replace(/\s/g, '')
  if (payload.length === 0 || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    return null
  }
  const bytes = Buffer.from(payload, 'base64')
  if (bytes.length === 0 || bytes.length > NATIVE_CHAT_IMAGE_CACHE_MAX_BYTES) {
    return null
  }
  return { mimeType, bytes }
}

let cacheDirOverride: string | undefined

/** Test-only: redirect the image cache (pass no arg to restore userData). */
export function setNativeChatImageCacheDirForTests(dir?: string): void {
  cacheDirOverride = dir
}

function defaultCacheDir(): string {
  return cacheDirOverride ?? join(getAppEnvironment().getPath('userData'), CACHE_DIR_NAME)
}

function isInlineImageRef(block: NativeChatBlock): block is NativeChatImageRefBlock {
  return block.type === 'image-ref' && /^\s*data:/i.test(block.url ?? '')
}

/**
 * Persist inline (data:) image bytes to the host image cache and rewrite the
 * refs to cache paths. Content-hash naming makes writes idempotent across
 * re-reads; private modes apply because screenshots are the user's pixels.
 * Fail-open: anything unparseable, oversized, or unwritable keeps its inline
 * URL, which desktop still renders (mobile shows its placeholder instead).
 */
export function hydrateNativeChatImageRefs(
  messages: readonly NativeChatMessage[],
  options: { cacheDir?: string } = {}
): NativeChatMessage[] {
  if (!messages.some((message) => message.blocks.some(isInlineImageRef))) {
    return [...messages]
  }
  const cacheDir = options.cacheDir ?? defaultCacheDir()
  ensurePrivateDir(cacheDir)
  return messages.map((message) => {
    if (!message.blocks.some(isInlineImageRef)) {
      return message
    }
    return {
      ...message,
      blocks: message.blocks.map((block) => hydrateBlock(block, cacheDir))
    }
  })
}

function hydrateBlock(block: NativeChatBlock, cacheDir: string): NativeChatBlock {
  if (!isInlineImageRef(block)) {
    return block
  }
  try {
    const parsed = parseInlineImage(block.url ?? '')
    if (!parsed) {
      return block
    }
    const digest = createHash('sha256').update(parsed.bytes).digest('hex')
    const filePath = join(cacheDir, `${digest}.${extensionForMimeType(parsed.mimeType)}`)
    if (!existsSync(filePath)) {
      writeFileSync(filePath, parsed.bytes, { mode: PRIVATE_FILE_MODE })
    }
    tightenPathMode(filePath, PRIVATE_FILE_MODE)
    return {
      type: 'image-ref',
      path: filePath,
      ...(block.alt ? { alt: block.alt } : {})
    }
  } catch {
    return block
  }
}
