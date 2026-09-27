import { randomInt } from "node:crypto"
import {
  CliRenderer,
  Renderable,
  RGBA,
  resolveRenderLib,
  type OptimizedBuffer,
  type RenderContext,
  type RenderableOptions,
  type TerminalCapabilities,
} from "@opentui/core"

export type TerminalImage = { width: number; height: number; rgba: Uint8Array; png: Uint8Array }
type Protocol = "auto" | "kitty" | "blocks" | "off"

// First 80 Kitty row/column marks, from OMP packages/tui/src/kitty-graphics.ts.
// https://github.com/kovidgoyal/kitty/blob/master/gen/rowcolumn-diacritics.txt
// OMP MIT License: Copyright (c) 2025 Mario Zechner; 2025-2026 Can Boluk;
// 2026 Stencil Labs, Inc.
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
const marks = [
  0x305, 0x30d, 0x30e, 0x310, 0x312, 0x33d, 0x33e, 0x33f, 0x346, 0x34a, 0x34b, 0x34c, 0x350, 0x351, 0x352, 0x357, 0x35b,
  0x363, 0x364, 0x365, 0x366, 0x367, 0x368, 0x369, 0x36a, 0x36b, 0x36c, 0x36d, 0x36e, 0x36f, 0x483, 0x484, 0x485, 0x486,
  0x487, 0x592, 0x593, 0x594, 0x595, 0x597, 0x598, 0x599, 0x59c, 0x59d, 0x59e, 0x59f, 0x5a0, 0x5a1, 0x5a8, 0x5a9, 0x5ab,
  0x5ac, 0x5af, 0x5c4, 0x610, 0x611, 0x612, 0x613, 0x614, 0x615, 0x616, 0x617, 0x657, 0x658, 0x659, 0x65a, 0x65b, 0x65d,
  0x65e, 0x6d6, 0x6d7, 0x6d8, 0x6d9, 0x6da, 0x6db, 0x6dc, 0x6df, 0x6e0, 0x6e1, 0x6e2,
].map((code) => String.fromCodePoint(code))

export function selectTerminalImageProtocol(
  protocol: Protocol = "auto",
  capabilities: TerminalCapabilities | null = null,
  env: NodeJS.ProcessEnv = process.env,
): Exclude<Protocol, "auto"> {
  const selected = protocol === "auto" ? env.OPENCODE_IMAGE_PROTOCOL?.trim().toLowerCase() : protocol
  if (selected === "off" || selected === "blocks" || selected === "kitty") return selected
  if (env.STY || env.ZELLIJ || capabilities?.multiplexer === "screen" || capabilities?.multiplexer === "zellij")
    return "blocks"
  if (!capabilities?.rgb) return "blocks"
  const name = capabilities.terminal.from_xtversion
    ? capabilities.terminal.name
    : env.TERM_PROGRAM || capabilities.terminal.name
  // OpenTUI does not recognize sketerm's graphics support yet; it implements
  // virtual placements. Do not infer passthrough support from the outer name.
  if (/^sketerm$/i.test(name) && !env.TMUX && capabilities.multiplexer === "none") return "kitty"
  if (!capabilities.kitty_graphics) return "blocks"
  return /^(kitty|ghostty|otty|rio|sketerm)$/i.test(name) ? "kitty" : "blocks"
}

type Entry = { id: number; uploaded: boolean; width: number; height: number; pending: string }
const managers = new WeakMap<CliRenderer, TerminalImages>()

/** Uses computed layout sizes because Renderable.width/height clamp empty boxes to one cell. */
export function isTerminalImageVisible(owner: Renderable, renderer: CliRenderer): boolean {
  if (renderer.isDestroyed || owner.isDestroyed) return false
  let left = Math.max(0, owner.screenX)
  let top = Math.max(0, owner.screenY)
  let right = Math.min(renderer.width, owner.screenX + owner.getLayoutNode().getComputedWidth())
  let bottom = Math.min(renderer.height, owner.screenY + owner.getLayoutNode().getComputedHeight())
  for (let current: Renderable | null = owner; current; current = current.parent) {
    if (current.isDestroyed || !current.visible || current.opacity <= 0) return false
    if (current !== owner && current.overflow === "hidden") {
      left = Math.max(left, current.screenX)
      top = Math.max(top, current.screenY)
      right = Math.min(right, current.screenX + current.getLayoutNode().getComputedWidth())
      bottom = Math.min(bottom, current.screenY + current.getLayoutNode().getComputedHeight())
    }
    if (!(right > left && bottom > top)) return false
    if (current === renderer.root) return true
  }
  return false
}

class TerminalImages {
  entries = new Map<TerminalImageRenderable, Entry>()
  ids = new WeakMap<TerminalImageRenderable, number>()
  allocated = new Set<number>()
  redrawQueued = false

  constructor(readonly renderer: CliRenderer) {
    renderer.addPostProcessFn(this.flush)
    renderer.on("resize", this.redraw)
    renderer.on("capabilities", this.reset)
    renderer.on("focus", this.reset)
    renderer.on("destroy", this.drop)
  }

  command(parameters: string, payload?: string) {
    const apc = `\x1b_G${parameters}${payload === undefined ? "" : `;${payload}`}\x1b\\`
    return process.env.TMUX || this.renderer.capabilities?.multiplexer === "tmux"
      ? `\x1bPtmux;${apc.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`
      : apc
  }

  write(commands: string) {
    if (commands && !this.renderer.isDestroyed) resolveRenderLib().writeOut(this.renderer.rendererPtr, commands)
  }

  flush = () => {
    for (const owner of this.entries.keys()) {
      if (!isTerminalImageVisible(owner, this.renderer)) this.release(owner)
    }
    for (const entry of this.entries.values()) {
      if (!entry.pending) continue
      this.write(entry.pending)
      entry.pending = ""
      entry.uploaded = true
    }
  }

  redraw = () => this.renderer.requestRender()

  release(owner: TerminalImageRenderable) {
    const entry = this.entries.get(owner)
    if (!entry) return
    if (entry.uploaded) this.write(this.command(`a=d,d=I,i=${entry.id},q=2`))
    this.entries.delete(owner)
    // Render requests inside a render pass can be dropped by OpenTUI.
    if (this.redrawQueued) return
    this.redrawQueued = true
    setImmediate(() => {
      this.redrawQueued = false
      if (!this.renderer.isDestroyed && managers.get(this.renderer) === this) this.redraw()
    })
  }

  forget(owner: TerminalImageRenderable) {
    this.release(owner)
    const id = this.ids.get(owner)
    if (id !== undefined) this.allocated.delete(id)
    this.ids.delete(owner)
  }

  reset = () => {
    for (const owner of this.entries.keys()) this.release(owner)
    this.redraw()
  }

  drop = () => {
    this.entries.clear()
    this.ids = new WeakMap()
    this.allocated.clear()
    this.renderer.removePostProcessFn(this.flush)
    this.renderer.off("resize", this.redraw)
    this.renderer.off("capabilities", this.reset)
    this.renderer.off("focus", this.reset)
    this.renderer.off("destroy", this.drop)
    managers.delete(this.renderer)
  }

  place(owner: TerminalImageRenderable, image: TerminalImage, width: number, height: number) {
    const previous = this.entries.get(owner)
    if (!previous && this.entries.size >= 8) return
    let id = this.ids.get(owner)
    if (id === undefined) {
      if (this.allocated.size === 0xffffff) return
      do {
        id = randomInt(1, 0x1000000)
      } while (this.allocated.has(id))
      this.ids.set(owner, id)
      this.allocated.add(id)
    }
    const entry = previous ?? { id, uploaded: false, width: 0, height: 0, pending: "" }
    if (!previous) {
      const png = Buffer.from(image.png).toString("base64")
      for (let offset = 0; offset < png.length; offset += 4096) {
        entry.pending += this.command(
          `${offset === 0 ? `a=t,f=100,t=d,i=${id},q=2,` : ""}m=${offset + 4096 < png.length ? 1 : 0}`,
          png.slice(offset, offset + 4096),
        )
      }
    }
    if (entry.width !== width || entry.height !== height) {
      // A single named placement can be selected without an underline color.
      entry.pending += this.command(`a=p,U=1,i=${id},p=1,c=${width},r=${height},q=2`)
      entry.width = width
      entry.height = height
    }
    this.entries.set(owner, entry)
    return id
  }
}

/** Call before suspend so the next frame retransmits images after resume. */
export function resetTerminalImages(renderer: CliRenderer) {
  managers.get(renderer)?.reset()
}

/** Call before renderer.destroy(), while the native output handle is still open. */
export function disposeTerminalImages(renderer: CliRenderer) {
  const manager = managers.get(renderer)
  manager?.reset()
  manager?.drop()
}

export class TerminalImageRenderable extends Renderable {
  private _image?: TerminalImage
  private _background: RGBA
  private _protocol: Protocol
  private renderer?: CliRenderer

  constructor(
    ctx: RenderContext,
    options: RenderableOptions<Renderable> & { image?: TerminalImage; background?: RGBA; protocol?: Protocol },
  ) {
    super(ctx, { ...options, buffered: false })
    this._image = options.image
    this._background = options.background ?? RGBA.fromInts(0, 0, 0)
    this._protocol = options.protocol ?? "auto"
    if (ctx instanceof CliRenderer) this.renderer = ctx
  }

  get image() {
    return this._image
  }
  set image(value: TerminalImage | undefined) {
    if (this._image === value) return
    this.release()
    this._image = value
    this.requestRender()
  }

  get background() {
    return this._background
  }
  set background(value: RGBA) {
    this._background = value
    this.requestRender()
  }

  get protocol() {
    return this._protocol
  }
  set protocol(value: Protocol) {
    if (value === this._protocol) return
    this.release()
    this._protocol = value
    this.requestRender()
  }

  private release() {
    if (this.renderer) managers.get(this.renderer)?.release(this)
  }

  protected override onRemove() {
    this.release()
  }
  protected override destroySelf() {
    if (this.renderer) managers.get(this.renderer)?.forget(this)
  }

  protected override renderSelf(buffer: OptimizedBuffer, _delta: number) {
    const image = this._image
    const width = this.width
    const height = this.height
    const protocol = selectTerminalImageProtocol(this._protocol, this._ctx.capabilities)
    if (
      !image ||
      protocol === "off" ||
      width < 1 ||
      height < 1 ||
      image.width < 1 ||
      image.height < 1 ||
      image.rgba.length !== image.width * image.height * 4
    ) {
      this.release()
      return
    }
    const renderer = this.renderer
    if (renderer && !isTerminalImageVisible(this, renderer)) {
      this.release()
      return
    }
    const manager =
      protocol === "kitty" &&
      width <= 80 &&
      height <= 24 &&
      image.png.length > 0 &&
      renderer &&
      !renderer.isDestroyed &&
      buffer.getCurrentOpacity() === 1
        ? (managers.get(renderer) ?? new TerminalImages(renderer))
        : undefined
    if (manager && renderer) managers.set(renderer, manager)
    if (!manager) this.release()
    const id = manager?.place(this, image, width, height)
    const foreground = id ? RGBA.fromInts((id >> 16) & 255, (id >> 8) & 255, id & 255) : undefined
    buffer.pushScissorRect(this.screenX, this.screenY, width, height)
    try {
      for (let row = 0; row < height; row++) {
        for (let column = 0; column < width; column++) {
          if (foreground) {
            buffer.drawText(
              `\u{10eeee}${marks[row]}${marks[column]}`,
              this.screenX + column,
              this.screenY + row,
              foreground,
              this._background,
            )
            continue
          }
          const x = Math.min(image.width - 1, Math.floor(((column + 0.5) * image.width) / width))
          const colors = [0, 1].map((half) => {
            const y = Math.min(image.height - 1, Math.floor(((row * 2 + half + 0.5) * image.height) / (height * 2)))
            const offset = (y * image.width + x) * 4
            const alpha = image.rgba[offset + 3]! / 255
            return RGBA.fromValues(
              (image.rgba[offset]! / 255) * alpha + this._background.r * (1 - alpha),
              (image.rgba[offset + 1]! / 255) * alpha + this._background.g * (1 - alpha),
              (image.rgba[offset + 2]! / 255) * alpha + this._background.b * (1 - alpha),
              1,
            )
          })
          buffer.drawText("\u2580", this.screenX + column, this.screenY + row, colors[0]!, colors[1]!)
        }
      }
    } finally {
      buffer.popScissorRect()
    }
  }
}
