import { type BoxRenderable, type CliRenderer } from "@opentui/core"
import { extend, useRenderer } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { decodeImage, inspectImage, type ImagePreview } from "./image-data"
import { isTerminalImageVisible, selectTerminalImageProtocol, TerminalImageRenderable } from "./terminal-image"

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    attachment_image: typeof TerminalImageRenderable
  }
}

extend({ attachment_image: TerminalImageRenderable })

// Slots include pending decodes; each decoded result is capped at 8 MiB by image-data.
const owners = new WeakMap<CliRenderer, Map<symbol, number>>()

export function imagePreviewStats(renderer: CliRenderer) {
  const active = owners.get(renderer)
  return {
    owners: active?.size ?? 0,
    bytes: active ? Array.from(active.values()).reduce((sum, size) => sum + size, 0) : 0,
  }
}

export function ImageAttachment(props: {
  url: string
  mime: string
  filename?: string
  maxRows?: number
  maxColumns?: number
}) {
  const renderer = useRenderer()
  const { theme } = useTheme()
  const active = owners.get(renderer) ?? new Map<symbol, number>()
  owners.set(renderer, active)
  const owner = Symbol()
  const [width, setWidth] = createSignal(0)
  const [height, setHeight] = createSignal(renderer.height)
  const [cellRatio, setCellRatio] = createSignal(2)
  const [preview, setPreview] = createSignal<ImagePreview>()
  const [error, setError] = createSignal<string>()
  let container: BoxRenderable | undefined
  let area: BoxRenderable | undefined
  let generation = 0
  let pending: AbortController | undefined
  let disposed = false
  let redrawQueued = false
  const redraw = () => {
    if (redrawQueued || renderer.isDestroyed) return
    redrawQueued = true
    // OpenTUI clears updateScheduled after awaiting its frame loop, later than decode microtasks.
    setImmediate(() => {
      redrawQueued = false
      if (!renderer.isDestroyed) renderer.requestRender()
    })
  }
  const metadata = createMemo(() => {
    try {
      return { size: inspectImage(props.url, props.mime), error: undefined }
    } catch (error) {
      return { size: undefined, error: error instanceof Error ? error.message : "Image preview unavailable" }
    }
  })
  const release = () => {
    generation++
    pending?.abort()
    pending = undefined
    setPreview(undefined)
    // Keep the one queued redraw after disposal so earlier owners can acquire this slot.
    if (active.delete(owner)) redraw()
  }
  createEffect(() => {
    metadata()
    release()
    setError(undefined)
  })
  // Renderable.width clamps zero to one, and a 1 -> 0 layout change emits no size event.
  const measure = () => setWidth(container?.getLayoutNode().getComputedWidth() ?? 0)
  const size = createMemo(() => {
    const source = metadata().size
    if (!source) return { width: 0, height: 0 }
    const columns = Math.max(0, Math.floor(Math.min(width(), props.maxColumns ?? 80, 80)))
    const rows = Math.max(0, Math.floor(Math.min(props.maxRows ?? 20, 20, height() * 0.6)))
    const ratio = (source.width / source.height) * cellRatio()
    const fitted = Math.min(columns, rows * ratio)
    return { width: Math.floor(fitted), height: Math.min(rows, Math.max(1, Math.round(fitted / ratio))) }
  })
  const update = () => {
    if (disposed) return
    measure()
    setHeight(renderer.height)
    // Recheck pixel reports every frame: they can arrive without a terminal resize event.
    const pixels = renderer.resolution
    setCellRatio(
      pixels && pixels.width > 0 && pixels.height > 0 && renderer.terminalWidth > 0 && renderer.terminalHeight > 0
        ? pixels.height / renderer.terminalHeight / (pixels.width / renderer.terminalWidth)
        : 2,
    )
    const eligible =
      selectTerminalImageProtocol("auto", renderer.capabilities) !== "off" &&
      metadata().size &&
      size().width > 0 &&
      size().height > 0 &&
      area &&
      area.getLayoutNode().getComputedWidth() === size().width &&
      area.getLayoutNode().getComputedHeight() === size().height &&
      isTerminalImageVisible(area, renderer)
    if (!eligible) {
      release()
      return
    }
    if (active.has(owner) || error() || active.size >= 8) return
    active.set(owner, 0)
    const token = ++generation
    const abort = new AbortController()
    pending = abort
    void decodeImage(props.url, props.mime, 1000, 1000, abort.signal).then(
      (value) => {
        if (disposed || token !== generation) return
        pending = undefined
        active.set(owner, value.image.rgba.byteLength + value.image.png.byteLength)
        setPreview(value)
        redraw()
      },
      (reason: unknown) => {
        if (disposed || token !== generation) return
        release()
        setError(reason instanceof Error ? reason.message : "Image preview unavailable")
        redraw()
      },
    )
  }
  renderer.addPostProcessFn(update)
  onCleanup(() => {
    disposed = true
    renderer.removePostProcessFn(update)
    release()
  })
  const label = () => (props.filename || "Image attachment").replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
  return (
    <box
      width="100%"
      flexShrink={0}
      overflow="hidden"
      ref={(value) => {
        container = value
        measure()
      }}
      onSizeChange={measure}
    >
      <Show when={metadata().size && size().width > 0 && size().height > 0}>
        <box
          ref={(value) => {
            area = value
          }}
          width={size().width}
          height={size().height}
          flexShrink={0}
        >
          <Show when={preview()}>
            {(value) => (
              <attachment_image
                image={value().image}
                width={size().width}
                height={size().height}
                background={theme.backgroundPanel}
              />
            )}
          </Show>
        </box>
      </Show>
      <text fg={theme.textMuted}>
        {label()}
        {metadata().size ? ` (${metadata().size!.width}x${metadata().size!.height})` : ""}
        {metadata().error || error() ? `: ${metadata().error || error()}` : ""}
      </text>
    </box>
  )
}
