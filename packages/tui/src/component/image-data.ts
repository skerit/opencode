// @ts-ignore Bun embeds this file in compiled executables.
import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }
import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { TerminalImage } from "./terminal-image"

export type ImagePreview = Readonly<{ width: number; height: number; image: TerminalImage }>

const MAX_BYTES = 10 * 1024 * 1024
const MAX_CACHE = 32 * 1024 * 1024
const cache = new Map<string, ImagePreview>()
let cacheBytes = 0
let requests = 0

export function imageDataCacheStats() {
  return { entries: cache.size, bytes: cacheBytes, requests }
}

/** Header inspection retains no compressed bytes or decoded pixels. */
export function inspectImage(url: string, mime: string) {
  return Object.freeze(dimensions(imageBytes(url, mime), mime))
}

/** Only canonical inline base64 is accepted; no resource is ever fetched. */
export async function decodeImage(
  url: string,
  mime: string,
  maxWidth = 1000,
  maxHeight = 1000,
  signal?: AbortSignal,
): Promise<ImagePreview> {
  requests++
  signal?.throwIfAborted()
  const bytes = imageBytes(url, mime)
  const size = dimensions(bytes, mime)
  if (!Number.isFinite(maxWidth) || !Number.isFinite(maxHeight) || maxWidth < 1 || maxHeight < 1)
    throw new Error("No space for image preview")
  const scale = Math.min(1, Math.min(1000, maxWidth) / size.width, Math.min(1000, maxHeight) / size.height)
  const width = Math.max(1, Math.floor(size.width * scale))
  const height = Math.max(1, Math.floor(size.height * scale))
  const key = `${createHash("sha256").update(bytes).digest("hex")}:${width}:${height}`
  const cached = cache.get(key)
  if (cached) {
    cache.delete(key)
    cache.set(key, cached)
    // Typed arrays cannot be frozen; callers receive their own buffers, never the cached buffers.
    return Object.freeze({
      ...cached,
      image: Object.freeze({ ...cached.image, rgba: cached.image.rgba.slice(), png: cached.image.png.slice() }),
    })
  }
  ;(globalThis as typeof globalThis & { __OPENCODE_PHOTON_WASM_PATH?: string }).__OPENCODE_PHOTON_WASM_PATH =
    path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))
  const photon = await import("@silvia-odwyer/photon-node").catch(() => {
    throw new Error("Image decoder unavailable")
  })
  signal?.throwIfAborted()
  const result = (() => {
    try {
      const source = photon.PhotonImage.new_from_byteslice(bytes)
      try {
        if (source.get_width() !== size.width || source.get_height() !== size.height)
          throw new Error("Image dimensions do not match its header")
        const resized =
          width === size.width && height === size.height
            ? source
            : photon.resize(source, width, height, photon.SamplingFilter.Lanczos3)
        try {
          return Object.freeze({
            ...size,
            image: Object.freeze({ width, height, rgba: resized.get_raw_pixels(), png: resized.get_bytes() }),
          })
        } finally {
          if (resized !== source) resized.free()
        }
      } finally {
        source.free()
      }
    } catch {
      throw new Error("Invalid or damaged image")
    }
  })()
  const cost = result.image.rgba.byteLength + result.image.png.byteLength
  if (cost > 8 * 1024 * 1024) throw new Error("Decoded preview exceeds the 8 MiB memory limit")
  // A concurrent decode may have populated this key while the WASM import was pending.
  const previous = cache.get(key)
  if (previous) {
    cacheBytes -= previous.image.rgba.byteLength + previous.image.png.byteLength
    cache.delete(key)
  }
  while (cache.size && (cache.size >= 16 || cacheBytes + cost > MAX_CACHE)) {
    const oldest = cache.entries().next().value!
    cacheBytes -= oldest[1].image.rgba.byteLength + oldest[1].image.png.byteLength
    cache.delete(oldest[0])
  }
  cache.set(key, result)
  cacheBytes += cost
  return Object.freeze({
    ...result,
    image: Object.freeze({ ...result.image, rgba: result.image.rgba.slice(), png: result.image.png.slice() }),
  })
}

function imageBytes(url: string, mime: string) {
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime))
    throw new Error("Unsupported image format (PNG, JPEG, GIF and WebP only)")
  const prefix = `data:${mime};base64,`
  if (!url.startsWith(prefix)) throw new Error("Only inline base64 images can be previewed")
  const length = url.length - prefix.length
  if (length > MAX_BYTES) throw new Error("Image exceeds the 10 MiB base64 preview limit")
  const base64 = url.slice(prefix.length)
  if (!length || length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(base64)) throw new Error("Invalid base64 image")
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  if (base64.indexOf("=") !== (padding ? length - padding : -1)) throw new Error("Invalid base64 image")
  const bytes = Buffer.from(base64, "base64")
  if (bytes.toString("base64") !== base64) throw new Error("Invalid base64 image")
  return bytes
}

function dimensions(bytes: Buffer, mime: string) {
  const invalid = () => new Error("Invalid or truncated image header")
  const check = (width: number, height: number) => {
    if (!width || !height) throw invalid()
    if (width > 8192 || height > 8192 || width * height > 16 * 1024 * 1024)
      throw new Error("Image exceeds preview dimensions (8192 per side, 16 megapixels)")
    return { width, height }
  }
  if (mime === "image/png") {
    if (
      bytes.length < 33 ||
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString("ascii", 12, 16) !== "IHDR"
    )
      throw invalid()
    return check(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
  }
  if (mime === "image/jpeg") {
    if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) throw invalid()
    let offset = 2
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) throw invalid()
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]!
      if (marker === 0xd9 || marker === 0xda || marker === 0 || offset + 2 > bytes.length) throw invalid()
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      const length = bytes.readUInt16BE(offset)
      if (length < 2 || offset + length > bytes.length) throw invalid()
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) throw invalid()
        return check(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))
      }
      offset += length
    }
    throw invalid()
  }
  if (mime === "image/gif") {
    if (bytes.length < 13 || !["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) throw invalid()
    const size = check(bytes.readUInt16LE(6), bytes.readUInt16LE(8))
    let offset = 13 + (bytes[10]! & 0x80 ? 3 * 2 ** ((bytes[10]! & 7) + 1) : 0)
    // Frame rectangles must also be bounded, not just the logical screen.
    while (offset < bytes.length) {
      const tag = bytes[offset++]
      if (tag === 0x3b) return size
      if (tag === 0x21) offset++
      else if (tag === 0x2c) {
        if (offset + 9 > bytes.length) throw invalid()
        const frame = check(bytes.readUInt16LE(offset + 4), bytes.readUInt16LE(offset + 6))
        if (
          bytes.readUInt16LE(offset) + frame.width > size.width ||
          bytes.readUInt16LE(offset + 2) + frame.height > size.height
        )
          throw invalid()
        const packed = bytes[offset + 8]!
        offset += 9 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0) + 1
      } else throw invalid()
      while (offset < bytes.length && bytes[offset]) offset += 1 + bytes[offset]!
      if (offset >= bytes.length) throw invalid()
      offset++
    }
    throw invalid()
  }
  if (
    bytes.length < 20 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    throw invalid()
  let canvas: ReturnType<typeof check> | undefined
  let image: ReturnType<typeof check> | undefined
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const tag = bytes.toString("ascii", offset, offset + 4)
    const length = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    if (start + length > bytes.length) throw invalid()
    if (tag === "VP8X") {
      if (length !== 10) throw invalid()
      canvas = check(1 + bytes.readUIntLE(start + 4, 3), 1 + bytes.readUIntLE(start + 7, 3))
      if (bytes[start]! & 2) throw new Error("Animated WebP previews are not supported")
    }
    if (tag === "ANIM" || tag === "ANMF") throw new Error("Animated WebP previews are not supported")
    if (tag === "VP8 ") {
      if (length < 10 || bytes.subarray(start + 3, start + 6).toString("hex") !== "9d012a") throw invalid()
      image = check(bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff)
    }
    if (tag === "VP8L") {
      if (length < 5 || bytes[start] !== 0x2f) throw invalid()
      const bits = bytes.readUInt32LE(start + 1)
      image = check((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
    }
    offset = start + length + (length & 1)
  }
  if (!image || (canvas && (canvas.width !== image.width || canvas.height !== image.height))) throw invalid()
  return image
}
