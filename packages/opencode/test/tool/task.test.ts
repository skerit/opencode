import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ForkContext } from "@/session/llm/fork"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function forkContext(): ForkContext.Turn {
  return {
    snapshot: ForkContext.capture(
      { ...ref, apiID: ref.modelID, npm: "@ai-sdk/openai", agent: "build", variant: "xhigh" },
      { prompt: [{ role: "user", content: [{ type: "text", text: "parent context" }] }] },
    ),
  }
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: {
  onPrompt?: (input: SessionPrompt.PromptInput) => void
  text?: string
  error?: NonNullable<SessionV1.Assistant["error"]>
  toolError?: string
}): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done", opts?.error, opts?.toolError)
      }),
  }
}

function reply(
  input: SessionPrompt.PromptInput,
  text: string,
  error?: NonNullable<SessionV1.Assistant["error"]>,
  toolError?: string,
): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
      error,
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
      ...(toolError
        ? [
            {
              id: PartID.ascending(),
              messageID: id,
              sessionID: input.sessionID,
              type: "tool" as const,
              tool: "read",
              callID: "call-1",
              state: {
                status: "error" as const,
                input: { filePath: "/external" },
                error: toolError,
                time: { start: Date.now(), end: Date.now() },
              },
            },
          ]
        : []),
    ],
  }
}

describe("tool.task", () => {
  it.instance(
    "fork inherits identity and permissions and resumes without recopying before and after compaction",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        yield* sessions.setPermission({
          sessionID: chat.id,
          permission: [{ permission: "edit", pattern: "*", action: "deny" }],
        })
        yield* sessions.setMetadata({ sessionID: chat.id, metadata: { unrelated: true } })
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const prompts: SessionPrompt.PromptInput[] = []
        const context = {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { forkContext: forkContext(), promptOps: stubOps({ onPrompt: (input) => prompts.push(input) }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }
        const isolated = yield* def.execute(
          { description: "isolated", prompt: "work", subagent_type: "build" },
          context,
        )
        const result = yield* def.execute({ description: "fork", prompt: "work", fork: true }, context)
        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("build")
        expect(child.model).toEqual({ id: ref.modelID, providerID: ref.providerID, variant: "xhigh" })
        expect(child.permission).toEqual((yield* sessions.get(isolated.metadata.sessionId)).permission)
        expect(child.permission).toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
        expect(child.metadata?.unrelated).toBeUndefined()
        expect(ForkContext.read(child.metadata)?.firstUserMessageID).toBe(prompts[1]?.messageID)
        expect(prompts[1]).toMatchObject({ model: ref, variant: "xhigh", agent: "build" })
        const history = yield* sessions.messages({ sessionID: child.id })
        expect(history).toHaveLength(1)
        expect(history[0]?.info.role).toBe("user")
        yield* sessions.updateMessage({ ...assistant, modelID: ModelV2.ID.make("changed"), variant: "low" })
        yield* sessions.setAgentModel({
          sessionID: child.id,
          agent: "general",
          model: { id: ModelV2.ID.make("changed"), providerID: ref.providerID },
          time: Date.now(),
        })
        yield* def.execute({ description: "resume", prompt: "continue", task_id: child.id }, context)
        expect(prompts[2]).toMatchObject({ sessionID: child.id, model: ref, variant: "xhigh", agent: "build" })
        expect(prompts[2]?.messageID).not.toBe(prompts[1]?.messageID)
        expect(yield* sessions.messages({ sessionID: child.id })).toEqual(history)
        expect(yield* sessions.children(chat.id)).toHaveLength(2)
        const compactedMetadata = ForkContext.clearMetadata(child.metadata)
        expect(ForkContext.read(compactedMetadata)).toBeUndefined()
        yield* sessions.setMetadata({ sessionID: child.id, metadata: compactedMetadata })
        yield* sessions.updateMessage({
          ...assistant,
          agent: "general",
          modelID: ModelV2.ID.make("other-model"),
          providerID: ProviderV2.ID.make("other-provider"),
          variant: "low",
        })
        const resumed = yield* def.execute(
          { description: "resume compacted", prompt: "continue after summary", task_id: child.id },
          { ...context, agent: "general", extra: { promptOps: context.extra.promptOps } },
        )
        expect(resumed.metadata.sessionId).toBe(child.id)
        expect(prompts[3]).toMatchObject({ sessionID: child.id, model: ref, variant: "xhigh", agent: "build" })
        expect(prompts[3]?.messageID).not.toBe(prompts[2]?.messageID)
        expect(yield* sessions.messages({ sessionID: child.id })).toEqual(history)
        expect(yield* sessions.children(chat.id)).toHaveLength(2)
        yield* sessions.setMetadata({ sessionID: child.id, metadata: { opencode_fork_context: { version: 99 } } })
        expect(
          Exit.isFailure(
            yield* def
              .execute({ description: "bad metadata", prompt: "work", task_id: child.id }, context)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(prompts).toHaveLength(4)
      }),
    { config: { agent: { build: { model: "test/override" } }, experimental: { primary_tools: ["bash"] } } },
  )

  it.instance("denied forks and depth failures create no child", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { forkContext: forkContext(), promptOps: stubOps() },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.die(new Error("denied")),
      }
      expect(
        Exit.isFailure(
          yield* def.execute({ description: "denied", prompt: "work", fork: true }, context).pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
      const child = yield* sessions.create({ parentID: chat.id })
      expect(
        Exit.isFailure(
          yield* def
            .execute(
              { description: "nested", prompt: "work", fork: true },
              { ...context, sessionID: child.id, ask: () => Effect.void },
            )
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* sessions.children(child.id)).toHaveLength(0)
    }),
  )

  it.instance("rejects invalid fork requests before creating a child", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      expect(def.description).toContain("fork-context-v1")
      for (const input of [
        { fork: true },
        { fork: true, subagent_type: "general" },
        { fork: true, task_id: chat.id },
        {},
      ]) {
        const exit = yield* def
          .execute(
            { description: "invalid fork", prompt: "work", ...input },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps() },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit) && input.fork && !input.subagent_type && !input.task_id) {
          expect(String(Cause.squash(exit.cause))).toContain("configured AI SDK provider")
        }
        expect(yield* sessions.children(chat.id)).toHaveLength(0)
      }
    }),
  )

  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  it.instance("execute surfaces child errors with a resumable task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({
                text: "",
                error: new SessionV1.APIError({ message: "Network connection lost", isRetryable: false }).toObject(),
              }),
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected task failure")
      const child = (yield* sessions.children(chat.id))[0]
      expect(child).toBeDefined()
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(Error)
      if (!(failure instanceof Error)) throw new Error("expected Error defect")
      expect(failure.message).toBe(`Subagent failed (task_id: ${child?.id}): Network connection lost`)
    }),
  )

  it.instance("execute surfaces terminal child tool errors with a resumable task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect external directory",
            prompt: "read the external directory",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({
                text: "I will inspect the directory.",
                toolError: "The user rejected permission to use this specific tool call.",
              }),
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected task failure")
      const child = (yield* sessions.children(chat.id))[0]
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(Error)
      if (!(failure instanceof Error)) throw new Error("expected Error defect")
      expect(failure.message).toBe(
        `Subagent failed (task_id: ${child?.id}): The user rejected permission to use this specific tool call.`,
      )
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  for (const fork of [false, true]) {
    it.instance(`execute cancels child session when abort signal fires (fork=${fork})`, () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const ready = defer<SessionPrompt.PromptInput>()
        const cancelled = defer<SessionID>()
        const abort = new AbortController()
        const promptOps: TaskPromptOps = {
          cancel: (sessionID) =>
            Effect.sync(() => {
              cancelled.resolve(sessionID)
            }),
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.promise(() => {
              ready.resolve(input)
              return cancelled.promise
            }).pipe(Effect.as(reply(input, "cancelled"))),
        }

        const fiber = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: fork ? undefined : "general",
              fork,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: abort.signal,
              extra: { promptOps, forkContext: forkContext() },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.forkChild)

        const input = yield* Effect.promise(() => ready.promise)
        abort.abort()
        expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    )
  }

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  it.instance("prevents subagents from launching subagents by default", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const nestedAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: child.id,
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.sync(() => (asked = true)),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(asked).toBe(false)
      expect(yield* sessions.children(child.id)).toHaveLength(0)
    }),
  )

  it.instance(
    "allows nested subagents up to the configured depth",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "child" })
        const nestedAssistant = yield* sessions.updateMessage({
          ...assistant,
          id: MessageID.ascending(),
          parentID: MessageID.ascending(),
          sessionID: child.id,
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect((yield* sessions.get(result.metadata.sessionId)).parentID).toBe(child.id)
      }),
    { config: { subagent_depth: 2 } },
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        expect(child.permission).toEqual([
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "read",
            pattern: "*",
            action: "deny",
          },
        ])
        expect(seen?.tools).toBeUndefined()
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("rejects background execution when the experiment is disabled", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  for (const fork of [false, true]) {
    it.instance(`promotes a running foreground task without restarting it (fork=${fork})`, () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const ready = yield* Deferred.make<void>()
        const done = yield* Deferred.make<void>()
        const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
        let runs = 0
        const promptOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) => {
            if (input.sessionID === chat.id) {
              return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
            }
            return Effect.gen(function* () {
              runs += 1
              yield* Deferred.succeed(ready, undefined)
              yield* Deferred.await(done)
              return reply(input, "background done")
            })
          },
        }

        const fiber = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: fork ? undefined : "general",
              fork,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps, forkContext: forkContext() },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.forkChild)

        yield* Deferred.await(ready)
        const job = (yield* jobs.list())[0]
        expect(job).toBeDefined()
        if (!job) throw new Error("task job not found")
        expect(job.metadata?.parentSessionId).toBe(chat.id)
        yield* jobs.promote(job.id)

        const result = yield* Fiber.join(fiber)
        expect(result.metadata.background).toBe(true)
        expect(result.output).toContain(`state="running"`)
        expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
        expect(runs).toBe(1)

        yield* Deferred.succeed(done, undefined)
        expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.output).toBe("background done")
        expect((yield* Deferred.await(injected)).parts[0]?.type).toBe("text")
        expect(runs).toBe(1)
      }),
    )
  }

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  for (const fork of [false, true]) {
    background.instance(`background task completion waits for running updates (fork=${fork})`, () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const first = defer<void>()
        const second = defer<void>()
        const updated = defer<SessionPrompt.PromptInput>()
        const injected = defer<SessionPrompt.PromptInput>()
        let prompts = 0
        const promptOps: TaskPromptOps = {
          ...stubOps(),
          prompt: (input) => {
            if (input.sessionID === chat.id) {
              injected.resolve(input)
              return Effect.succeed(reply(input, "done"))
            }
            prompts++
            if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
            updated.resolve(input)
            return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
          },
        }
        const context = {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps, forkContext: forkContext() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }

        const started = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: fork ? undefined : "general",
            fork,
            background: true,
          },
          context,
        )
        const result = yield* def.execute(
          {
            description: "add investigation scope",
            prompt: "also inspect cancellation",
            subagent_type: fork ? undefined : "general",
            task_id: started.metadata.sessionId,
          },
          context,
        )

        expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
        expect(result.metadata.background).toBe(true)
        expect(result.output).toContain("Background task updated")
        first.resolve()
        expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
        expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
          { type: "text", text: "also inspect cancellation" },
        ])

        second.resolve()
        const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
        expect(waited.info?.status).toBe("completed")
        expect(waited.info?.output).toBe("second done")
        const notification = yield* Effect.promise(() => injected.promise)
        expect(notification.variant).toBe("xhigh")
        expect(notification.parts[0]?.type).toBe("text")
        if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
      }),
    )
  }

  for (const fork of [false, true]) {
    background.instance(`background tasks complete through the background job service (fork=${fork})`, () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: fork ? undefined : "general",
            fork,
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps({ text: "background done" }), forkContext: forkContext() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
        expect(waited.timedOut).toBe(false)
        expect(waited.info?.status).toBe("completed")
        expect(waited.info?.output).toBe("background done")
      }),
    )
  }

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  for (const fork of [false, true]) {
    background.instance(`cancelling the parent run cancels running background tasks (fork=${fork})`, () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const runState = yield* SessionRunState.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: fork ? undefined : "general",
            fork,
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              forkContext: forkContext(),
              promptOps: {
                ...stubOps(),
                prompt: () => Effect.never,
              } satisfies TaskPromptOps,
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        yield* runState.cancel(chat.id)
        const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
        expect(waited.timedOut).toBe(false)
        expect(waited.info?.status).toBe("cancelled")
      }),
    )
  }

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      yield* runState.cancel(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )
})
