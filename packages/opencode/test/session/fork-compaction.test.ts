import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { ForkContext } from "@/session/llm/fork"
import { SessionCompaction } from "@/session/compaction"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

test("clearMetadata removes only the reserved request snapshot without mutating its input", () => {
  const metadata = {
    opencode_fork_context: { version: 1 },
    unrelated: { keep: true },
    opencode_fork_identity: { agent: "build" },
  }
  expect(ForkContext.clearMetadata(metadata)).toEqual({
    unrelated: { keep: true },
    opencode_fork_identity: { agent: "build" },
  })
  expect(metadata.opencode_fork_context).toEqual({ version: 1 })
  expect(ForkContext.clearMetadata(undefined)).toEqual({})
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      SessionPrompt.node,
      Session.node,
      SessionCompaction.node,
      SessionProjector.node,
      FSUtil.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, experimentalNativeLlm: false })],
      [SessionSummary.node, Layer.mock(SessionSummary.Service, { summarize: () => Effect.void })],
      [LSP.node, Layer.mock(LSP.Service, { init: () => Effect.void })],
      [
        MCP.node,
        Layer.mock(MCP.Service, {
          clients: () => Effect.succeed({}),
          tools: () => Effect.succeed({}),
          instructions: () => Effect.succeed([]),
          resources: () => Effect.succeed({}),
        }),
      ],
    ],
  ),
)

const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

for (const mode of ["manual", "automatic", "turn-overflow"] as const) {
  it.instance(
    `${mode} compaction resets a real fork prefix and resumes from its summary`,
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const fs = yield* FSUtil.Service
        const llm = yield* TestLLMServer
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const compaction = yield* SessionCompaction.Service
        yield* fs.writeWithDirs(
          path.join(instance.directory, "opencode.json"),
          JSON.stringify({
            model: "test/test-model",
            small_model: "test/test-model",
            compaction: { tail_turns: 0 },
            provider: {
              test: {
                name: "Test",
                npm: "@ai-sdk/openai-compatible",
                env: [],
                options: { apiKey: "local-test", baseURL: llm.url },
                models: {
                  "test-model": { name: "Test Model", tool_call: true, limit: { context: 100000, output: 10000 } },
                },
              },
            },
          }),
        )
        const parent = yield* sessions.create({
          title: "Fork compaction",
          permission: [{ permission: "bash", pattern: "forbidden *", action: "deny" }],
        })
        yield* llm.push(reply().text("copied parent answer").stop())
        yield* prompt.prompt({
          sessionID: parent.id,
          agent: "build",
          model,
          parts: [{ type: "text", text: "copied parent question" }],
        })
        yield* llm.reset
        yield* llm.push(
          reply().tool("task", { description: "Compacting worker", prompt: "child assignment", fork: true }),
          reply().text("child first answer").stop(),
          reply().text("parent done").stop(),
        )
        yield* prompt.prompt({
          sessionID: parent.id,
          agent: "build",
          model,
          parts: [{ type: "text", text: "launch child" }],
        })
        const children = yield* sessions.children(parent.id)
        expect(children).toHaveLength(1)
        const child = children[0]
        const stored = ForkContext.read(child.metadata)
        expect(stored).toBeDefined()
        const before = yield* llm.inputs
        const parentPrefix = before[0].messages
        if (!Array.isArray(parentPrefix) || !Array.isArray(before[1].messages))
          throw new Error("Missing provider messages")
        expect(before[1].messages.slice(0, parentPrefix.length)).toEqual(parentPrefix)
        yield* sessions.setMetadata({ sessionID: child.id, metadata: { ...child.metadata, unrelated: { keep: true } } })
        yield* llm.reset
        if (mode === "turn-overflow")
          yield* llm.push(reply().text("overflowing child answer").usage({ input: 99000, output: 1 }).stop())
        yield* llm.push(reply().text("COMPACTED CHILD SUMMARY").stop())
        if (mode !== "manual") {
          const history = yield* sessions.messages({ sessionID: child.id })
          const last = history.at(-1)?.info
          if (!last || last.role !== "assistant") throw new Error("Missing child assistant")
          // Real token overflow detection schedules the compaction, not a mocked compaction service.
          if (mode === "automatic") yield* sessions.updateMessage({ ...last, tokens: { ...last.tokens, input: 99000 } })
          yield* llm.push(reply().text("continued after automatic compaction").stop())
          yield* prompt.prompt({
            sessionID: child.id,
            agent: "build",
            model,
            parts: [{ type: "text", text: "continue child" }],
          })
        } else {
          yield* compaction.create({ sessionID: child.id, agent: "build", model, auto: false })
          yield* prompt.loop({ sessionID: child.id })
        }
        const compacted = yield* sessions.get(child.id)
        expect(ForkContext.read(compacted.metadata)).toBeUndefined()
        expect(compacted.metadata).toEqual(ForkContext.clearMetadata({ ...child.metadata, unrelated: { keep: true } }))
        expect(compacted.parentID).toBe(child.parentID)
        expect(compacted.permission).toEqual(child.permission)
        expect(compacted.agent).toBe(child.agent)
        expect(compacted.model).toEqual(child.model)
        const compactingIndex = mode === "turn-overflow" ? 1 : 0
        const compacting = JSON.stringify((yield* llm.inputs)[compactingIndex].messages)
        for (const text of [
          "copied parent question",
          "copied parent answer",
          "launch child",
          "child assignment",
          "child first answer",
        ]) {
          expect(compacting).toContain(text)
        }
        yield* llm.push(reply().text("resumed compacted child").stop())
        const resumed = yield* prompt.prompt({
          sessionID: child.id,
          agent: "build",
          model,
          parts: [{ type: "text", text: "resume after reset" }],
        })
        if (resumed.info.role !== "assistant") throw new Error("Expected resumed assistant")
        expect(resumed.info.error).toBeUndefined()
        expect(resumed.parts.some((part) => part.type === "text" && part.text === "resumed compacted child")).toBe(true)
        const after = yield* llm.inputs
        for (const body of after.slice(compactingIndex + 1)) {
          const text = JSON.stringify(body.messages)
          expect(text).toContain("COMPACTED CHILD SUMMARY")
          expect(text).not.toContain("copied parent question")
          expect(text).not.toContain("child assignment")
        }
        const durable = yield* sessions.messages({ sessionID: child.id })
        expect(durable.some((message) => message.info.id === stored?.firstUserMessageID)).toBe(true)
        expect(yield* llm.pending).toBe(0)
        expect(yield* llm.calls).toBe(mode === "manual" ? 2 : mode === "automatic" ? 3 : 4)
      }),
    30000,
  )
}
