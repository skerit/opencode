import { afterEach, expect, spyOn, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { normalizePromptContent, openEditor } from "../src/editor"
import { destroyRenderer } from "../src/util/renderer"

const editor = process.env.EDITOR
const visual = process.env.VISUAL

afterEach(() => {
  process.env.EDITOR = editor
  process.env.VISUAL = visual
})

test("rejects when the external editor cannot start", async () => {
  delete process.env.VISUAL
  process.env.EDITOR = "opencode-editor-that-does-not-exist"
  const { renderer } = await createTestRenderer({ width: 4, height: 2 })
  const suspend = spyOn(renderer, "suspend")
  const resume = spyOn(renderer, "resume")
  const render = spyOn(renderer, "requestRender")
  try {
    await expect(openEditor({ value: "original", renderer })).rejects.toThrow()
    expect(suspend).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(render).toHaveBeenCalled()
  } finally {
    suspend.mockRestore()
    resume.mockRestore()
    render.mockRestore()
    destroyRenderer(renderer)
  }
})

test.each([0, 1])("restores the renderer after external editor exit code %i", async (code) => {
  delete process.env.VISUAL
  process.env.EDITOR = `${process.execPath} -e process.exit(${code})`
  const { renderer } = await createTestRenderer({ width: 4, height: 2 })
  const resume = spyOn(renderer, "resume")
  const render = spyOn(renderer, "requestRender")
  try {
    const result = openEditor({ value: "original", renderer })
    if (code === 0) await expect(result).resolves.toBe("original")
    if (code !== 0) await expect(result).rejects.toThrow("Editor exited with code 1")
    expect(resume).toHaveBeenCalledTimes(1)
    expect(render).toHaveBeenCalled()
  } finally {
    resume.mockRestore()
    render.mockRestore()
    destroyRenderer(renderer)
  }
})

test("normalizes a single trailing editor newline for one-line prompts", () => {
  expect(normalizePromptContent("hello\n")).toBe("hello")
  expect(normalizePromptContent("hello\r\n")).toBe("hello")
})

test("preserves multiline prompts that end with a newline", () => {
  expect(normalizePromptContent("hello\nworld\n")).toBe("hello\nworld\n")
})
