/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Message, Part, ToolPart } from "@opencode-ai/sdk/v2"
import { createTestRenderer } from "@opentui/core/testing"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { render } from "@opentui/solid"
import { Show } from "solid-js"
import { Session } from "../../../src/routes/session"
import { ArgsProvider } from "../../../src/context/args"
import { EpilogueProvider } from "../../../src/context/epilogue"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider, useKV } from "../../../src/context/kv"
import { RouteProvider, useRoute } from "../../../src/context/route"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { DataProvider } from "../../../src/context/data"
import { ProjectProvider } from "../../../src/context/project"
import { PermissionProvider } from "../../../src/context/permission"
import { ThemeProvider } from "../../../src/context/theme"
import { LocalProvider } from "../../../src/context/local"
import { EditorContextProvider } from "../../../src/context/editor"
import { PromptRefProvider } from "../../../src/context/prompt"
import { PromptHistoryProvider } from "../../../src/component/prompt/history"
import { PromptStashProvider } from "../../../src/component/prompt/stash"
import { FrecencyProvider } from "../../../src/component/prompt/frecency"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../src/plugin/runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { tmpdir } from "../../fixture/fixture"

const url =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
const sessionID = "ses_images"

function file(id: string, messageID: string, filename: string): Extract<Part, { type: "file" }> {
  return { id, sessionID, messageID, type: "file", mime: "image/png", filename, url }
}

function tool(id: string, name: string, filename: string): ToolPart {
  return {
    id,
    sessionID,
    messageID: "msg_assistant",
    type: "tool",
    tool: name,
    callID: id,
    state: {
      status: "completed",
      input: name === "read" ? { filePath: "/tmp/source.png" } : {},
      output: "",
      title: name,
      metadata: {},
      time: { start: 1, end: 2 },
      attachments: [file(`${id}_image`, "msg_assistant", filename)],
    },
  }
}

test("session hydrates and updates image attachments, preserving badges and tool detail visibility", async () => {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 100, height: 180, useThread: false })
  const config = createTuiResolvedConfig({ plugin_enabled: {} })
  const keymap = createDefaultOpenTuiKeymap(setup.renderer)
  const unregister = registerOpencodeKeymap(keymap, setup.renderer, config)
  const events = createEventSource()
  const user = file("prt_user", "msg_user", "user-only.png")
  const document = {
    ...file("prt_document", "msg_document", "notes.txt"),
    mime: "text/plain",
    url: "file:///tmp/notes.txt",
  }
  const read = tool("prt_read", "read", "read-preview.png")
  const generic = tool("prt_generic", "mcp_camera_capture", "generic-preview.png")
  const direct = file("prt_direct", "msg_assistant", "assistant-preview.png")
  const messages: { info: Message; parts: Part[] }[] = [
    ...[user, document].map((part, index) => ({
      info: {
        id: part.messageID,
        sessionID,
        role: "user" as const,
        agent: "build",
        model: { providerID: "test", modelID: "test" },
        time: { created: index },
      },
      parts: [part],
    })),
    {
      info: {
        id: "msg_assistant",
        sessionID,
        role: "assistant",
        parentID: "msg_user",
        agent: "build",
        mode: "build",
        providerID: "test",
        modelID: "test",
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 2, completed: 3 },
      },
      parts: [read, generic, direct].sort((a, b) => a.id.localeCompare(b.id)),
    },
  ]
  const original = JSON.stringify(messages)
  const session = {
    id: sessionID,
    title: "Attachment integration",
    slug: "images",
    projectID: "proj_test",
    directory,
    version: "test",
    time: { created: 0, updated: 3 },
  }
  const calls = createFetch((request) => {
    if (request.pathname === "/session") return json([session])
    if (request.pathname === `/session/${sessionID}`) return json(session)
    if (request.pathname === `/session/${sessionID}/message`) return json(messages)
    if ([`/session/${sessionID}/todo`, `/session/${sessionID}/diff`].includes(request.pathname)) return json([])
  }, events)
  let sync!: ReturnType<typeof useSync>
  function Route() {
    sync = useSync()
    const route = useRoute()
    const kv = useKV()
    kv.set("tool_details_visibility", true)
    kv.set("sidebar", "hide")
    route.navigate({ type: "session", sessionID })
    return (
      <Show when={route.data.type === "session"}>
        <Session />
      </Show>
    )
  }
  async function frameUntil(check: (frame: string) => boolean) {
    const deadline = Date.now() + 5000
    while (true) {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      if (check(frame)) return frame
      if (Date.now() > deadline) throw new Error(`Session frame did not settle:\n${frame}`)
      await Bun.sleep(10)
    }
  }
  function previewsReady(frame: string, labels: string[]) {
    const rows = frame.split("\n")
    // Metadata labels precede lazy decoding; wait for pixels belonging to each preview.
    return labels.every((label) => {
      const row = rows.findIndex((line) => line.includes(`${label} (1x1)`))
      return row > 0 && rows[row - 1].includes("\u2580")
    })
  }
  const labels = ["user-only.png", "read-preview.png", "generic-preview.png", "assistant-preview.png"]
  try {
    await render(
      () => (
        <TestTuiContexts paths={{ state: state.path }}>
          <ExitProvider
            exit={(error) => {
              throw error
            }}
          >
            <EpilogueProvider set={() => {}}>
              <OpencodeKeymapProvider keymap={keymap}>
                <ArgsProvider>
                  <KVProvider>
                    <ToastProvider>
                      <RouteProvider>
                        <TuiConfigProvider config={config}>
                          <PluginRuntimeProvider value={createPluginRuntime()}>
                            <SDKProvider
                              url="http://test"
                              directory={directory}
                              fetch={calls.fetch}
                              events={events.source}
                            >
                              <PermissionProvider>
                                <ProjectProvider>
                                  <SyncProvider>
                                    <DataProvider>
                                      <ThemeProvider mode="dark">
                                        <LocalProvider>
                                          <PromptStashProvider>
                                            <DialogProvider>
                                              <FrecencyProvider>
                                                <PromptHistoryProvider>
                                                  <PromptRefProvider>
                                                    <EditorContextProvider integration={{}}>
                                                      <Route />
                                                    </EditorContextProvider>
                                                  </PromptRefProvider>
                                                </PromptHistoryProvider>
                                              </FrecencyProvider>
                                            </DialogProvider>
                                          </PromptStashProvider>
                                        </LocalProvider>
                                      </ThemeProvider>
                                    </DataProvider>
                                  </SyncProvider>
                                </ProjectProvider>
                              </PermissionProvider>
                            </SDKProvider>
                          </PluginRuntimeProvider>
                        </TuiConfigProvider>
                      </RouteProvider>
                    </ToastProvider>
                  </KVProvider>
                </ArgsProvider>
              </OpencodeKeymapProvider>
            </EpilogueProvider>
          </ExitProvider>
        </TestTuiContexts>
      ),
      setup.renderer,
    )
    const frame = await frameUntil((frame) => previewsReady(frame, labels))
    expect(frame).toContain("notes.txt")
    expect(frame).toContain("File")
    expect(frame.split("user-only.png")).toHaveLength(3) // Badge and preview label.
    for (const label of ["user-only.png (1x1)", "read-preview.png", "generic-preview.png", "assistant-preview.png"]) {
      expect(frame.split(label)).toHaveLength(2)
      const row = frame.split("\n").findIndex((line) => line.includes(label))
      expect(frame.split("\n")[row - 1]).toContain("\u2580")
    }
    expect(JSON.stringify(messages)).toBe(original)
    expect(sync.data.part.msg_user[0]).toEqual(user)

    keymap.dispatchCommand("session.toggle.actions")
    const hidden = await frameUntil(
      (frame) =>
        !frame.includes("read-preview.png") && previewsReady(frame, ["user-only.png", "assistant-preview.png"]),
    )
    expect(hidden).not.toContain("generic-preview.png")
    expect(hidden).toContain("user-only.png (1x1)")
    expect(hidden).toContain("assistant-preview.png (1x1)")
    keymap.dispatchCommand("session.toggle.actions")
    await frameUntil((frame) => previewsReady(frame, labels))
    keymap.dispatchCommand("session.toggle.generic_tool_output")
    const expanded = await frameUntil((frame) => previewsReady(frame, labels))
    expect(expanded.split("generic-preview.png")).toHaveLength(2)

    const updated = { ...user, filename: "updated-user.png", url: "data:image/png;base64,AAAA" }
    events.emit({
      directory,
      payload: { id: "evt_4", type: "message.part.updated", properties: { sessionID, time: 4, part: updated } },
    })
    const changed = await frameUntil(
      (frame) => frame.includes("updated-user.png:") && previewsReady(frame, labels.slice(1)),
    )
    expect(changed).not.toContain("user-only.png")
    expect(changed.split("(1x1)")).toHaveLength(4)
    expect(sync.data.part.msg_user[0]).toEqual(updated)
    events.emit({
      directory,
      payload: { id: "evt_5", type: "message.part.updated", properties: { sessionID, time: 5, part: user } },
    })
    await frameUntil((frame) => previewsReady(frame, labels))

    const completed = tool(generic.id, generic.tool, "updated-tool.png")
    events.emit({
      directory,
      payload: { id: "evt_6", type: "message.part.updated", properties: { sessionID, time: 6, part: completed } },
    })
    const updatedLabels = labels.map((label) => (label === "generic-preview.png" ? "updated-tool.png" : label))
    const final = await frameUntil((frame) => previewsReady(frame, updatedLabels))
    expect(final).not.toContain("generic-preview.png")
    expect(final.split("updated-tool.png")).toHaveLength(2)
    expect(final.split("(1x1)")).toHaveLength(5)
    expect(JSON.stringify(messages)).toBe(original)
    expect(sync.data.part.msg_assistant.find((part) => part.id === generic.id)).toEqual(completed)

    const running: ToolPart = {
      ...read,
      state: { status: "running", input: { filePath: "/tmp/source.png" }, time: { start: 7 } },
    }
    events.emit({
      directory,
      payload: { id: "evt_7", type: "message.part.updated", properties: { sessionID, time: 7, part: running } },
    })
    await frameUntil(
      (frame) =>
        !frame.includes("read-preview.png") &&
        previewsReady(
          frame,
          updatedLabels.filter((label) => label !== "read-preview.png"),
        ),
    )
    events.emit({
      directory,
      payload: { id: "evt_8", type: "message.part.updated", properties: { sessionID, time: 8, part: read } },
    })
    const restored = await frameUntil((frame) => previewsReady(frame, updatedLabels))
    expect(restored.split("read-preview.png")).toHaveLength(2)
    expect(restored.split("(1x1)")).toHaveLength(5)
    expect(JSON.stringify(messages)).toBe(original)
  } finally {
    unregister()
    setup.renderer.destroy()
  }
}, 15000)
