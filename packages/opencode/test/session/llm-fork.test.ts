import { afterAll, beforeAll, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import { jsonSchema, tool } from "ai"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { ForkContext } from "@/session/llm/fork"
import { SessionID, MessageID } from "@/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { testEffect } from "../lib/effect"
import { Auth } from "@/auth"
import { Plugin } from "@/plugin"
import { CodexAuthPlugin } from "@/plugin/openai/codex"
import { createOpencodeClient } from "@opencode-ai/sdk"

const identity = {
  providerID: "openai",
  modelID: "gpt-4.1",
  apiID: "gpt-4.1",
  npm: "@ai-sdk/openai",
  agent: "test",
} as const
const snapshot = () =>
  ForkContext.capture(identity, {
    prompt: [{ role: "system", content: "frozen" }],
    tools: [{ type: "function", name: "read", inputSchema: { type: "object" }, strict: false }],
    providerOptions: { openai: { promptCacheKey: "parent" } },
  })

test("versioned JSON metadata round trips immutably and rejects corrupt or unsupported data", () => {
  const original = snapshot()
  const encoded = JSON.parse(JSON.stringify(ForkContext.metadata(original, "first")))
  const decoded = ForkContext.read(encoded)
  expect(decoded?.snapshot).toEqual(original)
  expect(Object.isFrozen(decoded?.snapshot.request.prompt)).toBe(true)
  expect(ForkContext.read({})).toBeUndefined()
  expect(() => ForkContext.read({ opencode_fork_context: { version: 2 } })).toThrow()
  expect(() =>
    ForkContext.capture(identity, {
      prompt: [{ role: "user", content: [{ type: "file", data: new Uint8Array([1]), mediaType: "image/png" }] }],
    }),
  ).toThrow("plain JSON")
  expect(() => ForkContext.capture(identity, { prompt: [], responseFormat: { type: "json" } })).toThrow()
  expect(() => ForkContext.capture(identity, { prompt: [], toolChoice: { type: "required" } })).toThrow()
  expect(() =>
    ForkContext.capture(identity, {
      prompt: [],
      tools: [{ type: "provider", id: "provider.search", name: "search", args: {} }],
    }),
  ).toThrow("provider-native")
})

test("missing child boundary fails closed and inherited requests retain live transport only", () => {
  expect(() => ForkContext.suffix([{ info: { id: "summary", role: "user" } }], "first")).toThrow("boundary")
  const messages = [{ info: { id: "parent", role: "user" } }, { info: { id: "first", role: "user" } }]
  expect(ForkContext.suffix(messages, "first")).toEqual(messages.slice(1))
  const inherited = ForkContext.inherit(snapshot(), {
    prompt: [],
    headers: { session: "child" },
    toolChoice: { type: "auto" },
  })
  expect(inherited.headers).toEqual({ session: "child" })
  expect(inherited.providerOptions).toEqual({ openai: { promptCacheKey: "parent" } })
})

test("fork identity survives compaction but cutoff before the boundary removes both reserved records", () => {
  const original = ForkContext.capture({ ...identity, cacheSessionID: "root-routing-id" }, { prompt: [] })
  const metadata = { ...ForkContext.metadata(original, "first"), unrelated: true }
  const compacted = ForkContext.clearMetadata(metadata)
  expect(ForkContext.read(compacted)).toBeUndefined()
  expect(ForkContext.identity(compacted)).toEqual({ ...identity, cacheSessionID: "root-routing-id" })
  expect(Object.isFrozen(ForkContext.identity(compacted))).toBe(true)
  expect(ForkContext.identity(metadata)).toEqual(ForkContext.identity(compacted))
  expect(ForkContext.remapMetadata(metadata, new Map())).toEqual({ unrelated: true })
  const remapped = ForkContext.remapMetadata(metadata, new Map([["first", "copied"]]))
  expect(ForkContext.read(remapped)?.firstUserMessageID).toBe("copied")
  expect(ForkContext.identity(remapped)).toEqual(ForkContext.identity(metadata))
  expect(ForkContext.remapMetadata(compacted, new Map())).toEqual({ unrelated: true })
  const compactedCopy = ForkContext.remapMetadata(compacted, new Map([["first", "copied"]]))
  expect(ForkContext.read(compactedCopy)).toBeUndefined()
  expect(ForkContext.identity(compactedCopy)).toEqual(ForkContext.identity(compacted))
  expect(ForkContext.remapMetadata(compactedCopy, new Map([["copied", "again"]]))).toMatchObject({
    opencode_fork_identity: { firstUserMessageID: "again" },
  })
  expect(() => ForkContext.identity({ opencode_fork_identity: { version: 2 } })).toThrow()
  expect(() =>
    ForkContext.identity({
      opencode_fork_identity: { version: 1, firstUserMessageID: "first", ...identity, cacheSessionID: 123 },
    }),
  ).toThrow()
})

test("frozen catalogs use only child bindings and reject missing bindings before execution", async () => {
  let calls = 0
  const bindings = ForkContext.tools(snapshot(), {
    read: tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => ++calls }),
  })
  expect(await bindings.read.execute?.({}, { toolCallId: "child", messages: [] })).toBe(1)
  const denied = ForkContext.tools(snapshot(), {})
  await expect(denied.read.execute?.({}, { toolCallId: "child", messages: [] })).rejects.toThrow("disabled")
  expect(calls).toBe(1)
})

const captures: { body: Record<string, unknown>; headers: Headers }[] = []
let server: ReturnType<typeof Bun.serve>
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      captures.push({ body: await req.json(), headers: req.headers })
      const anthropic = new URL(req.url).pathname.endsWith("/messages")
      const responses = new URL(req.url).pathname.endsWith("/responses")
      const denied = req.headers.get("x-session-id") === "ses_child"
      const chunks = anthropic
        ? [
            {
              type: "message_start",
              message: {
                id: "msg_1",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4-20250514",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 1 },
            },
            { type: "message_stop" },
          ]
        : responses
          ? [
              { type: "response.created", response: { id: "resp_1", created_at: 1, model: "gpt-4.1" } },
              {
                type: "response.completed",
                response: {
                  id: "resp_1",
                  status: "completed",
                  output: [],
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
              },
            ]
          : denied
            ? [
                {
                  id: "chat_1",
                  object: "chat.completion.chunk",
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: "call_read",
                            type: "function",
                            function: { name: "read", arguments: '{"path":"secret"}' },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                },
                {
                  id: "chat_1",
                  object: "chat.completion.chunk",
                  choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                },
              ]
            : [
                {
                  id: "chat_1",
                  object: "chat.completion.chunk",
                  choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
                },
                {
                  id: "chat_1",
                  object: "chat.completion.chunk",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                },
              ]
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
})
afterAll(() => server.stop(true))

const oauth = {
  type: "oauth" as const,
  access: "local-oauth-access",
  refresh: "unused-refresh",
  expires: Date.now() + 3600000,
}
const oauthTests = testEffect(
  AppNodeBuilder.build(LayerNode.group([LLM.node, Provider.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalNativeLlm: false })],
    [
      Auth.node,
      Layer.mock(Auth.Service, {
        get: (id) => Effect.succeed(id === "openai" ? oauth : undefined),
        all: () => Effect.succeed({ openai: oauth }),
      }),
    ],
    [
      Plugin.node,
      Layer.effect(
        Plugin.Service,
        Effect.gen(function* () {
          const hooks = yield* Effect.promise(() =>
            CodexAuthPlugin(
              {
                client: createOpencodeClient({ baseUrl: server.url.origin }),
                project: { id: "fork-test", worktree: "/tmp/opencode", time: { created: 1 } },
                directory: "/tmp/opencode",
                worktree: "/tmp/opencode",
                serverUrl: server.url,
                experimental_workspace: { register() {} },
                $: Bun.$,
              },
              { codexApiEndpoint: `${server.url.origin}/backend-api/codex/responses`, experimentalWebSockets: false },
            ),
          )
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              await hooks.dispose?.()
            }),
          )
          return Plugin.Service.of({
            list: () => Effect.succeed([hooks]),
            init: () => Effect.void,
            trigger: (name, input, output) =>
              Effect.sync(() => {
                // A final header plugin may choose a routing identity different from the logical session ID.
                if (
                  name === "chat.headers" &&
                  input &&
                  typeof input === "object" &&
                  "sessionID" in input &&
                  typeof input.sessionID === "string" &&
                  output &&
                  typeof output === "object"
                ) {
                  Object.assign(output, { headers: { "Session-ID": `route-${input.sessionID}` } })
                }
                return output
              }),
          })
        }),
      ),
    ],
  ]),
)

oauthTests.instance(
  "OAuth fetch preserves root cache routing and instructions while child transport identity stays local",
  () =>
    Effect.gen(function* () {
      captures.length = 0
      const provider = yield* Provider.Service
      const llm = yield* LLM.Service
      const model = yield* provider.getModel(ProviderV2.ID.make("openai"), ModelV2.ID.make("gpt-5.2"))
      const turn: ForkContext.Turn = {}
      const parent: LLM.StreamInput = {
        sessionID: "ses_oauth_parent",
        model,
        agent: { name: "test", mode: "primary", options: {}, permission: [] },
        user: {
          id: MessageID.make("msg_oauth_parent"),
          sessionID: SessionID.make("ses_oauth_parent"),
          role: "user",
          agent: "test",
          time: { created: 1 },
          model: { providerID: model.providerID, modelID: model.id },
        },
        system: ["OAUTH ROOT INSTRUCTIONS"],
        messages: [{ role: "user", content: "root history" }],
        tools: { read: tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => "local" }) },
        forkContext: turn,
      }
      yield* llm.stream(parent).pipe(Stream.runDrain)
      expect(turn.snapshot?.cacheSessionID).toBe("route-ses_oauth_parent")
      if (!turn.snapshot) throw new Error("Missing OAuth snapshot")
      const root = ForkContext.read(JSON.parse(JSON.stringify(ForkContext.metadata(turn.snapshot, "msg_oauth_child"))))
      if (!root) throw new Error("Missing persisted OAuth snapshot")
      const childTurn: ForkContext.Turn = {}
      const child: LLM.StreamInput = {
        ...parent,
        sessionID: "ses_oauth_child",
        parentSessionID: parent.sessionID,
        user: { ...parent.user, id: MessageID.make("msg_oauth_child"), sessionID: SessionID.make("ses_oauth_child") },
        system: ["CHILD INSTRUCTIONS MUST NOT REPLACE ROOT"],
        messages: [{ role: "user", content: "child assignment" }],
        forkSnapshot: root.snapshot,
        forkContext: childTurn,
      }
      yield* llm.stream(child).pipe(Stream.runDrain)
      expect(childTurn.snapshot?.cacheSessionID).toBe("route-ses_oauth_parent")
      if (!childTurn.snapshot) throw new Error("Missing nested OAuth snapshot")
      const nested = ForkContext.read(
        JSON.parse(JSON.stringify(ForkContext.metadata(childTurn.snapshot, "msg_oauth_nested"))),
      )
      if (!nested) throw new Error("Missing persisted nested OAuth snapshot")
      yield* llm
        .stream({
          ...child,
          sessionID: "ses_oauth_nested",
          parentSessionID: child.sessionID,
          user: {
            ...child.user,
            id: MessageID.make("msg_oauth_nested"),
            sessionID: SessionID.make("ses_oauth_nested"),
          },
          forkSnapshot: nested.snapshot,
          forkContext: {},
          messages: [{ role: "user", content: "nested assignment" }],
        })
        .pipe(Stream.runDrain)
      expect(captures).toHaveLength(3)
      const prefix = captures[0].body.input
      if (!Array.isArray(prefix)) throw new Error("Missing Responses prefix")
      for (const [index, capture] of captures.entries()) {
        const id = ["ses_oauth_parent", "ses_oauth_child", "ses_oauth_nested"][index]
        expect(capture.headers.get("authorization")).toBe("Bearer local-oauth-access")
        expect(capture.headers.get("session-id")).toBe("route-ses_oauth_parent")
        expect(capture.headers.get("x-session-id")).toBe(id)
        expect(capture.headers.get("x-session-affinity")).toBe(id)
        expect(capture.headers.get("x-parent-session-id")).toBe(
          index ? [parent.sessionID, child.sessionID][index - 1] : null,
        )
        expect(capture.body.instructions).toBe(captures[0].body.instructions)
        expect(capture.body.instructions).toContain("OAUTH ROOT INSTRUCTIONS")
        expect(capture.body.tools).toEqual(captures[0].body.tools)
        expect(capture.body.prompt_cache_key).toBe(captures[0].body.prompt_cache_key)
        expect(Array.isArray(capture.body.input) && capture.body.input.slice(0, prefix.length)).toEqual(prefix)
      }
      expect(JSON.stringify(root.snapshot)).not.toContain(oauth.access)
      const missing = { ...root.snapshot, cacheSessionID: undefined }
      const failure = yield* llm.stream({ ...child, forkSnapshot: missing }).pipe(Stream.runDrain, Effect.exit)
      if (!Exit.isFailure(failure)) throw new Error("Missing OAuth cache routing was accepted")
      expect(Cause.pretty(failure.cause)).toContain("missing its captured cache session ID")
      expect(captures).toHaveLength(3)
    }),
  {
    config: () => ({
      enabled_providers: ["openai"],
      provider: {
        openai: {
          npm: "@ai-sdk/openai",
          options: { baseURL: `${server.url.origin}/v1` },
          models: { "gpt-5.2": { name: "GPT 5.2", limit: { context: 200000, output: 4096 }, tool_call: true } },
        },
      },
    }),
  },
)

const native = testEffect(
  AppNodeBuilder.build(LayerNode.group([LLM.node, Provider.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalNativeLlm: true })],
  ]),
)
native.instance(
  "native parents do not expose an AI SDK fork snapshot",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const llm = yield* LLM.Service
      const model = yield* provider.getModel(ProviderV2.ID.make("openai"), ModelV2.ID.make("gpt-4.1"))
      const turn: ForkContext.Turn = { snapshot: snapshot() }
      yield* llm
        .stream({
          sessionID: "ses_native",
          model,
          agent: { name: "test", mode: "primary", options: {}, permission: [] },
          user: {
            id: MessageID.make("msg_native"),
            sessionID: SessionID.make("ses_native"),
            role: "user",
            agent: "test",
            time: { created: 1 },
            model: { providerID: model.providerID, modelID: model.id },
          },
          messages: [{ role: "user", content: "Native parent" }],
          system: [],
          tools: {},
          forkContext: turn,
        })
        .pipe(Stream.runDrain)
      expect(turn.snapshot).toBeUndefined()
    }),
  {
    config: () => ({
      enabled_providers: ["openai"],
      provider: {
        openai: {
          npm: "@ai-sdk/openai",
          options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` },
          models: { "gpt-4.1": { name: "gpt-4.1", limit: { context: 200000, output: 4096 }, tool_call: true } },
        },
      },
    }),
  },
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([LLM.node, Provider.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalNativeLlm: false })],
  ]),
)
for (const npm of ["@ai-sdk/openai", "@ai-sdk/openai-compatible", "@ai-sdk/anthropic"] as const) {
  const providerID = npm === "@ai-sdk/anthropic" ? "anthropic" : npm === "@ai-sdk/openai" ? "openai" : "fork-compatible"
  const modelID = npm === "@ai-sdk/anthropic" ? "claude-sonnet-4-20250514" : "gpt-4.1"
  it.instance(
    `${npm}: preserves actual outbound prefix/catalog/options across child resume and nested fork`,
    () =>
      Effect.gen(function* () {
        captures.length = 0
        const provider = yield* Provider.Service
        const llm = yield* LLM.Service
        const model = yield* provider.getModel(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID))
        const turn: ForkContext.Turn = {}
        const agent = { name: "test", mode: "primary" as const, options: {}, permission: [] }
        let executions = 0
        const input: LLM.StreamInput = {
          sessionID: "ses_parent",
          model,
          agent,
          system: ["Authoritative parent instructions"],
          user: {
            id: MessageID.make("msg_parent"),
            sessionID: SessionID.make("ses_parent"),
            role: "user",
            agent: "test",
            time: { created: 1 },
            model: { providerID: model.providerID, modelID: model.id },
          },
          messages: [{ role: "user", content: "Parent history" }],
          tools: {
            read: tool({
              description: "Parent read schema",
              inputSchema: jsonSchema({ type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
              execute: async () => ++executions,
            }),
          },
          forkContext: turn,
        }
        yield* llm.stream(input).pipe(Stream.runDrain)
        expect(turn.snapshot).toBeDefined()
        expect(turn.snapshot?.cacheSessionID).toBeUndefined()
        if (!turn.snapshot) throw new Error("Parent snapshot missing")
        const restored = ForkContext.read(JSON.parse(JSON.stringify(ForkContext.metadata(turn.snapshot, "child_user"))))
        if (!restored) throw new Error("Metadata missing")
        const nested: ForkContext.Turn = {}
        const child: LLM.StreamInput = {
          ...input,
          sessionID: "ses_child",
          parentSessionID: "ses_parent",
          system: ["MUST NOT REPLACE PARENT"],
          user: {
            ...input.user,
            id: MessageID.make("msg_child"),
            sessionID: SessionID.make("ses_child"),
            tools: { read: false },
          },
          messages: [{ role: "user", content: "Child task" }],
          forkSnapshot:
            npm === "@ai-sdk/openai" ? { ...restored.snapshot, cacheSessionID: "not-for-api-key" } : restored.snapshot,
          forkContext: nested,
        }
        const events = yield* llm.stream(child).pipe(Stream.runCollect)
        if (npm === "@ai-sdk/openai-compatible") {
          expect(JSON.stringify(events)).toContain("disabled or unavailable")
        }
        yield* llm
          .stream({
            ...child,
            user: { ...child.user, tools: undefined },
            permission: [{ permission: "read", pattern: "*", action: "deny" }],
            messages: [
              ...child.messages,
              { role: "assistant", content: "Child answer" },
              { role: "user", content: "Resume" },
            ],
          })
          .pipe(Stream.runDrain)
        const parentBody = captures[0].body
        for (const capture of captures.slice(1)) {
          expect(capture.body.tools).toEqual(parentBody.tools)
          expect(capture.headers.get("x-session-id")).toBe("ses_child")
          expect(capture.headers.get("x-parent-session-id")).toBe("ses_parent")
          if (npm === "@ai-sdk/openai") {
            expect(capture.headers.get("session-id")).toBe("ses_child")
            expect(capture.body.prompt_cache_key).toBe(parentBody.prompt_cache_key)
            expect(parentBody.prompt_cache_key).toBe("ses_parent")
          }
          if (npm === "@ai-sdk/anthropic") {
            expect(capture.body.system).toEqual(parentBody.system)
            expect(JSON.stringify(capture.body).match(/cache_control/g)?.length).toBe(
              JSON.stringify(parentBody).match(/cache_control/g)?.length,
            )
          }
          const field = npm === "@ai-sdk/openai" ? "input" : "messages"
          const prefix = parentBody[field] as unknown[]
          if (npm === "@ai-sdk/anthropic") {
            const blocks = (body: Record<string, unknown>) =>
              (body.messages as { role: string; content: unknown[] }[]).flatMap((message) =>
                message.content.map((content) => ({ role: message.role, content })),
              )
            expect(blocks(capture.body).slice(0, blocks(parentBody).length)).toEqual(blocks(parentBody))
          } else {
            expect((capture.body[field] as unknown[]).slice(0, prefix.length)).toEqual(prefix)
          }
          expect(JSON.stringify(capture.body)).not.toContain("MUST NOT REPLACE")
        }
        expect(captures[0].headers.get("x-session-id")).toBe("ses_parent")
        expect(executions).toBe(0)
        expect(nested.snapshot?.request.prompt.length).toBeGreaterThan(restored.snapshot.request.prompt.length)
        if (!nested.snapshot) throw new Error("Nested snapshot missing")
        const nestedTurn: ForkContext.Turn = {}
        yield* llm
          .stream({
            ...child,
            sessionID: "ses_grandchild",
            parentSessionID: "ses_child",
            forkSnapshot: nested.snapshot,
            forkContext: nestedTurn,
            messages: [{ role: "user", content: "Nested task" }],
          })
          .pipe(Stream.runDrain)
        expect(nestedTurn.snapshot?.request.prompt.slice(0, nested.snapshot.request.prompt.length)).toEqual(
          nested.snapshot.request.prompt,
        )
        expect(captures[3].headers.get("x-session-id")).toBe("ses_grandchild")
        expect(captures[3].headers.get("x-parent-session-id")).toBe("ses_child")
        expect(captures[3].body.tools).toEqual(parentBody.tools)
      }),
    {
      config: () => ({
        enabled_providers: [providerID],
        provider: {
          [providerID]: {
            npm,
            options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` },
            models: { [modelID]: { name: modelID, limit: { context: 200000, output: 4096 }, tool_call: true } },
          },
        },
      }),
    },
  )
}
