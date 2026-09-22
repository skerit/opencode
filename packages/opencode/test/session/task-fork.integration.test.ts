import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { ForkContext } from "@/session/llm/fork"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      SessionPrompt.node,
      Session.node,
      SessionProjector.node,
      FSUtil.node,
      BackgroundJob.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, experimentalBackgroundSubagents: true })],
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

const setup = Effect.fn("test.taskFork.setup")(function* (npm: string) {
  const instance = yield* TestInstance
  const fs = yield* FSUtil.Service
  const llm = yield* TestLLMServer
  yield* fs.writeWithDirs(
    path.join(instance.directory, "opencode.json"),
    JSON.stringify({
      model: "test/test-model",
      small_model: "test/test-model",
      subagent_depth: 3,
      experimental: { primary_tools: ["edit"] },
      agent: { build: { temperature: 0.3, top_p: 0.8 } },
      provider: {
        test: {
          name: "Test",
          npm,
          env: [],
          options: { apiKey: "local-test", baseURL: llm.url },
          models: {
            "test-model": {
              name: "Test Model",
              tool_call: true,
              temperature: true,
              limit: { context: 100000, output: 10000 },
              options: { parallelToolCalls: false },
              variants: { exact: { temperature: 0.2 } },
            },
          },
        },
      },
    }),
  )
  return llm
})

function text(messages: SessionV1.WithParts[]) {
  return messages.flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
}

it.instance(
  "simultaneous real task siblings share the pending parent capture but not child history",
  () =>
    Effect.gen(function* () {
      const llm = yield* setup("@ai-sdk/openai-compatible")
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const parent = yield* sessions.create({ title: "Sibling forks" })
      const gate = Promise.withResolvers<void>()
      yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
      // The shared fixture's Reply.tool uses index zero; raw chat chunks exercise two simultaneous calls.
      yield* llm.push(
        raw({
          chunks: [
            {
              id: "siblings",
              object: "chat.completion.chunk",
              choices: [
                {
                  delta: {
                    role: "assistant",
                    tool_calls: ["alpha", "beta"].map((name, index) => ({
                      index,
                      id: `call_${name}`,
                      type: "function",
                      function: {
                        name: "task",
                        arguments: JSON.stringify({ description: name, prompt: `${name} assignment`, fork: true }),
                      },
                    })),
                  },
                  finish_reason: "tool_calls",
                },
              ],
            },
          ],
        }),
      )
      for (const name of ["alpha", "beta"]) {
        yield* llm.pushMatch(
          (hit) => JSON.stringify(hit.body.messages).includes(`${name} assignment`),
          reply().wait(gate.promise).text(`${name} final`).stop(),
        )
      }
      yield* llm.push(reply().text("siblings parent final").stop())
      const running = yield* prompt
        .prompt({ sessionID: parent.id, agent: "build", model, parts: [{ type: "text", text: "launch siblings" }] })
        .pipe(Effect.forkChild)
      yield* awaitWithTimeout(
        llm.wait(3),
        "both sibling provider requests must start before either finishes",
        "10 seconds",
      )
      const children = yield* sessions.children(parent.id)
      expect(children).toHaveLength(2)
      const captures = children.map((child) => ForkContext.read(child.metadata))
      expect(captures[0]).toBeDefined()
      expect(captures[1]).toBeDefined()
      expect(captures[0]?.snapshot).toEqual(captures[1]?.snapshot)
      expect(captures[0]?.firstUserMessageID).not.toBe(captures[1]?.firstUserMessageID)
      const active = (yield* sessions.messages({ sessionID: parent.id }))
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool")
      expect(active).toHaveLength(2)
      expect(active.map((part) => part.state.status)).toEqual(["running", "running"])
      const bodies = yield* llm.inputs
      for (const body of bodies.slice(1)) prefix(bodies[0], body, "messages")
      for (const child of children) {
        const history = yield* sessions.messages({ sessionID: child.id })
        expect(text(history)).toEqual(["launch siblings", `${child.title.split(" ")[0]} assignment`])
        expect(history.flatMap((message) => message.parts).some((part) => part.type === "tool")).toBe(false)
      }
      gate.resolve()
      expect(text([yield* Fiber.join(running)])).toContain("siblings parent final")
      for (const child of children) {
        expect(text(yield* sessions.messages({ sessionID: child.id }))).toContain(`${child.title.split(" ")[0]} final`)
      }
      expect(yield* llm.calls).toBe(4)
      expect(yield* llm.pending).toBe(0)
    }),
  30000,
)

it.instance(
  "background fork returns before the real child finishes and delivers its result to the parent",
  () =>
    Effect.gen(function* () {
      const llm = yield* setup("@ai-sdk/openai-compatible")
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const background = yield* BackgroundJob.Service
      const parent = yield* sessions.create({ title: "Background fork" })
      const gate = Promise.withResolvers<void>()
      yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
      yield* llm.push(
        reply().tool("task", {
          description: "Background worker",
          prompt: "background assignment",
          fork: true,
          background: true,
        }),
      )
      yield* llm.pushMatch((hit) => {
        const messages = hit.body.messages
        return Array.isArray(messages) && JSON.stringify(messages.at(-1)).includes("background assignment")
      }, reply().wait(gate.promise).text("background worker final").stop())
      yield* llm.push(
        reply().text("parent continues independently").stop(),
        reply().text("parent received background result").stop(),
      )
      const result = yield* awaitWithTimeout(
        prompt.prompt({
          sessionID: parent.id,
          agent: "build",
          model,
          parts: [{ type: "text", text: "launch background fork" }],
        }),
        "background launch must not await worker completion",
        "10 seconds",
      )
      expect(text([result])).toContain("parent continues independently")
      yield* awaitWithTimeout(llm.wait(3), "background child must reach the local provider", "10 seconds")
      const children = yield* sessions.children(parent.id)
      expect(children).toHaveLength(1)
      const state = task(yield* sessions.messages({ sessionID: parent.id }))
      expect(state.metadata).toMatchObject({ sessionId: children[0].id, jobId: children[0].id, background: true })
      expect(state.output).toContain('state="running"')
      const bodies = yield* llm.inputs
      const childBody = bodies.find(
        (body) =>
          Array.isArray(body.messages) && JSON.stringify(body.messages.at(-1)).includes("background assignment"),
      )
      if (!childBody) throw new Error("Missing background child HTTP request")
      prefix(bodies[0], childBody, "messages")
      expect(text(yield* sessions.messages({ sessionID: children[0].id }))).not.toContain("background worker final")
      gate.resolve()
      const completed = yield* awaitWithTimeout(
        background.wait({ id: children[0].id }),
        "background job must complete",
        "10 seconds",
      )
      expect(completed.info?.status).toBe("completed")
      expect(completed.info?.output).toBe("background worker final")
      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: parent.id })
          .pipe(
            Effect.map((messages) =>
              messages.some(
                (message) =>
                  message.info.role === "assistant" &&
                  message.info.time.completed &&
                  text([message]).includes("parent received background result"),
              )
                ? messages
                : undefined,
            ),
          ),
        "background result must wake and complete the real parent prompt",
        "10 seconds",
      )
      expect(JSON.stringify((yield* llm.inputs).at(-1))).toContain("background worker final")
      expect(ForkContext.read((yield* sessions.get(children[0].id)).metadata)).toEqual(
        ForkContext.read(children[0].metadata),
      )
      expect(yield* llm.calls).toBe(4)
      expect(yield* llm.pending).toBe(0)
    }),
  30000,
)

function task(messages: SessionV1.WithParts[]) {
  const part = messages
    .flatMap((message) => message.parts)
    .findLast((part) => part.type === "tool" && part.tool === "task")
  if (!part || part.type !== "tool") throw new Error("Missing real task tool call")
  expect(part.state.status).toBe("completed")
  if (part.state.status !== "completed") throw new Error(JSON.stringify(part.state))
  return part.state
}

function prefix(parent: Record<string, unknown>, child: Record<string, unknown>, key: string) {
  const original = parent[key]
  const inherited = child[key]
  if (!Array.isArray(original) || !Array.isArray(inherited)) throw new Error(`Missing HTTP ${key}`)
  expect(inherited.length).toBeGreaterThan(original.length)
  expect(inherited.slice(0, original.length)).toEqual(original)
  expect(Object.fromEntries(Object.entries(child).filter(([name]) => name !== key))).toEqual(
    Object.fromEntries(Object.entries(parent).filter(([name]) => name !== key)),
  )
}

for (const npm of ["@ai-sdk/openai-compatible", "@ai-sdk/openai"]) {
  const key = npm === "@ai-sdk/openai" ? "input" : "messages"
  it.instance(
    `${npm}: real task fork copies history and resumes its persisted provider prefix`,
    () =>
      Effect.gen(function* () {
        const llm = yield* setup(npm)
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const parent = yield* sessions.create({
          title: "Fork integration",
          permission: [
            { permission: "bash", pattern: "forbidden *", action: "deny" },
            { permission: "external_directory", pattern: "*", action: "allow" },
          ],
        })
        yield* llm.push(reply().text("historical assistant").stop())
        yield* prompt.prompt({
          sessionID: parent.id,
          agent: "build",
          model,
          variant: "exact",
          parts: [{ type: "text", text: "historical user" }],
        })
        yield* llm.reset
        yield* llm.push(
          reply()
            .text("active assistant must not be copied")
            .tool("task", { description: "Fork worker", prompt: "worker assignment", fork: true }),
          // Scripted cache usage verifies accounting only, not an actual provider cache hit.
          npm === "@ai-sdk/openai-compatible"
            ? raw({
                chunks: [
                  {
                    id: "worker",
                    object: "chat.completion.chunk",
                    choices: [{ delta: { role: "assistant", content: "worker final" }, finish_reason: "stop" }],
                    usage: {
                      prompt_tokens: 100,
                      completion_tokens: 7,
                      total_tokens: 107,
                      prompt_tokens_details: { cached_tokens: 60 },
                    },
                  },
                ],
              })
            : reply().text("worker final").usage({ input: 100, output: 7 }).stop(),
          reply().text("parent final").stop(),
        )
        const result = yield* prompt.prompt({
          sessionID: parent.id,
          agent: "build",
          model,
          variant: "exact",
          parts: [{ type: "text", text: "launch worker" }],
        })
        expect(text([result])).toContain("parent final")
        const parentMessages = yield* sessions.messages({ sessionID: parent.id })
        expect(task(parentMessages).output).toContain("worker final")
        const children = yield* sessions.children(parent.id)
        expect(children).toHaveLength(1)
        const child = yield* sessions.get(children[0].id)
        expect(child.parentID).toBe(parent.id)
        expect(child.agent).toBe("build")
        expect(child.model).toEqual({ id: model.modelID, providerID: model.providerID, variant: "exact" })
        expect(task(parentMessages).metadata.sessionId).toBe(child.id)
        expect(Permission.evaluate("task", "build", child.permission ?? []).action).toBe("deny")
        expect(Permission.evaluate("edit", "*", child.permission ?? []).action).toBe("deny")
        expect(Permission.evaluate("bash", "forbidden command", child.permission ?? []).action).toBe("deny")
        expect(Permission.evaluate("external_directory", "/elsewhere", child.permission ?? []).action).toBe("allow")
        const history = yield* sessions.messages({ sessionID: child.id })
        expect(text(history)).toEqual([
          "historical user",
          "historical assistant",
          "launch worker",
          "worker assignment",
          "worker final",
        ])
        expect(history.every((message) => message.info.sessionID === child.id)).toBe(true)
        expect(history.some((message) => parentMessages.some((original) => original.info.id === message.info.id))).toBe(
          false,
        )
        expect(history[1].info).toMatchObject({ role: "assistant", parentID: history[0].info.id })
        expect(history.flatMap((message) => message.parts).every((part) => part.sessionID === child.id)).toBe(true)
        const worker = history.at(-1)?.info
        expect(worker).toMatchObject({
          role: "assistant",
          agent: "build",
          modelID: model.modelID,
          providerID: model.providerID,
          variant: "exact",
          tokens: {
            input: npm === "@ai-sdk/openai-compatible" ? 40 : 100,
            output: 7,
            cache: { read: npm === "@ai-sdk/openai-compatible" ? 60 : 0, write: 0 },
          },
        })
        const stored = ForkContext.read(child.metadata)
        expect(stored).toBeDefined()
        expect(stored?.firstUserMessageID).toBe(history[3].info.id)
        const bodies = yield* llm.inputs
        expect(bodies).toHaveLength(3)
        expect((yield* llm.hits).map((hit) => hit.url.pathname)).toEqual(
          Array(3).fill(npm === "@ai-sdk/openai" ? "/v1/responses" : "/v1/chat/completions"),
        )
        expect(bodies[0].model).toBe("test-model")
        expect(bodies[0].temperature).toBe(npm === "@ai-sdk/openai-compatible" ? 0.2 : 0.3)
        expect(bodies[0].top_p).toBe(0.8)
        prefix(bodies[0], bodies[1], key)
        expect(JSON.stringify(bodies[1].tools)).toContain('"task"')
        expect(JSON.stringify(bodies[1].tools)).toContain('"write"')
        expect(yield* llm.pending).toBe(0)

        yield* llm.reset
        yield* llm.push(
          reply().tool("task", { description: "Resume worker", prompt: "resume assignment", task_id: child.id }),
          reply().text("resumed worker final").stop(),
          reply().text("resumed parent final").stop(),
        )
        yield* prompt.prompt({
          sessionID: parent.id,
          agent: "build",
          model,
          variant: "exact",
          parts: [{ type: "text", text: "parent source changed after fork" }],
        })
        const resumed = yield* llm.inputs
        expect(resumed).toHaveLength(3)
        expect(JSON.stringify(resumed[0])).toContain("parent source changed after fork")
        expect(JSON.stringify(resumed[1])).not.toContain("parent source changed after fork")
        expect(JSON.stringify(resumed[1])).toContain("resume assignment")
        expect(JSON.stringify(resumed[1])).toContain("worker final")
        prefix(bodies[0], resumed[1], key)
        expect(ForkContext.read((yield* sessions.get(child.id)).metadata)).toEqual(stored)
        expect(yield* sessions.children(parent.id)).toHaveLength(1)
        expect(task(yield* sessions.messages({ sessionID: parent.id })).output).toContain("resumed worker final")
        expect(yield* llm.pending).toBe(0)
      }),
    30000,
  )

  it.instance(
    `${npm}: advertised child task and write tools cannot bypass execution restrictions`,
    () =>
      Effect.gen(function* () {
        const llm = yield* setup(npm)
        const instance = yield* TestInstance
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const parent = yield* sessions.create({ title: "Denied fork tools" })
        const file = path.join(instance.directory, "must-not-exist.txt")
        yield* llm.push(
          reply().tool("task", { description: "Restricted worker", prompt: "attempt restricted tools", fork: true }),
          reply().tool("task", { description: "Forbidden grandchild", prompt: "must not launch", fork: true }),
          reply().tool("write", { filePath: file, content: "must not write" }),
          reply().text("worker handled denials").stop(),
          reply().text("parent completed").stop(),
        )
        yield* prompt.prompt({
          sessionID: parent.id,
          agent: "build",
          model,
          parts: [{ type: "text", text: "launch restricted worker" }],
        })
        const children = yield* sessions.children(parent.id)
        expect(children).toHaveLength(1)
        expect(yield* sessions.children(children[0].id)).toHaveLength(0)
        expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
        const history = yield* sessions.messages({ sessionID: children[0].id })
        const calls = history.flatMap((message) => message.parts).filter((part) => part.type === "tool")
        expect(calls.map((part) => part.tool)).toEqual(["task", "write"])
        for (const call of calls) {
          expect(call.state.status).toBe("error")
          if (call.state.status !== "error") throw new Error("Denied tool executed")
          expect(call.state.error).toContain(`Fork tool is disabled or unavailable in the child: ${call.tool}`)
        }
        const bodies = yield* llm.inputs
        expect(bodies).toHaveLength(5)
        for (const body of bodies.slice(1, 4)) prefix(bodies[0], body, key)
        expect(task(yield* sessions.messages({ sessionID: parent.id })).output).toContain("worker handled denials")
        expect(yield* llm.pending).toBe(0)
      }),
    30000,
  )
}
