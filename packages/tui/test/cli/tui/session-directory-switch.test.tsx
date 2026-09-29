/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalSession, Session as SessionInfo } from "@opencode-ai/sdk/v2"
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
import { SDKProvider, useSDK } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { DataProvider } from "../../../src/context/data"
import { ProjectProvider, useProject } from "../../../src/context/project"
import { PermissionProvider } from "../../../src/context/permission"
import { ThemeProvider } from "../../../src/context/theme"
import { LocalProvider } from "../../../src/context/local"
import { EditorContextProvider } from "../../../src/context/editor"
import { PromptRefProvider } from "../../../src/context/prompt"
import { PromptHistoryProvider } from "../../../src/component/prompt/history"
import { PromptStashProvider } from "../../../src/component/prompt/stash"
import { FrecencyProvider } from "../../../src/component/prompt/frecency"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../src/plugin/runtime"
import {
  DialogSessionList,
  sessionProjectFooter,
  sessionProjectLabel,
} from "../../../src/component/dialog-session-list"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json, worktree } from "../../fixture/tui-sdk"
import { tmpdir } from "../../fixture/fixture"

const other = "/tmp/other-project"
const scratchA = "/tmp/scratch-a"
const scratchB = "/tmp/scratch-b"

function session(id: string, projectID: string, dir: string, updated: number, title = id): SessionInfo {
  return { id, title, slug: id, projectID, directory: dir, version: "test", time: { created: 0, updated } }
}

const local = session("ses_local", "proj_test", directory, 5, "Local work")
const sibling = session("ses_sibling", "proj_test", worktree, 4, "Sibling directory")
const foreign = session("ses_foreign", "proj_other", other, 3, "[claude] Foreign work")
const foreignChild = session("ses_foreign_sub", "proj_other", `${other}/pkg`, 2, "Foreign subdir")
const globalA = session("ses_global_a", "global", scratchA, 1, "Scratch A")
const globalB = session("ses_global_b", "global", scratchB, 0, "Scratch B")
const all = [local, sibling, foreign, foreignChild, globalA, globalB]

const projects: Record<string, { id: string; worktree: string; name?: string }> = {
  [directory]: { id: "proj_test", worktree },
  [worktree]: { id: "proj_test", worktree },
  [other]: { id: "proj_other", worktree: other, name: "Other Project" },
  [`${other}/pkg`]: { id: "proj_other", worktree: other, name: "Other Project" },
  [scratchA]: { id: "global", worktree: "/" },
  [scratchB]: { id: "global", worktree: "/" },
}

function globalList(): GlobalSession[] {
  return all.map((item) => ({
    ...item,
    project:
      item.projectID === "global"
        ? { id: "global", worktree: "/" }
        : item.projectID === "proj_other"
          ? { id: "proj_other", worktree: other, name: "Other Project" }
          : { id: "proj_test", worktree },
  }))
}

async function harness() {
  const state = await tmpdir()
  const setup = await createTestRenderer({ width: 120, height: 50, useThread: false })
  const config = createTuiResolvedConfig({ plugin_enabled: {} })
  const keymap = createDefaultOpenTuiKeymap(setup.renderer)
  const unregister = registerOpencodeKeymap(keymap, setup.renderer, config)
  const events = createEventSource()
  const requests: URL[] = []
  const calls = createFetch((url) => {
    requests.push(url)
    const dir = url.searchParams.get("directory") ?? directory
    if (url.pathname === "/experimental/session") return json(globalList())
    if (url.pathname === "/session") return json(all.filter((item) => projects[item.directory]?.id === projects[dir]?.id))
    const match = /^\/session\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (match && match[1] !== "status") {
      const found = all.find((item) => item.id === match[1])
      if (!found) return json({ name: "NotFound" }, { status: 404 })
      if (!match[2]) return json(found)
      if (["/message", "/todo", "/diff"].includes(match[2])) return json([])
    }
    if (url.pathname === "/session/status")
      return json(dir === other ? { ses_foreign: { type: "busy" } } : {})
    if (url.pathname === "/path") return json({ home: "", state: "", config: "", worktree: projects[dir]?.worktree ?? dir, directory: dir })
    if (url.pathname === "/project/current") return json(projects[dir] ?? { id: "global", worktree: "/" })
    if (/^\/project\/[^/]+\/directories$/.test(url.pathname)) return json([])
  }, events)
  const ctx = {} as {
    sdk: ReturnType<typeof useSDK>
    sync: ReturnType<typeof useSync>
    project: ReturnType<typeof useProject>
    route: ReturnType<typeof useRoute>
    dialog: ReturnType<typeof useDialog>
    kv: ReturnType<typeof useKV>
  }
  function Probe() {
    ctx.sdk = useSDK()
    ctx.sync = useSync()
    ctx.project = useProject()
    ctx.route = useRoute()
    ctx.dialog = useDialog()
    ctx.kv = useKV()
    ctx.kv.set("sidebar", "hide")
    return (
      <Show when={ctx.route.data.type === "session"}>
        <Session />
      </Show>
    )
  }
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
                          <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
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
                                                    <Probe />
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
  async function until(label: string, check: () => boolean) {
    const deadline = Date.now() + 5000
    while (!check()) {
      await setup.renderOnce()
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}\n${setup.captureCharFrame()}`)
      await Bun.sleep(10)
    }
  }
  await until("bootstrap", () => ctx.sync?.status === "complete" && ctx.project.data.project.id === "proj_test")
  return {
    ctx,
    requests,
    until,
    frame: () => setup.captureCharFrame(),
    renderOnce: () => setup.renderOnce(),
    keymap,
    async [Symbol.asyncDispose]() {
      unregister()
      setup.renderer.destroy()
      await state[Symbol.asyncDispose]()
    },
  }
}

test("opening a session from another project moves the TUI to that project's directory", async () => {
  await using app = await harness()
  const { ctx } = app
  ctx.route.navigate({ type: "session", sessionID: foreign.id })
  await app.until("switch to the foreign project", () => ctx.project.data.project.id === "proj_other")
  expect(ctx.sdk.directory).toBe(other)
  expect(ctx.project.instance.directory()).toBe(other)
  await app.until("session hydrated", () => ctx.sync.data.session.some((item) => item.id === foreign.id))
  const messages = app.requests.filter((url) => url.pathname === `/session/${foreign.id}/message`)
  expect(messages.at(-1)?.searchParams.get("directory")).toBe(other)
  // The session list now reflects the foreign project.
  await app.until("foreign session list", () => ctx.sync.data.session.some((item) => item.id === foreignChild.id))
  expect(ctx.sync.data.session.map((item) => item.id).toSorted()).toEqual([foreign.id, foreignChild.id].toSorted())
  expect(app.requests.filter((url) => url.pathname === "/session").at(-1)?.searchParams.get("directory")).toBe(other)
  // Location-scoped data (agents, models, references) follows the new directory too.
  await app.until("location data", () => app.requests.some((url) => url.pathname === "/api/reference" && url.searchParams.get("directory") === other))

  ctx.route.navigate({ type: "session", sessionID: local.id })
  await app.until("switch back", () => ctx.project.data.project.id === "proj_test")
  expect(ctx.sdk.directory).toBe(directory)
})

test("sessions of the current project keep the current directory; unrelated non-repository directories switch", async () => {
  await using app = await harness()
  const { ctx } = app
  ctx.route.navigate({ type: "session", sessionID: sibling.id })
  await app.until("sibling hydrated", () => app.requests.some((url) => url.pathname === `/session/${sibling.id}/message`))
  expect(ctx.sdk.directory).toBe(directory)

  ctx.route.navigate({ type: "session", sessionID: globalA.id })
  await app.until("switch to scratch A", () => ctx.project.instance.directory() === scratchA)
  expect(ctx.sdk.directory).toBe(scratchA)
  ctx.route.navigate({ type: "session", sessionID: globalB.id })
  await app.until("switch to scratch B", () => ctx.project.instance.directory() === scratchB)
  expect(ctx.sdk.directory).toBe(scratchB)
})

test("the session list can show every project, grouped by project, and remembers the choice", async () => {
  await using app = await harness()
  const { ctx } = app
  ctx.dialog.replace(() => <DialogSessionList />)
  await app.until("project list", () => app.frame().includes("Local work"))
  expect(app.frame()).not.toContain("Foreign work")

  app.keymap.dispatchCommand("session.list.scope")
  await app.until("all projects", () => app.frame().includes("Foreign work") && app.frame().includes("Scratch B"))
  const frame = app.frame()
  expect(frame).toContain("Sessions (all projects)")
  const order = ["Local work", "Other Project", "[claude] Foreign work", "Foreign subdir", "/tmp/scratch-a", "Scratch A"]
  const positions = order.map((text) => frame.indexOf(text))
  expect(positions.every((position) => position >= 0)).toBe(true)
  expect(positions).toEqual(positions.toSorted((a, b) => a - b))
  expect(frame).toContain("pkg")
  const global = app.requests.filter((url) => url.pathname === "/experimental/session")
  expect(global.length).toBeGreaterThan(0)
  expect(global.every((url) => !url.searchParams.has("directory"))).toBe(true)
  // Busy state for sessions outside the current directory is loaded from their own instance.
  await app.until("foreign status", () => ctx.sync.data.session_status[foreign.id]?.type === "busy")
  expect(ctx.kv.get("session_list_all_projects", false)).toBe(true)

  app.keymap.dispatchCommand("session.list.scope")
  await app.until("back to project", () => !app.frame().includes("Foreign work"))
  expect(ctx.kv.get("session_list_all_projects", true)).toBe(false)
})

test("project labels and footers for cross-project sessions", () => {
  expect(sessionProjectLabel({ directory: other, project: { id: "p", worktree: other, name: "Named" } }, "/home/u")).toBe("Named")
  expect(sessionProjectLabel({ directory: "/home/u/code/x", project: { id: "p", worktree: "/home/u/code" } }, "/home/u")).toBe("~/code")
  expect(sessionProjectLabel({ directory: "/home/u/tmp", project: { id: "global", worktree: "/" } }, "/home/u")).toBe("~/tmp")
  expect(sessionProjectLabel({ directory: "/srv/x", project: null }, "/home/u")).toBe("/srv/x")
  expect(sessionProjectFooter({ directory: "/r/pkg/a", project: { id: "p", worktree: "/r" } })).toBe("pkg/a")
  expect(sessionProjectFooter({ directory: "/r", project: { id: "p", worktree: "/r" } })).toBe("")
  expect(sessionProjectFooter({ directory: "/elsewhere", project: { id: "p", worktree: "/r" } })).toBe("")
  expect(sessionProjectFooter({ directory: "/tmp/x", project: { id: "global", worktree: "/" } })).toBe("")
})
