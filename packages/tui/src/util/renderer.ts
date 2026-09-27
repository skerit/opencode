import { CliRenderer } from "@opentui/core"
import { disposeTerminalImages, resetTerminalImages } from "../images-lifecycle"

export function suspendRenderer(renderer: CliRenderer) {
  resetTerminalImages(renderer)
  renderer.suspend()
}

export function resumeRenderer(renderer: Pick<CliRenderer, "resume" | "requestRender">) {
  renderer.resume()
  renderer.requestRender()
}

export function destroyRenderer(renderer: Pick<CliRenderer, "isDestroyed" | "setTerminalTitle" | "destroy">) {
  renderer.setTerminalTitle("")
  if (renderer.isDestroyed) return
  if (renderer instanceof CliRenderer) disposeTerminalImages(renderer)
  renderer.destroy()
}
