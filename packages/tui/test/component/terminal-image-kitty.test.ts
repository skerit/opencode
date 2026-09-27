import { afterEach, expect, test } from "bun:test"
import { Writable } from "node:stream"
import { BoxRenderable, RGBA, TextRenderable } from "@opentui/core"
import { createTestRenderer, setRendererCapabilities } from "@opentui/core/testing"
import { KittyTerminal, loadModuleSync, type KittyEvent } from "kitty-vt-wasm"
import { decodeImage } from "../../src/component/image-data"
import {
  TerminalImageRenderable,
  disposeTerminalImages,
  resetTerminalImages,
  type TerminalImage,
} from "../../src/component/terminal-image"

const wasm = loadModuleSync(Bun.resolveSync("kitty-vt-wasm/kitty-vt.wasm", import.meta.dir))
const finalizers: (() => void)[] = []
afterEach(() => {
  try {
    const errors: unknown[] = []
    for (const finalize of finalizers.toReversed()) {
      try {
        finalize()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, "Terminal teardown failed")
  } finally {
    finalizers.length = 0
  }
})

async function fixture(size = 2) {
  // Initialize the production Photon loader before using its PNG encoder.
  await decodeImage(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "image/png",
  )
  const { PhotonImage } = await import("@silvia-odwyer/photon-node")
  const rgba =
    size === 2
      ? new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 64])
      : Uint8Array.from({ length: size * size * 4 }, (_, i) => (i * 73 + (i >>> 3) * 29) & 255)
  const source = new PhotonImage(rgba, size, size)
  try {
    return { width: size, height: size, rgba, png: source.get_bytes() }
  } finally {
    source.free()
  }
}

async function setup(tmux = false) {
  const events: Extract<KittyEvent, { type: "graphics_command" }>[] = []
  const terminal = KittyTerminal.createSync({
    wasm,
    columns: 12,
    rows: 6,
    onEvent(event) {
      if (event.type === "graphics_command") events.push(event)
    },
  })
  finalizers.push(() => terminal.dispose())
  const output: string[] = []
  const stdout = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      output.push(chunk.toString())
      // Simulate allowed tmux passthrough, not a running tmux server. Only
      // remove exact DCS wrappers; doubled ESCs cannot terminate the wrapper.
      const bytes = tmux
        ? chunk
            .toString()
            .replace(/\x1bPtmux;((?:\x1b\x1b|[^\x1b])*)\x1b\\/g, (_, body: string) =>
              body.replaceAll("\x1b\x1b", "\x1b"),
            )
        : chunk
      terminal.write(bytes)
      callback()
    },
  })
  finalizers.push(() => stdout.destroy())
  const result = await createTestRenderer({
    width: 12,
    height: 6,
    stdout: stdout as NodeJS.WriteStream,
    bufferedOutput: "stdout",
    useThread: false,
    screenMode: "alternate-screen",
  })
  finalizers.push(() => {
    try {
      disposeTerminalImages(result.renderer)
    } finally {
      result.renderer.destroy()
    }
  })
  // Consume OpenTUI's real initialization, including alternate-screen entry,
  // before uploading: Kitty keeps independent main/alternate graphics stores.
  await result.renderer.setupTerminal()
  await result.flush()
  setRendererCapabilities(result.renderer, {
    rgb: true,
    kitty_graphics: true,
    terminal: { name: "kitty" },
    ...(tmux ? { multiplexer: "tmux" } : {}),
  })
  events.length = 0
  return { ...result, terminal, events, output }
}

async function expectUpload(result: Awaited<ReturnType<typeof setup>>, image: TerminalImage) {
  const uploads = result.events.filter((event) => event.action === "t")
  expect(uploads.filter((event) => event.more === 0)).toHaveLength(1)
  const upload = uploads[0]!
  expect(upload).toMatchObject({ format: 100, transmission: "d" })
  expect(upload.id).toBeGreaterThan(0)
  expect(upload.id).toBeLessThanOrEqual(0xffffff)
  // 0.2.0 exposes parsed payloads, not a decoded graphics-image cache. Photon
  // validates what the real VT parser received; this is not Kitty pixel readback.
  const { PhotonImage } = await import("@silvia-odwyer/photon-node")
  const chunks = result.events.filter((event) => event.payload)
  expect(chunks.at(-1)?.more).toBe(0)
  expect(chunks.slice(0, -1).every((event) => event.more === 1)).toBe(true)
  const decoded = PhotonImage.new_from_byteslice(Buffer.from(chunks.map((event) => event.payload).join(""), "base64"))
  try {
    expect(decoded.get_width()).toBe(image.width)
    expect(decoded.get_height()).toBe(image.height)
    expect(decoded.get_raw_pixels()).toEqual(image.rgba)
  } finally {
    decoded.free()
  }
  return upload.id
}

function expectPlacement(terminal: KittyTerminal, id: number, width: number, height: number) {
  expect(terminal.graphicsPlacements()).toHaveLength(1)
  expect(terminal.graphicsPlacements()[0]).toMatchObject({
    imageId: id,
    placementId: 1,
    unicodePlacement: true,
    numCols: width,
    numRows: height,
  })
}

test.each([false, true])(
  "native upload and RGB placeholders survive Kitty parsing (tmux passthrough: %s)",
  async (tmux) => {
    const result = await setup(tmux)
    const image = await fixture(tmux ? 32 : 2)
    result.renderer.setBackgroundColor("#182736")
    result.renderer.root.add(
      new TerminalImageRenderable(result.renderer, {
        image,
        width: 2,
        height: 2,
        background: RGBA.fromInts(24, 39, 54),
        protocol: "kitty",
      }),
    )
    result.renderer.root.add(new TextRenderable(result.renderer, { content: "theme", fg: "#abcdef" }))
    await result.renderOnce()
    const id = await expectUpload(result, image)
    expect(result.terminal.isMainScreen).toBe(false)
    expectPlacement(result.terminal, id, 2, 2)
    for (const y of [0, 1]) {
      for (const x of [0, 1]) {
        expect(result.terminal.cell(x, y)).toMatchObject({
          ch: "\u{10eeee}",
          combining: [y ? "\u030d" : "\u0305", x ? "\u030d" : "\u0305"],
          fg: { rgb: id },
          bg: { rgb: 0x182736 },
          decorationFg: null,
        })
      }
    }
    expect(result.terminal.cell(0, 2)).toMatchObject({ ch: "t", fg: { rgb: 0xabcdef } })
    if (tmux) {
      expect(result.events.filter((event) => event.payload).length).toBeGreaterThan(1)
      expect(result.output.join("")).toContain("\x1bPtmux;\x1b\x1b_G")
    }
    result.events.length = 0
    await result.renderOnce()
    expect(result.events).toEqual([])
    expectPlacement(result.terminal, id, 2, 2)
    disposeTerminalImages(result.renderer)
    await Bun.sleep(0)
    expect(result.events).toMatchObject([{ action: "d", delete_action: "I", id }])
    expect(result.terminal.graphicsPlacements()).toEqual([])
  },
)

test("clipping and resize preserve source marks and send geometry-only updates with stable p=1", async () => {
  const result = await setup()
  const parent = new BoxRenderable(result.renderer, { width: 2, height: 1, overflow: "hidden" })
  const node = new TerminalImageRenderable(result.renderer, {
    image: await fixture(),
    width: 3,
    height: 2,
    position: "absolute",
    left: -1,
    top: -1,
    protocol: "kitty",
  })
  parent.add(node)
  result.renderer.root.add(parent)
  await result.renderOnce()
  const id = await expectUpload(result, node.image!)
  expectPlacement(result.terminal, id, 3, 2)
  expect(result.terminal.cell(0, 0)).toMatchObject({ combining: ["\u030d", "\u030d"], fg: { rgb: id } })
  expect(result.terminal.cell(1, 0)).toMatchObject({ combining: ["\u030d", "\u030e"], fg: { rgb: id } })
  expect(result.terminal.cell(2, 0)?.ch).not.toBe("\u{10eeee}")
  expect(result.terminal.cell(0, 1)?.ch).not.toBe("\u{10eeee}")
  result.events.length = 0
  node.width = 4
  await result.renderOnce()
  expect(result.events.map((event) => event.action)).toEqual(["p"])
  expect(result.events[0]).toMatchObject({ id, placement_id: 1, unicode_placement: true })
  // 0.2.0 appends duplicate named placements; the isolated failing test below
  // records why this API cannot prove replacement semantics after a resize.
  expect(result.terminal.graphicsPlacements().at(-1)).toMatchObject({
    imageId: id,
    placementId: 1,
    numCols: 4,
    numRows: 2,
  })
  const placements = result.terminal.graphicsPlacements()
  result.events.length = 0
  result.terminal.resize(14, 8)
  result.resize(14, 8)
  await result.renderOnce()
  expect(result.events).toEqual([])
  expect(result.terminal.graphicsPlacements()).toEqual(placements)
  const overlay = new BoxRenderable(result.renderer, {
    width: 1,
    height: 1,
    position: "absolute",
    left: 1,
    top: 0,
    zIndex: 10,
    backgroundColor: "#ffffff",
  })
  result.renderer.root.add(overlay)
  await result.renderOnce()
  expect(result.terminal.cell(0, 0)?.ch).toBe("\u{10eeee}")
  expect(result.terminal.cell(1, 0)?.ch).not.toBe("\u{10eeee}")
  expect(result.terminal.graphicsPlacements()).toEqual(placements)
})

test("hide and destroy delete only the owner's image; reset and pre-suspend cleanup permit reupload", async () => {
  const result = await setup()
  const image = await fixture()
  const first = new TerminalImageRenderable(result.renderer, { image, width: 1, height: 1, protocol: "kitty" })
  const second = new TerminalImageRenderable(result.renderer, { image, width: 1, height: 1, protocol: "kitty" })
  result.renderer.root.add(first)
  result.renderer.root.add(second)
  await result.renderOnce()
  const ids = result.events.filter((event) => event.action === "t").map((event) => event.id)
  expect(ids).toHaveLength(2)
  expect(new Set(ids).size).toBe(2)
  first.visible = false
  result.events.length = 0
  await result.renderOnce()
  expect(result.events).toMatchObject([{ action: "d", delete_action: "I", id: ids[0] }])
  expectPlacement(result.terminal, ids[1]!, 1, 1)
  expect(result.terminal.cell(0, 0)?.fg).toEqual({ rgb: ids[1]! })
  first.visible = true
  result.events.length = 0
  await result.renderOnce()
  expect(await expectUpload(result, image)).toBe(ids[0]!)
  result.events.length = 0
  first.destroy()
  await result.renderOnce()
  expect(result.events).toMatchObject([{ action: "d", delete_action: "I", id: ids[0] }])
  expectPlacement(result.terminal, ids[1]!, 1, 1)
  // This is the application's pre-suspend hook, while output is still open.
  result.events.length = 0
  resetTerminalImages(result.renderer)
  result.renderer.suspend()
  await Bun.sleep(0)
  expect(result.events).toMatchObject([{ action: "d", delete_action: "I", id: ids[1] }])
  expect(result.terminal.graphicsPlacements()).toEqual([])
  result.renderer.resume()
  result.events.length = 0
  await result.renderOnce()
  expect(await expectUpload(result, image)).toBe(ids[1]!)
  expectPlacement(result.terminal, ids[1]!, 1, 1)
  disposeTerminalImages(result.renderer)
  await Bun.sleep(0)
  expect(result.terminal.graphicsPlacements()).toEqual([])
})

test.failing("kitty-vt-wasm 0.2.0 limitation: replacing p=1 must not append another placement", () => {
  using terminal = KittyTerminal.createSync({ wasm, onEvent() {} })
  terminal.write("\x1b_Ga=p,U=1,i=123,p=1,c=2,r=2,q=2\x1b\\")
  terminal.write("\x1b_Ga=p,U=1,i=123,p=1,c=3,r=2,q=2\x1b\\")
  expectPlacement(terminal, 123, 3, 2)
})
