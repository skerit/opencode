import { expect, spyOn, test } from "bun:test"
import { Writable } from "node:stream"
import { createTestRenderer } from "@opentui/core/testing"
import { TerminalImageRenderable } from "../../src/component/terminal-image"
import { disposeTerminalImages, resetTerminalImages } from "@opencode-ai/tui/images-lifecycle"
import { destroyRenderer, resumeRenderer, suspendRenderer } from "../../src/util/renderer"

async function imageRenderer() {
  const output: string[] = []
  const stdout = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      output.push(chunk.toString())
      callback()
    },
  })
  const result = await createTestRenderer({
    width: 4,
    height: 2,
    stdout: stdout as NodeJS.WriteStream,
    bufferedOutput: "stdout",
    useThread: false,
  })
  result.renderer.root.add(
    new TerminalImageRenderable(result.renderer, {
      width: 1,
      height: 1,
      protocol: "kitty",
      image: {
        width: 1,
        height: 1,
        rgba: new Uint8Array([255, 0, 0, 255]),
        png: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
          "base64",
        ),
      },
    }),
  )
  await result.renderOnce()
  expect(output.join("")).toContain("a=t,f=100")
  const id = Number(output.join("").match(/a=t,f=100,t=d,i=(\d+)/)?.[1])
  expect(id).toBeGreaterThan(0)
  expect(id).toBeLessThanOrEqual(0xffffff)
  output.length = 0
  return { ...result, output, id }
}

test("clears the terminal title before destroying the renderer", () => {
  const calls: string[] = []
  destroyRenderer({
    isDestroyed: false,
    setTerminalTitle(title) {
      calls.push(`title:${title}`)
    },
    destroy() {
      calls.push("destroy")
    },
  })
  expect(calls).toEqual(["title:", "destroy"])
})

test("still clears the title after renderer destruction", () => {
  const calls: string[] = []
  destroyRenderer({
    isDestroyed: true,
    setTerminalTitle(title) {
      calls.push(`title:${title}`)
    },
    destroy() {
      calls.push("destroy")
    },
  })
  expect(calls).toEqual(["title:"])
})

test("suspend deletes images before handing off the terminal and resume retransmits them", async () => {
  const result = await imageRenderer()
  const suspend = result.renderer.suspend.bind(result.renderer)
  const hook = spyOn(result.renderer, "suspend").mockImplementation(() => {
    expect(result.output.join("")).toContain(`a=d,d=I,i=${result.id},q=2`)
    suspend()
  })
  try {
    suspendRenderer(result.renderer)
    expect(hook).toHaveBeenCalledTimes(1)
    result.output.length = 0
    resumeRenderer(result.renderer)
    await result.renderOnce()
    expect(result.output.join("")).toContain(`a=t,f=100,t=d,i=${result.id},`)
  } finally {
    hook.mockRestore()
    destroyRenderer(result.renderer)
  }
})

test("resume requests a frame after resuming", () => {
  const calls: string[] = []
  resumeRenderer({
    resume() {
      calls.push("resume")
    },
    requestRender() {
      calls.push("render")
    },
  })
  expect(calls).toEqual(["resume", "render"])
})

test("destroy disposes images and listeners before closing the native renderer", async () => {
  const result = await imageRenderer()
  const listeners = result.renderer.listenerCount("focus")
  const destroy = result.renderer.destroy.bind(result.renderer)
  const hook = spyOn(result.renderer, "destroy").mockImplementation(() => {
    expect(result.renderer.isDestroyed).toBe(false)
    expect(result.output.join("")).toContain(`a=d,d=I,i=${result.id},q=2`)
    expect(result.renderer.listenerCount("focus")).toBe(listeners - 1)
    destroy()
  })
  try {
    destroyRenderer(result.renderer)
    expect(hook).toHaveBeenCalledTimes(1)
    expect(result.renderer.isDestroyed).toBe(true)
    destroyRenderer(result.renderer)
    expect(hook).toHaveBeenCalledTimes(1)
  } finally {
    hook.mockRestore()
    destroyRenderer(result.renderer)
  }
})

test("public image lifecycle entry uses the renderable's shared manager", async () => {
  const result = await imageRenderer()
  try {
    resetTerminalImages(result.renderer)
    expect(result.output.join("")).toContain(`a=d,d=I,i=${result.id},q=2`)
    await result.renderOnce()
    expect(result.output.join("")).toContain(`a=t,f=100,t=d,i=${result.id},`)
    result.output.length = 0
    disposeTerminalImages(result.renderer)
    expect(result.output.join("")).toContain(`a=d,d=I,i=${result.id},q=2`)
    result.output.length = 0
    disposeTerminalImages(result.renderer)
    expect(result.output).toEqual([])
  } finally {
    destroyRenderer(result.renderer)
  }
})
