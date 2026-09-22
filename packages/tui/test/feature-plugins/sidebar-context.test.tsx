/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import type { AssistantMessage, Message, Provider } from "@opencode-ai/sdk/v2"
import { testRender, useRenderer } from "@opentui/solid"
import { createSignal } from "solid-js"
import plugin from "../../src/feature-plugins/sidebar/context"
import { createSlots } from "../../src/plugin/slots"
import { createTuiPluginApi } from "../fixture/tui-plugin"

function assistant(tokens: Partial<AssistantMessage["tokens"]> = {}): AssistantMessage {
  return {
    id: "assistant",
    sessionID: "session",
    role: "assistant",
    time: { created: 1, completed: 2 },
    parentID: "user",
    providerID: "provider",
    modelID: "model",
    mode: "build",
    agent: "build",
    path: { cwd: "/work", root: "/work" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, ...tokens },
  }
}

const provider: Provider = {
  id: "provider",
  name: "Provider",
  source: "config",
  env: [],
  options: {},
  models: {
    model: {
      id: "model",
      providerID: "provider",
      name: "Model",
      api: { id: "model", url: "", npm: "" },
      capabilities: {
        temperature: false,
        reasoning: true,
        attachment: false,
        toolcall: false,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 100000, output: 10000 },
      status: "active",
      options: {},
      headers: {},
      release_date: "",
    },
  },
}

async function renderContext(initial: Message[]) {
  const [messages, setMessages] = createSignal(initial)
  const slots = createSlots()
  let ready: Promise<void> | undefined
  function Harness() {
    const base = createTuiPluginApi({ state: { session: { messages: () => messages() } } })
    const api = { ...base, renderer: useRenderer(), state: { ...base.state, provider: [provider] } }
    const host = slots.setup(api)
    api.slots = {
      register(value: TuiSlotPlugin) {
        host.register({ ...value, id: plugin.id })
        return plugin.id
      },
    }
    ready = plugin.tui(api, undefined, {
      id: plugin.id,
      source: "internal",
      spec: plugin.id,
      target: plugin.id,
      first_time: 0,
      last_time: 0,
      time_changed: 0,
      load_count: 1,
      fingerprint: "test",
      state: "first",
    })
    return <slots.Slot name="sidebar_content" session_id="session" />
  }
  const app = await testRender(() => <Harness />, { width: 42, height: 5 })
  try {
    await ready
    await app.renderOnce()
    return { ...app, setMessages }
  } catch (error) {
    app.renderer.destroy()
    throw error
  }
}

test("renders cache hit between context usage and cost, excluding output and reasoning", async () => {
  const app = await renderContext([
    assistant({ input: 144, output: 1000, reasoning: 2000, cache: { read: 18688, write: 0 } }),
  ])
  try {
    expect(app.captureCharFrame().replace(/[ \t]+$/gm, "")).toMatchInlineSnapshot(`
"Context
21,832 tokens
22% used
99.2% cache hit
$0.00 spent
"
`)
  } finally {
    app.renderer.destroy()
  }
})

const user: Message = {
  id: "user",
  sessionID: "session",
  role: "user",
  time: { created: 0 },
  agent: "build",
  model: { providerID: "provider", modelID: "model" },
}

test.each([
  {
    name: "cache writes enter denominator",
    messages: [assistant({ input: 100, cache: { read: 600, write: 300 } })],
    tokens: "1,000",
    percent: 1,
    cache: "60.0%",
  },
  { name: "zero reads", messages: [assistant({ input: 1000 })], tokens: "1,000", percent: 1, cache: "0.0%" },
  {
    name: "all cached completed zero-output turn",
    messages: [assistant({ cache: { read: 1000, write: 0 } })],
    tokens: "1,000",
    percent: 1,
    cache: "100.0%",
  },
  {
    name: "write-only usage",
    messages: [assistant({ cache: { read: 0, write: 1000 } })],
    tokens: "1,000",
    percent: 1,
    cache: "0.0%",
  },
  {
    name: "reasoning-only completed turn",
    messages: [assistant({ input: 500 }), assistant({ reasoning: 1000 })],
    tokens: "1,000",
    percent: 1,
    cache: "N/A",
  },
  { name: "output-only usage", messages: [assistant({ output: 1000 })], tokens: "1,000", percent: 1, cache: "N/A" },
  {
    name: "total-only usage",
    messages: [assistant({ input: 500 }), assistant({ total: 1000 })],
    tokens: "0",
    percent: 0,
    cache: "N/A",
  },
  { name: "no messages", messages: [], tokens: "0", percent: 0, cache: "N/A" },
  { name: "user-only messages", messages: [user], tokens: "0", percent: 0, cache: "N/A" },
  {
    name: "unknown model",
    messages: [{ ...assistant({ input: 144, cache: { read: 18688, write: 0 } }), modelID: "unknown" }],
    tokens: "18,832",
    percent: 0,
    cache: "99.2%",
  },
])("$name", async ({ messages, tokens, percent, cache }) => {
  const app = await renderContext([...messages])
  try {
    expect(app.captureCharFrame()).toBe(
      ["Context", `${tokens} tokens`, `${percent}% used`, `${cache} cache hit`, "$0.00 spent"]
        .map((line) => line.padEnd(42) + "\n")
        .join(""),
    )
  } finally {
    app.renderer.destroy()
  }
})

test("streaming zero usage retains previous assistant until new usage arrives reactively", async () => {
  const previous = assistant({ input: 144, cache: { read: 18688, write: 0 } })
  const streaming = { ...assistant(), id: "streaming", time: { created: 3 } }
  const app = await renderContext([previous])
  try {
    const frame = app.captureCharFrame()
    app.setMessages([previous, user, streaming])
    await app.renderOnce()
    expect(app.captureCharFrame()).toBe(frame)
    app.setMessages([
      previous,
      user,
      { ...streaming, tokens: assistant({ input: 500, cache: { read: 500, write: 0 } }).tokens },
    ])
    await app.renderOnce()
    expect(app.captureCharFrame().replace(/[ \t]+$/gm, "")).toMatchInlineSnapshot(`
"Context
1,000 tokens
1% used
50.0% cache hit
$0.00 spent
"
`)
  } finally {
    app.renderer.destroy()
  }
})
