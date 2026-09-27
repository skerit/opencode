/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { BaseRenderable, ScrollBoxRenderable } from "@opentui/core"
import { createSignal, For, Show, type JSX } from "solid-js"
import { decodeImage, imageDataCacheStats, inspectImage } from "../../src/component/image-data"
import { ImageAttachment, imagePreviewStats } from "../../src/component/image-attachment"
import { TerminalImageRenderable } from "../../src/component/terminal-image"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
const url = `data:image/png;base64,${png}`

describe("inline image decoder", () => {
  test("header inspection retains only dimensions and never requests pixels", () => {
    const before = imageDataCacheStats()
    expect(inspectImage(url, "image/png")).toEqual({ width: 1, height: 1 })
    const header = Buffer.from(png, "base64").subarray(0, 33)
    header.writeUInt32BE(1000, 16)
    header.writeUInt32BE(1000, 20)
    expect(inspectImage(`data:image/png;base64,${header.toString("base64")}`, "image/png")).toEqual({
      width: 1000,
      height: 1000,
    })
    expect(imageDataCacheStats()).toEqual(before)
  })

  test("aborted pending decodes do not populate the cache", async () => {
    const bytes = Buffer.from(png, "base64")
    bytes[45] = bytes[45]! ^ 128
    const abort = new AbortController()
    const before = imageDataCacheStats()
    const pending = decodeImage(
      `data:image/png;base64,${bytes.toString("base64")}`,
      "image/png",
      1000,
      1000,
      abort.signal,
    )
    abort.abort()
    await expect(pending).rejects.toThrow("abort")
    expect(imageDataCacheStats().entries).toBe(before.entries)
    expect(imageDataCacheStats().bytes).toBe(before.bytes)
  })
  test("decodes a real PNG and returns isolated cached buffers", async () => {
    const result = await decodeImage(url, "image/png")
    expect([result.width, result.height]).toEqual([1, 1])
    expect(Array.from(result.image.rgba)).toEqual([0, 0, 0, 255])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.image)).toBe(true)
    result.image.rgba.fill(123)
    result.image.png.fill(0)
    const cached = await decodeImage(url, "image/png")
    expect(Array.from(cached.image.rgba)).toEqual([0, 0, 0, 255])
    expect(Array.from(cached.image.png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  })

  test("preserves RGBA and original dimensions while fitting display bounds", async () => {
    await decodeImage(url, "image/png")
    const photon = await import("@silvia-odwyer/photon-node")
    const pixels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 64])
    const source = new photon.PhotonImage(pixels, 4, 1)
    try {
      const fixture = `data:image/png;base64,${Buffer.from(source.get_bytes()).toString("base64")}`
      const decoded = await decodeImage(fixture, "image/png")
      expect(Array.from(decoded.image.rgba)).toEqual(Array.from(pixels))
      const resized = await decodeImage(fixture, "image/png", 2, 2)
      expect([resized.width, resized.height]).toEqual([4, 1])
      expect([resized.image.width, resized.image.height]).toEqual([2, 1])
      expect(resized.image.rgba.length).toBe(8)
      expect(resized.image.rgba[7]).toBeLessThan(255)
      const roundtrip = photon.PhotonImage.new_from_byteslice(resized.image.png)
      try {
        expect(Array.from(roundtrip.get_raw_pixels())).toEqual(Array.from(resized.image.rgba))
      } finally {
        roundtrip.free()
      }
    } finally {
      source.free()
    }
  })

  test("caps large previews at 1000 pixels without stretching", async () => {
    await decodeImage(url, "image/png")
    const photon = await import("@silvia-odwyer/photon-node")
    const source = new photon.PhotonImage(new Uint8Array(2000 * 2 * 4).fill(255), 2000, 2)
    try {
      const decoded = await decodeImage(
        `data:image/png;base64,${Buffer.from(source.get_bytes()).toString("base64")}`,
        "image/png",
        5000,
        5000,
      )
      expect([decoded.width, decoded.height, decoded.image.width, decoded.image.height]).toEqual([2000, 2, 1000, 1])
    } finally {
      source.free()
    }
  })

  test.each(["https://example.invalid/image.png", "http://127.0.0.1/a", "file:///etc/passwd", "/tmp/image.png"])(
    "never resolves external input %s",
    async (input) => {
      await expect(decodeImage(input, "image/png")).rejects.toThrow("Only inline base64")
    },
  )

  test.each(["", "AAAA=", "AA A", "!!!!", "A===", "AB==", "AAB=", "AA==AAAA"])(
    "rejects noncanonical base64 %s",
    async (input) => {
      await expect(decodeImage(`data:image/png;base64,${input}`, "image/png")).rejects.toThrow("Invalid base64")
    },
  )

  test("rejects SVG, mismatched types, damaged data and oversized inputs", async () => {
    await expect(decodeImage("data:image/svg+xml;base64,PHN2Zy8+", "image/svg+xml")).rejects.toThrow("Unsupported")
    await expect(decodeImage(url, "image/jpeg")).rejects.toThrow("Only inline")
    await expect(decodeImage("data:image/jpeg;base64," + png, "image/jpeg")).rejects.toThrow("header")
    await expect(
      decodeImage("data:image/png;base64," + "AAAA".repeat((10 * 1024 * 1024) / 4 + 1), "image/png"),
    ).rejects.toThrow("10 MiB")
    const damaged = Buffer.from(png, "base64")
    damaged[45] = damaged[45]! ^ 255
    await expect(decodeImage(`data:image/png;base64,${damaged.toString("base64")}`, "image/png")).rejects.toThrow(
      "damaged",
    )
  })

  test.each([
    [8193, 1],
    [8192, 8192],
    [0, 1],
  ])("rejects PNG header dimensions %s x %s before pixel decoding", async (width, height) => {
    const header = Buffer.from(png, "base64").subarray(0, 33)
    header.writeUInt32BE(width, 16)
    header.writeUInt32BE(height, 20)
    await expect(decodeImage(`data:image/png;base64,${header.toString("base64")}`, "image/png")).rejects.toThrow(
      width ? "preview dimensions" : "header",
    )
  })

  test("checks JPEG, GIF and each WebP dimension header before decoding", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 1, 0x20, 1, 1])
    const gif = Buffer.from("474946383961012001000000003b", "hex")
    const webp = (tag: string, data: Buffer) => {
      const header = Buffer.alloc(20)
      header.write("RIFF")
      header.writeUInt32LE(12 + data.length, 4)
      header.write("WEBP", 8)
      header.write(tag, 12)
      header.writeUInt32LE(data.length, 16)
      return Buffer.concat([header, data])
    }
    const vp8 = Buffer.from("0000009d012a01200100", "hex")
    const vp8x = Buffer.from("00000000002000000000", "hex")
    const vp8l = Buffer.from("2f0020000000", "hex")
    for (const [mime, bytes] of [
      ["image/jpeg", jpeg],
      ["image/gif", gif],
      ["image/webp", webp("VP8 ", vp8)],
      ["image/webp", webp("VP8X", vp8x)],
      ["image/webp", webp("VP8L", vp8l)],
    ] as const) {
      await expect(decodeImage(`data:${mime};base64,${bytes.toString("base64")}`, mime)).rejects.toThrow(
        "preview dimensions",
      )
    }
  })

  test("decodes real JPEG, GIF and lossless WebP", async () => {
    await decodeImage(url, "image/png")
    const photon = await import("@silvia-odwyer/photon-node")
    const source = new photon.PhotonImage(new Uint8Array([255, 0, 0, 255]), 1, 1)
    try {
      const jpeg = await decodeImage(
        `data:image/jpeg;base64,${Buffer.from(source.get_bytes_jpeg(90)).toString("base64")}`,
        "image/jpeg",
      )
      expect([jpeg.width, jpeg.height]).toEqual([1, 1])
      expect(jpeg.image.rgba[0]).toBeGreaterThan(240)
    } finally {
      source.free()
    }
    const gif = await decodeImage(
      "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      "image/gif",
    )
    expect([gif.width, gif.height]).toEqual([1, 1])
    const webp = await decodeImage(
      "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==",
      "image/webp",
    )
    expect([webp.width, webp.height]).toEqual([1, 1])
  })
})

describe("ImageAttachment", () => {
  test("renders within padded parent bounds, resizes, suppresses zero width, and replaces stale content", async () => {
    const [width, setWidth] = createSignal(12)
    const [input, setInput] = createSignal(url)
    const [maxRows, setMaxRows] = createSignal<number>()
    const [maxColumns, setMaxColumns] = createSignal<number>()
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <TuiConfigProvider config={createTuiResolvedConfig()}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <box width={width()} paddingX={2} overflow="hidden">
                  <ImageAttachment
                    url={input()}
                    mime="image/png"
                    filename="sample.png"
                    maxRows={maxRows()}
                    maxColumns={maxColumns()}
                  />
                </box>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </TestTuiContexts>
      ),
      { width: 50, height: 30 },
    )
    try {
      const settle = async () => {
        for (let i = 0; i < 8; i++) {
          await app.renderOnce()
          await Bun.sleep(10)
        }
      }
      await settle()
      const images = () => {
        const visit = (node: BaseRenderable): TerminalImageRenderable[] =>
          node.getChildren().flatMap((child) => (child instanceof TerminalImageRenderable ? [child] : visit(child)))
        return visit(app.renderer.root)
      }
      expect(images()).toHaveLength(1)
      expect([images()[0]!.width, images()[0]!.height]).toEqual([8, 4])
      expect(images()[0]!.screenX).toBe(2)
      setWidth(8)
      await settle()
      expect([images()[0]!.width, images()[0]!.height]).toEqual([4, 2])
      setWidth(5)
      await settle()
      expect(images()[0]!.width).toBe(1)
      setWidth(4)
      await settle()
      expect(images()).toHaveLength(0)
      setWidth(120)
      await settle()
      expect([images()[0]!.width, images()[0]!.height]).toEqual([36, 18])
      app.resize(50, 10)
      await settle()
      expect([images()[0]!.width, images()[0]!.height]).toEqual([12, 6])
      setMaxRows(2)
      setMaxColumns(3)
      await settle()
      expect([images()[0]!.width, images()[0]!.height]).toEqual([3, 2])
      setMaxRows(0)
      await settle()
      expect(images()).toHaveLength(0)
      setMaxRows(undefined)
      setMaxColumns(undefined)
      setWidth(50)
      setInput("https://example.invalid/private-image.png")
      await settle()
      expect(images()).toHaveLength(0)
      expect(app.captureCharFrame()).toContain("sample.png: Only inline base64")
      expect(app.captureCharFrame()).not.toContain("https://")
      setInput(url)
      setInput("data:image/png;base64,!!!!")
      await settle()
      expect(images()).toHaveLength(0)
      expect(app.captureCharFrame()).toContain("Invalid base64")
      expect(app.captureCharFrame()).not.toContain("data:")
      setInput(url)
    } finally {
      app.renderer.destroy()
    }
  })

  test("protocol off renders only the filename and original dimensions", async () => {
    const previous = process.env.OPENCODE_IMAGE_PROTOCOL
    process.env.OPENCODE_IMAGE_PROTOCOL = "off"
    const before = imageDataCacheStats()
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <TuiConfigProvider config={createTuiResolvedConfig()}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ImageAttachment url={url} mime="image/png" filename="disabled.png" />
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </TestTuiContexts>
      ),
      { width: 40, height: 20 },
    )
    try {
      for (let i = 0; i < 8; i++) {
        await app.renderOnce()
        await Bun.sleep(10)
      }
      expect(app.captureCharFrame().trim()).toBe("disabled.png (1x1)")
      const visit = (node: BaseRenderable): boolean =>
        node instanceof TerminalImageRenderable || node.getChildren().some(visit)
      expect(visit(app.renderer.root)).toBe(false)
      expect(imageDataCacheStats()).toEqual(before)
      expect(imagePreviewStats(app.renderer)).toEqual({ owners: 0, bytes: 0 })
    } finally {
      app.renderer.destroy()
      if (previous === undefined) delete process.env.OPENCODE_IMAGE_PROTOCOL
      else process.env.OPENCODE_IMAGE_PROTOCOL = previous
    }
  })

  test("bounds mounted historical pixel owners, preserves scroll geometry, and releases on hide and unmount", async () => {
    const protocol = process.env.OPENCODE_IMAGE_PROTOCOL
    await decodeImage(url, "image/png")
    const photon = await import("@silvia-odwyer/photon-node")
    const source = new photon.PhotonImage(new Uint8Array(1000 * 1000 * 4).fill(255), 1000, 1000)
    const fixture = `data:image/png;base64,${Buffer.from(source.get_bytes()).toString("base64")}`
    source.free()
    const [mounted, setMounted] = createSignal(true)
    const [visible, setVisible] = createSignal(true)
    const [opacity, setOpacity] = createSignal(1)
    let scroll: ScrollBoxRenderable | undefined
    const app = await testRender(
      () =>
        withTheme(() => (
          <Show when={mounted()}>
            <box visible={visible()} opacity={opacity()} width={40} height={40}>
              <scrollbox
                ref={(value) => {
                  scroll = value
                }}
                width={40}
                height={40}
              >
                <For each={Array.from({ length: 80 }, (_, i) => i)}>
                  {(index) => (
                    <box id={`attachment-${index}`} flexShrink={0}>
                      <ImageAttachment url={fixture} mime="image/png" filename={`image-${index}`} maxRows={1} />
                    </box>
                  )}
                </For>
              </scrollbox>
            </box>
          </Show>
        )),
      { width: 50, height: 50 },
    )
    try {
      await settle(app)
      expect(imagePreviewStats(app.renderer).owners).toBe(8)
      expect(app.renderer.listenerCount("resize")).toBeLessThan(10)
      const cost = images(app.renderer.root).reduce(
        (sum, image) => sum + image.image!.rgba.byteLength + image.image!.png.byteLength,
        0,
      )
      expect(cost).toBeGreaterThanOrEqual(8 * 1000 * 1000 * 4)
      expect(imagePreviewStats(app.renderer).bytes).toBe(cost)
      expect(cost).toBeLessThanOrEqual(64 * 1024 * 1024)
      expect(images(app.renderer.root)).toHaveLength(8)
      expect(imageDataCacheStats().bytes).toBeLessThanOrEqual(32 * 1024 * 1024)
      const height = scroll!.scrollHeight
      expect(height).toBeGreaterThanOrEqual(160)
      const first = images(app.renderer.root).map((image) => image.num)
      scroll!.scrollTo(90)
      await settle(app)
      expect(scroll!.scrollHeight).toBe(height)
      expect(scroll!.scrollTop).toBe(90)
      expect(imagePreviewStats(app.renderer)).toEqual({ owners: 8, bytes: cost })
      expect(images(app.renderer.root).every((image) => !first.includes(image.num))).toBe(true)
      expect(app.captureCharFrame()).toContain("image-45")
      scroll!.scrollTo(0)
      await settle(app)
      expect(imagePreviewStats(app.renderer)).toEqual({ owners: 8, bytes: cost })
      expect(app.captureCharFrame()).toContain("image-0")
      expect(scroll!.scrollHeight).toBe(height)
      setOpacity(0)
      await settle(app)
      expect(imagePreviewStats(app.renderer)).toEqual({ owners: 0, bytes: 0 })
      expect(images(app.renderer.root)).toHaveLength(0)
      expect(scroll!.scrollHeight).toBe(height)
      const hidden = imageDataCacheStats()
      await settle(app)
      expect(imageDataCacheStats()).toEqual(hidden)
      setOpacity(1)
      await settle(app)
      expect(imagePreviewStats(app.renderer).owners).toBe(8)
      setVisible(false)
      await settle(app)
      expect(imagePreviewStats(app.renderer)).toEqual({ owners: 0, bytes: 0 })
      setVisible(true)
      await settle(app)
      expect(imagePreviewStats(app.renderer).owners).toBe(8)
      process.env.OPENCODE_IMAGE_PROTOCOL = "off"
      await settle(app)
      expect(imagePreviewStats(app.renderer)).toEqual({ owners: 0, bytes: 0 })
      expect(images(app.renderer.root)).toHaveLength(0)
      expect(scroll!.scrollHeight).toBe(height)
      const disabled = imageDataCacheStats()
      await settle(app)
      expect(imageDataCacheStats()).toEqual(disabled)
      if (protocol === undefined) delete process.env.OPENCODE_IMAGE_PROTOCOL
      else process.env.OPENCODE_IMAGE_PROTOCOL = protocol
      await settle(app)
      expect(imagePreviewStats(app.renderer).owners).toBe(8)
      setMounted(false)
      await settle(app)
      expect(imagePreviewStats(app.renderer)).toEqual({ owners: 0, bytes: 0 })
      const unmounted = imageDataCacheStats()
      await settle(app)
      expect(imageDataCacheStats()).toEqual(unmounted)
    } finally {
      app.renderer.destroy()
      if (protocol === undefined) delete process.env.OPENCODE_IMAGE_PROTOCOL
      else process.env.OPENCODE_IMAGE_PROTOCOL = protocol
    }
    expect(imagePreviewStats(app.renderer)).toEqual({ owners: 0, bytes: 0 })
  })

  test("automatic scheduler paints cached previews and reacquires slots when scrolling backward", async () => {
    await decodeImage(url, "image/png")
    const [opacity, setOpacity] = createSignal(1)
    let scroll: ScrollBoxRenderable | undefined
    const app = await testRender(
      () =>
        withTheme(() => (
          <scrollbox
            ref={(value) => {
              scroll = value
            }}
            width={40}
            height={16}
            opacity={opacity()}
            viewportCulling={false}
          >
            <For each={Array.from({ length: 24 }, (_, index) => index)}>
              {(index) => <ImageAttachment url={url} mime="image/png" filename={`cached-${index}`} maxRows={1} />}
            </For>
          </scrollbox>
        )),
      { width: 40, height: 16 },
    )
    try {
      const painted = async (filename: string) => {
        const deadline = Date.now() + 2000
        const ready = () => {
          const scheduler = app.renderer.getSchedulerState()
          const frame = app.captureCharFrame()
          return (
            !scheduler.isRunning &&
            !scheduler.isRendering &&
            !scheduler.hasScheduledRender &&
            frame.includes(`${filename} (1x1)`) &&
            frame.split("\n").filter((row) => row.startsWith("\u2580\u2580")).length === 8 &&
            imagePreviewStats(app.renderer).owners === 8
          )
        }
        while (!ready() && Date.now() < deadline) await Bun.sleep(5)
        expect(app.captureCharFrame()).toContain(`${filename} (1x1)`)
        expect(
          app
            .captureCharFrame()
            .split("\n")
            .filter((row) => row.startsWith("\u2580\u2580")),
        ).toHaveLength(8)
        expect(ready()).toBe(true)
      }
      app.renderer.requestRender()
      await painted("cached-0")
      scroll!.scrollTo(32)
      await painted("cached-16")
      scroll!.scrollTo(0)
      await painted("cached-0")
      setOpacity(0)
      const deadline = Date.now() + 2000
      while (imagePreviewStats(app.renderer).owners && Date.now() < deadline) await Bun.sleep(5)
      expect(imagePreviewStats(app.renderer).owners).toBe(0)
      await app.renderer.idle()
      setOpacity(1)
      await painted("cached-0")
    } finally {
      app.renderer.destroy()
    }
    expect(imagePreviewStats(app.renderer)).toEqual({ owners: 0, bytes: 0 })
  })

  test("offscreen headers reserve space without decoding and source replacement discards pending completion", async () => {
    const [input, setInput] = createSignal(url)
    const [mounted, setMounted] = createSignal(true)
    let scroll: ScrollBoxRenderable | undefined
    const before = imageDataCacheStats()
    const app = await testRender(
      () =>
        withTheme(() => (
          <scrollbox
            ref={(value) => {
              scroll = value
            }}
            width={40}
            height={5}
          >
            <box height={10} flexShrink={0} />
            <Show when={mounted()}>
              <ImageAttachment url={input()} mime="image/png" filename="pending" maxRows={2} />
            </Show>
          </scrollbox>
        )),
      { width: 40, height: 10 },
    )
    try {
      await settle(app)
      expect(imageDataCacheStats()).toEqual(before)
      expect(imagePreviewStats(app.renderer)).toEqual({ owners: 0, bytes: 0 })
      expect(scroll!.scrollHeight).toBe(13)
      let replacedPending = false
      const replace = () => {
        if (imagePreviewStats(app.renderer).owners) {
          replacedPending = imagePreviewStats(app.renderer).bytes === 0
          setInput("data:image/png;base64,!!!!")
        }
      }
      app.renderer.addPostProcessFn(replace)
      scroll!.scrollTo(10)
      await settle(app)
      app.renderer.removePostProcessFn(replace)
      expect(replacedPending).toBe(true)
      expect(imagePreviewStats(app.renderer)).toEqual({ owners: 0, bytes: 0 })
      expect(images(app.renderer.root)).toHaveLength(0)
      expect(app.captureCharFrame()).toContain("Invalid base64")
      let removedPending = false
      const remove = () => {
        if (imagePreviewStats(app.renderer).owners) {
          removedPending = imagePreviewStats(app.renderer).bytes === 0
          setMounted(false)
        }
      }
      app.renderer.addPostProcessFn(remove)
      setInput(url)
      scroll!.scrollTo(10)
      await settle(app)
      app.renderer.removePostProcessFn(remove)
      expect(removedPending).toBe(true)
      expect(imagePreviewStats(app.renderer)).toEqual({ owners: 0, bytes: 0 })
      expect(images(app.renderer.root)).toHaveLength(0)
    } finally {
      app.renderer.destroy()
    }
  })
})

function withTheme(component: () => JSX.Element) {
  return (
    <TestTuiContexts>
      <TuiConfigProvider config={createTuiResolvedConfig()}>
        <KVProvider>
          <ThemeProvider mode="dark">{component()}</ThemeProvider>
        </KVProvider>
      </TuiConfigProvider>
    </TestTuiContexts>
  )
}

async function settle(app: Awaited<ReturnType<typeof testRender>>) {
  for (let i = 0; i < 8; i++) {
    await app.renderOnce()
    await Bun.sleep(10)
  }
}

function images(node: BaseRenderable): TerminalImageRenderable[] {
  return node.getChildren().flatMap((child) => (child instanceof TerminalImageRenderable ? [child] : images(child)))
}
