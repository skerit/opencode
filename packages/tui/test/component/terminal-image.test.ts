import { afterEach, describe, expect, test } from "bun:test"
import { Writable } from "node:stream"
import {
  BoxRenderable,
  OptimizedBuffer,
  RGBA,
  ScrollBoxRenderable,
  resolveRenderLib,
  type CliRenderer,
} from "@opentui/core"
import { createTerminalCapabilities, createTestRenderer, setRendererCapabilities } from "@opentui/core/testing"
import {
  TerminalImageRenderable,
  disposeTerminalImages,
  isTerminalImageVisible,
  resetTerminalImages,
  selectTerminalImageProtocol,
  type TerminalImage,
} from "../../src/component/terminal-image"

const renderers: CliRenderer[] = []
afterEach(() => {
  for (const renderer of renderers.splice(0)) {
    disposeTerminalImages(renderer)
    renderer.destroy()
  }
})

const image: TerminalImage = {
  width: 1,
  height: 2,
  rgba: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]),
  png: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
    "base64",
  ),
}

async function setup(width = 12, height = 6) {
  const output: string[] = []
  const stdout = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      output.push(chunk.toString())
      callback()
    },
  })
  const result = await createTestRenderer({
    width,
    height,
    stdout: stdout as NodeJS.WriteStream,
    bufferedOutput: "stdout",
    useThread: false,
  })
  renderers.push(result.renderer)
  return { ...result, output }
}

function graphics(output: string[]) {
  return [...output.join("").matchAll(/\x1b_G([^\x1b]*)\x1b\\/g)].map((match) => match[1]!)
}

function uploadedIDs(output: string[]) {
  return [...output.join("").matchAll(/a=t,f=100,t=d,i=(\d+)/g)].map((match) => {
    const id = Number(match[1])
    expect(id).toBeGreaterThan(0)
    expect(id).toBeLessThanOrEqual(0xffffff)
    return id
  })
}

describe("terminal image protocol", () => {
  test("sketerm recognition handles SSH environment identity without assuming multiplexer passthrough", () => {
    const capabilities = createTerminalCapabilities({ rgb: true, kitty_graphics: false })
    const env = { TERM: "xterm-256color", TERM_PROGRAM: "sketerm", COLORTERM: "truecolor" }
    expect(selectTerminalImageProtocol("auto", capabilities, env)).toBe("kitty")
    expect(selectTerminalImageProtocol("auto", { ...capabilities, rgb: false }, env)).toBe("blocks")
    expect(selectTerminalImageProtocol("auto", capabilities, { ...env, TMUX: "socket" })).toBe("blocks")
    for (const multiplexer of ["tmux", "screen", "zellij"] as const) {
      expect(selectTerminalImageProtocol("auto", { ...capabilities, multiplexer }, env)).toBe("blocks")
    }
    expect(selectTerminalImageProtocol("auto", capabilities, { ...env, STY: "screen" })).toBe("blocks")
    expect(selectTerminalImageProtocol("auto", capabilities, { ...env, ZELLIJ: "1" })).toBe("blocks")
    expect(selectTerminalImageProtocol("auto", capabilities, { ...env, OPENCODE_IMAGE_PROTOCOL: "blocks" })).toBe(
      "blocks",
    )
    expect(selectTerminalImageProtocol("auto", capabilities, { ...env, OPENCODE_IMAGE_PROTOCOL: "off" })).toBe("off")
    expect(
      selectTerminalImageProtocol(
        "auto",
        {
          ...capabilities,
          terminal: { name: "xterm", version: "", from_xtversion: true },
        },
        env,
      ),
    ).toBe("blocks")
    expect(
      selectTerminalImageProtocol(
        "auto",
        {
          ...capabilities,
          kitty_graphics: true,
          multiplexer: "tmux",
          terminal: { name: "sketerm", version: "0.2.0", from_xtversion: true },
        },
        {},
      ),
    ).toBe("kitty")
  })

  test("real OpenTUI sketerm identification selects Kitty without a graphics flag", async () => {
    const result = await setup()
    const lib = resolveRenderLib()
    lib.processCapabilityResponse(result.renderer.rendererPtr, "\x1bP>|sketerm 0.2.0\x1b\\")
    const capabilities = { ...lib.getTerminalCapabilities(result.renderer.rendererPtr), rgb: true }
    expect(capabilities.terminal.name).toBe("sketerm")
    expect(selectTerminalImageProtocol("auto", capabilities, {})).toBe("kitty")
    setRendererCapabilities(result.renderer, capabilities)
    result.renderer.root.add(new TerminalImageRenderable(result.renderer, { image, width: 2, height: 2 }))
    await result.renderOnce()
    expect(uploadedIDs(result.output)).toHaveLength(1)
    expect(graphics(result.output).some((command) => command.startsWith("a=p,U=1,"))).toBe(true)
    expect(result.captureCharFrame()).toContain("\u{10eeee}")
    expect(result.captureCharFrame()).not.toContain("\u2580")
  })

  test("auto requires RGB, graphics capability, and a known placeholder terminal", () => {
    for (const name of ["kitty", "Ghostty", "otty", "rio"]) {
      const capabilities = createTerminalCapabilities({ kitty_graphics: true, rgb: true, terminal: { name } })
      expect(selectTerminalImageProtocol("auto", capabilities, {})).toBe("kitty")
      expect(selectTerminalImageProtocol("auto", { ...capabilities, rgb: false }, {})).toBe("blocks")
      expect(selectTerminalImageProtocol("auto", { ...capabilities, kitty_graphics: false }, {})).toBe("blocks")
      expect(selectTerminalImageProtocol("auto", capabilities, { STY: "screen" })).toBe("blocks")
      expect(selectTerminalImageProtocol("auto", capabilities, { ZELLIJ: "1" })).toBe("blocks")
      expect(selectTerminalImageProtocol("auto", { ...capabilities, multiplexer: "screen" }, {})).toBe("blocks")
      expect(selectTerminalImageProtocol("auto", { ...capabilities, multiplexer: "zellij" }, {})).toBe("blocks")
    }
    expect(
      selectTerminalImageProtocol(
        "auto",
        createTerminalCapabilities({ kitty_graphics: true, rgb: true, terminal: { name: "wezterm" } }),
        {},
      ),
    ).toBe("blocks")
    expect(selectTerminalImageProtocol("auto", null, {})).toBe("blocks")
    expect(selectTerminalImageProtocol("auto", null, { OPENCODE_IMAGE_PROTOCOL: "kitty" })).toBe("kitty")
    expect(selectTerminalImageProtocol("auto", null, { OPENCODE_IMAGE_PROTOCOL: "off" })).toBe("off")
    expect(selectTerminalImageProtocol("auto", null, { OPENCODE_IMAGE_PROTOCOL: "blocks" })).toBe("blocks")
    expect(selectTerminalImageProtocol("blocks", null, { OPENCODE_IMAGE_PROTOCOL: "kitty" })).toBe("blocks")
  })
})

test("blocks use native half-block glyphs, full colors, and alpha compositing", async () => {
  const result = await setup()
  const node = new TerminalImageRenderable(result.renderer, { image, width: 1, height: 1, protocol: "blocks" })
  result.renderer.root.add(node)
  await result.renderOnce()
  const span = result.captureSpans().lines[0]!.spans[0]!
  expect(span.text).toBe("\u2580")
  expect(span.fg.toInts()).toEqual([255, 0, 0, 255])
  expect(span.bg.toInts()).toEqual([0, 0, 255, 255])
  node.background = RGBA.fromInts(0, 255, 0)
  node.image = { ...image, rgba: new Uint8Array([255, 0, 0, 128, 0, 0, 255, 0]) }
  await result.renderOnce()
  const composited = result.captureSpans().lines[0]!.spans[0]!
  expect(composited.fg.toInts()).toEqual([128, 127, 0, 255])
  expect(composited.bg.toInts()).toEqual([0, 255, 0, 255])
  expect(graphics(result.output)).toEqual([])
  node.protocol = "off"
  await result.renderOnce()
  expect(result.captureCharFrame()).not.toContain("\u2580")
})

test("Kitty uploads before native placeholders, reuses IDs, and only updates placement on size changes", async () => {
  const result = await setup()
  const node = new TerminalImageRenderable(result.renderer, { image, width: 2, height: 2, protocol: "kitty" })
  result.renderer.root.add(node)
  await result.renderOnce()
  const id = uploadedIDs(result.output)[0]!
  expect(graphics(result.output)).toEqual([
    `a=t,f=100,t=d,i=${id},q=2,m=0;${Buffer.from(image.png).toString("base64")}`,
    `a=p,U=1,i=${id},p=1,c=2,r=2,q=2`,
  ])
  expect(result.output.join("").indexOf("a=t")).toBeLessThan(result.output.join("").indexOf("\u{10eeee}"))
  expect(result.captureCharFrame()).toContain("\u{10eeee}\u0305\u0305\u{10eeee}\u0305\u030d")
  expect(result.captureSpans().lines[0]!.spans[0]!.fg.toInts()).toEqual([
    (id >> 16) & 255,
    (id >> 8) & 255,
    id & 255,
    255,
  ])
  result.output.length = 0
  await result.renderOnce()
  expect(graphics(result.output)).toEqual([])
  node.width = 3
  await result.renderOnce()
  expect(graphics(result.output)).toEqual([`a=p,U=1,i=${id},p=1,c=3,r=2,q=2`])
  result.output.length = 0
  resetTerminalImages(result.renderer)
  await result.renderOnce()
  expect(graphics(result.output)[0]).toBe(`a=d,d=I,i=${id},q=2`)
  expect(uploadedIDs(result.output)).toEqual([id])
  expect(graphics(result.output).filter((command) => command.startsWith("a=t"))).toHaveLength(1)
  expect(graphics(result.output).at(-1)).toBe(`a=p,U=1,i=${id},p=1,c=3,r=2,q=2`)
  result.output.length = 0
  node.destroy()
  await result.renderOnce()
  expect(graphics(result.output)).toEqual([`a=d,d=I,i=${id},q=2`])
})

test("clipping preserves original row/column marks and opaque UI covers image cells", async () => {
  const result = await setup()
  const parent = new BoxRenderable(result.renderer, { width: 2, height: 1, overflow: "hidden" })
  const node = new TerminalImageRenderable(result.renderer, {
    image,
    width: 3,
    height: 2,
    left: -1,
    top: -1,
    position: "absolute",
    protocol: "kitty",
  })
  parent.add(node)
  result.renderer.root.add(parent)
  await result.renderOnce()
  expect(result.captureCharFrame().split("\n")[0]).toStartWith("\u{10eeee}\u030d\u030d\u{10eeee}\u030d\u030e")
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
  expect(result.captureCharFrame().split("\n")[0]).toStartWith("\u{10eeee}\u030d\u030d ")
  expect(result.captureCharFrame()).not.toContain("\u030d\u030e")
})

test("upload budget is eight per renderer and released slots admit block fallbacks", async () => {
  const result = await setup(12, 12)
  const nodes = Array.from(
    { length: 9 },
    () =>
      new TerminalImageRenderable(result.renderer, {
        image,
        width: 1,
        height: 1,
        protocol: "kitty",
      }),
  )
  nodes.forEach((node) => result.renderer.root.add(node))
  await result.renderOnce()
  const ids = uploadedIDs(result.output)
  expect(new Set(ids).size).toBe(8)
  expect(graphics(result.output).filter((command) => command.startsWith("a=t"))).toHaveLength(8)
  expect(result.captureCharFrame()).toContain("\u2580")
  result.output.length = 0
  result.renderer.root.remove(nodes[0]!)
  await result.renderOnce()
  expect(graphics(result.output).filter((command) => command.startsWith("a=t"))).toHaveLength(1)
  expect(graphics(result.output)).toContain(`a=d,d=I,i=${ids[0]},q=2`)
  expect(ids).not.toContain(uploadedIDs(result.output)[0]!)
  expect(result.captureCharFrame()).not.toContain("\u2580")
  nodes[0]!.destroy()
  const second = await setup()
  second.renderer.root.add(
    new TerminalImageRenderable(second.renderer, { image, width: 1, height: 1, protocol: "kitty" }),
  )
  await second.renderOnce()
  expect(ids).not.toContain(uploadedIDs(second.output)[0]!)
})

test("every APC, including continuation chunks and deletion, is tmux wrapped", async () => {
  const result = await setup()
  setRendererCapabilities(result.renderer, { multiplexer: "tmux" })
  result.renderer.root.add(
    new TerminalImageRenderable(result.renderer, {
      image: { ...image, png: new Uint8Array(7000).fill(42) },
      width: 1,
      height: 1,
      protocol: "kitty",
    }),
  )
  await result.renderOnce()
  const id = uploadedIDs(result.output)[0]!
  resetTerminalImages(result.renderer)
  await result.flush()
  const wrappers = [...result.output.join("").matchAll(/\x1bPtmux;([\s\S]*?)\x1b\\/g)]
  expect(wrappers.length).toBeGreaterThanOrEqual(5)
  const commands = wrappers.map((match) => match[1]!.replaceAll("\x1b\x1b", "\x1b") + "\\")
  expect(commands.every((command) => command.startsWith("\x1b_G"))).toBe(true)
  const chunks = commands.filter((command) => command.includes(";"))
  expect(chunks.slice(0, 3).map((command) => command.split(";")[1]!.slice(0, -2).length)).toEqual([4096, 4096, 1144])
  expect(commands[1]).toContain("m=1;")
  expect(commands[2]).toContain("m=0;")
  expect(commands.some((command) => command.includes(`a=d,d=I,i=${id},`))).toBe(true)
})

test("reset cancels queued uploads; dispose removes listeners; destroy never writes deletion", async () => {
  const result = await setup()
  const events = ["destroy", "resize", "capabilities", "focus"]
  const baseline = events.map((event) => result.renderer.listenerCount(event))
  const node = new TerminalImageRenderable(result.renderer, { image, width: 1, height: 1, protocol: "kitty" })
  result.renderer.root.add(node)
  const buffer = OptimizedBuffer.create(12, 6, "unicode")
  try {
    result.renderer.root.render(buffer, 0)
    resetTerminalImages(result.renderer)
    node.image = undefined
    await result.renderOnce()
    expect(graphics(result.output)).toEqual([])
    expect(events.map((event) => result.renderer.listenerCount(event))).toEqual(baseline.map((count) => count + 1))
    disposeTerminalImages(result.renderer)
    expect(events.map((event) => result.renderer.listenerCount(event))).toEqual(baseline)
    node.image = image
    await result.renderOnce()
    result.output.length = 0
    result.renderer.destroy()
    expect(graphics(result.output)).toEqual([])
    expect(events.map((event) => result.renderer.listenerCount(event))).toEqual([0, 0, 0, 0])
  } finally {
    buffer.destroy()
  }
})

test("the full 80x24 grid uses exact diacritics and larger grids fall back", async () => {
  const result = await setup(82, 26)
  const node = new TerminalImageRenderable(result.renderer, { image, width: 80, height: 24, protocol: "kitty" })
  result.renderer.root.add(node)
  await result.renderOnce()
  const id = uploadedIDs(result.output)[0]!
  expect(result.captureCharFrame().split("\n")[23]).toContain("\u{10eeee}\u0369\u06e2")
  expect(result.captureCharFrame()).not.toContain("undefined")
  result.output.length = 0
  node.width = 81
  await result.renderOnce()
  expect(result.captureCharFrame()).not.toContain("\u{10eeee}")
  expect(result.captureCharFrame()).toContain("\u2580")
  expect(graphics(result.output)).toEqual([`a=d,d=I,i=${id},q=2`])
  node.width = 80
  node.height = 25
  await result.renderOnce()
  expect(result.captureCharFrame()).not.toContain("\u{10eeee}")
})

test("focus and capabilities invalidate uploads; resize retains uploads; replacement retains ID", async () => {
  const result = await setup()
  const node = new TerminalImageRenderable(result.renderer, { image, width: 1, height: 1, protocol: "kitty" })
  result.renderer.root.add(node)
  await result.renderOnce()
  const id = uploadedIDs(result.output)[0]!
  for (const event of ["focus", "capabilities"]) {
    result.output.length = 0
    result.renderer.emit(event)
    await result.renderOnce()
    expect(graphics(result.output)[0]).toBe(`a=d,d=I,i=${id},q=2`)
    expect(uploadedIDs(result.output)).toEqual([id])
    expect(graphics(result.output).filter((command) => command.startsWith("a=t"))).toHaveLength(1)
  }
  result.output.length = 0
  result.resize(14, 8)
  await result.renderOnce()
  expect(graphics(result.output)).toEqual([])
  node.image = { ...image }
  await result.renderOnce()
  expect(graphics(result.output)[0]).toBe(`a=d,d=I,i=${id},q=2`)
  expect(graphics(result.output).at(-1)).toBe(`a=p,U=1,i=${id},p=1,c=1,r=1,q=2`)
  result.output.length = 0
  disposeTerminalImages(result.renderer)
  await result.flush()
  expect(graphics(result.output)[0]).toBe(`a=d,d=I,i=${id},q=2`)
})

test("off releases its own image and translucent parents use composited blocks instead of corrupted IDs", async () => {
  const result = await setup()
  const parent = new BoxRenderable(result.renderer, { width: 2, height: 2 })
  const node = new TerminalImageRenderable(result.renderer, { image, width: 1, height: 1, protocol: "kitty" })
  parent.add(node)
  result.renderer.root.add(parent)
  await result.renderOnce()
  const id = uploadedIDs(result.output)[0]!
  result.output.length = 0
  node.protocol = "off"
  await result.renderOnce()
  expect(graphics(result.output)).toEqual([`a=d,d=I,i=${id},q=2`])
  expect(result.captureCharFrame()).not.toContain("\u{10eeee}")
  expect(result.captureCharFrame()).not.toContain("\u2580")
  result.output.length = 0
  node.protocol = "kitty"
  parent.opacity = 0.5
  await result.renderOnce()
  expect(result.captureCharFrame()).toContain("\u2580")
  expect(result.captureCharFrame()).not.toContain("\u{10eeee}")
  expect(graphics(result.output)).toEqual([])
})

test.each(["hidden parent", "hidden owners", "transparent parent", "offscreen parent"])(
  "%s frees resident slots and schedules the ninth image without removing owners",
  async (mode) => {
    const result = await setup(12, 12)
    const parent = new BoxRenderable(result.renderer, { width: 8, height: 2, flexDirection: "row" })
    const nodes = Array.from(
      { length: 8 },
      () =>
        new TerminalImageRenderable(result.renderer, {
          image,
          width: 1,
          height: 2,
          protocol: "kitty",
          flexShrink: 0,
        }),
    )
    nodes.forEach((node) => parent.add(node))
    result.renderer.root.add(parent)
    const ninth = new TerminalImageRenderable(result.renderer, { image, width: 1, height: 1, protocol: "kitty" })
    result.renderer.root.add(ninth)
    await result.renderOnce()
    const ids = uploadedIDs(result.output)
    expect(ids).toHaveLength(8)
    expect(result.captureCharFrame()).toContain("\u2580")
    result.output.length = 0
    if (mode === "hidden parent") parent.visible = false
    if (mode === "hidden owners")
      nodes.forEach((node) => {
        node.visible = false
      })
    if (mode === "transparent parent") parent.opacity = 0
    if (mode === "offscreen parent") parent.translateX = result.renderer.width
    await result.renderOnce()
    await result.flush()
    expect(nodes.every((node) => node.parent === parent && !node.isDestroyed)).toBe(true)
    expect(nodes.every((node) => !isTerminalImageVisible(node, result.renderer))).toBe(true)
    expect(graphics(result.output).filter((command) => command.startsWith("a=d"))).toEqual(
      ids.map((id) => `a=d,d=I,i=${id},q=2`),
    )
    const replacements = uploadedIDs(result.output)
    expect(replacements).toHaveLength(1)
    expect(ids).not.toContain(replacements[0]!)
    expect(result.captureCharFrame()).not.toContain("\u2580")
    expect(result.captureCharFrame()).toContain("\u{10eeee}")
    result.output.length = 0
    await result.renderOnce()
    expect(graphics(result.output)).toEqual([])
  },
)

test("scroll viewport keeps partially clipped residents, evicts fully clipped ones, and preserves returning IDs", async () => {
  const result = await setup(12, 12)
  const scroll = new ScrollBoxRenderable(result.renderer, { width: 10, height: 2, scrollY: true })
  const row = new BoxRenderable(result.renderer, { width: 8, height: 2, flexDirection: "row", flexShrink: 0 })
  const nodes = Array.from(
    { length: 8 },
    () =>
      new TerminalImageRenderable(result.renderer, {
        image,
        width: 1,
        height: 2,
        protocol: "kitty",
        flexShrink: 0,
      }),
  )
  nodes.forEach((node) => row.add(node))
  scroll.add(row)
  scroll.add(new BoxRenderable(result.renderer, { width: 8, height: 2, flexShrink: 0 }))
  result.renderer.root.add(scroll)
  result.renderer.root.add(
    new TerminalImageRenderable(result.renderer, { image, width: 1, height: 1, protocol: "kitty" }),
  )
  await result.renderOnce()
  const ids = uploadedIDs(result.output)
  expect(ids).toHaveLength(8)
  result.output.length = 0
  scroll.scrollTop = 1
  await result.renderOnce()
  expect(nodes.every((node) => isTerminalImageVisible(node, result.renderer))).toBe(true)
  expect(graphics(result.output)).toEqual([])
  expect(result.captureCharFrame()).toContain("\u2580")
  scroll.scrollTop = 2
  await result.renderOnce()
  await result.flush()
  expect(nodes.every((node) => !isTerminalImageVisible(node, result.renderer))).toBe(true)
  expect(graphics(result.output).filter((command) => command.startsWith("a=d"))).toEqual(
    ids.map((id) => `a=d,d=I,i=${id},q=2`),
  )
  expect(uploadedIDs(result.output)).toHaveLength(1)
  expect(result.captureCharFrame()).not.toContain("\u2580")
  result.output.length = 0
  scroll.scrollTop = 0
  await result.renderOnce()
  expect(uploadedIDs(result.output)).toEqual(ids.slice(0, 7))
  expect(graphics(result.output).filter((command) => command.startsWith("a=d"))).toEqual([])
  expect(result.captureCharFrame()).toContain("\u2580")
  result.output.length = 0
  await result.renderOnce()
  expect(graphics(result.output)).toEqual([])
})

test("visibility uses computed sizes, intersected ancestor clips, screen translations, and opacity", async () => {
  const result = await setup()
  const parent = new BoxRenderable(result.renderer, {
    width: 3,
    height: 3,
    position: "absolute",
    left: 2,
    top: 1,
    overflow: "hidden",
  })
  const child = new BoxRenderable(result.renderer, {
    width: 2,
    height: 2,
    position: "absolute",
    left: -1,
    top: -1,
  })
  parent.add(child)
  result.renderer.root.add(parent)
  await result.renderOnce()
  expect(isTerminalImageVisible(child, result.renderer)).toBe(true)
  child.translateX = -1
  expect(isTerminalImageVisible(child, result.renderer)).toBe(false)
  child.translateX = 0
  child.translateY = -1
  expect(isTerminalImageVisible(child, result.renderer)).toBe(false)
  child.translateY = 0
  parent.opacity = 0.5
  expect(isTerminalImageVisible(child, result.renderer)).toBe(true)
  parent.opacity = 0
  expect(isTerminalImageVisible(child, result.renderer)).toBe(false)
  parent.opacity = 1
  parent.translateX = result.renderer.width
  expect(isTerminalImageVisible(child, result.renderer)).toBe(false)
  parent.translateX = 0
  child.left = 0
  child.top = 0
  child.width = 0
  await result.renderOnce()
  expect(child.width).toBe(1)
  expect(isTerminalImageVisible(child, result.renderer)).toBe(false)
  child.width = 2
  child.height = 0
  await result.renderOnce()
  expect(child.height).toBe(1)
  expect(isTerminalImageVisible(child, result.renderer)).toBe(false)
  child.height = 2
  parent.width = 0
  await result.renderOnce()
  expect(parent.width).toBe(1)
  expect(isTerminalImageVisible(child, result.renderer)).toBe(false)
  parent.width = 3
  await result.renderOnce()
  expect(isTerminalImageVisible(child, result.renderer)).toBe(true)
  parent.remove(child)
  expect(isTerminalImageVisible(child, result.renderer)).toBe(false)
  child.destroy()
  expect(isTerminalImageVisible(child, result.renderer)).toBe(false)
})

test("postprocess cancels pending uploads when an ancestor becomes hidden after image rendering", async () => {
  const result = await setup()
  const parent = new BoxRenderable(result.renderer, { width: 2, height: 2 })
  const node = new TerminalImageRenderable(result.renderer, {
    image,
    width: 1,
    height: 1,
    protocol: "kitty",
    renderAfter() {
      parent.visible = false
    },
  })
  parent.add(node)
  result.renderer.root.add(parent)
  await result.renderOnce()
  await result.flush()
  expect(graphics(result.output)).toEqual([])
  expect(result.captureCharFrame()).not.toContain("\u{10eeee}")
  node.renderAfter = undefined
  parent.visible = true
  await result.renderOnce()
  expect(uploadedIDs(result.output)).toHaveLength(1)
})
