import { afterAll, expect, test } from "bun:test"
import type { LanguageModelV3CallOptions, LanguageModelV3ToolResultOutput } from "@ai-sdk/provider"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createAnthropic } from "@ai-sdk/anthropic"
import { ForkContext } from "@/session/llm/fork"

const identity = { providerID: "test", modelID: "test", apiID: "test", npm: "@ai-sdk/openai", agent: "test" } as const
const image = "iVBORw0KGgo="
const href = "https://example.com/image.png?size=original#image"
const collision = { $fork: "bytes", base64: "not a codec value", size: -1 }
const servers: ReturnType<typeof Bun.serve>[] = []
afterAll(() => servers.forEach((server) => server.stop(true)))

test("media snapshots persist exact views and URLs, isolate replays, and remap nested forks", () => {
  const bytes = Buffer.from([99, 1, 2, 3, 88])
  const source = new URL(href)
  const params: LanguageModelV3CallOptions = {
    prompt: [
      {
        role: "user",
        content: [
          { type: "file", data: bytes.subarray(1, 4), mediaType: "image/png", filename: "original.png" },
          { type: "file", data: source, mediaType: "image/*" },
          { type: "text", text: "after images", providerOptions: { plugin: { collision } } },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "file", data: new Uint8Array([]), mediaType: "application/octet-stream" },
          { type: "reasoning", text: "signed", providerOptions: { anthropic: { signature: "unchanged" } } },
          { type: "tool-call", toolCallId: "call", toolName: "read", input: collision },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call", toolName: "read", output: { type: "json", value: collision } },
        ],
      },
    ],
    providerOptions: { openai: { promptCacheKey: "root", collision } },
    tools: [
      {
        type: "function",
        name: "read",
        inputSchema: { type: "object" },
        inputExamples: [{ input: collision }],
        providerOptions: { plugin: { collision } },
      },
    ],
  }
  const snapshot = ForkContext.capture(identity, params)
  expect(bytes).toEqual(Buffer.from([99, 1, 2, 3, 88]))
  expect(source.href).toBe(href)
  const metadata = JSON.parse(JSON.stringify(ForkContext.metadata(snapshot, "child")))
  expect(metadata.opencode_fork_context.version).toBe(2)
  const restored = ForkContext.read(metadata)
  if (!restored) throw new Error("Missing persisted snapshot")
  const replay = ForkContext.inherit(restored.snapshot, { prompt: [] })
  expect(replay.prompt).toEqual(params.prompt)
  expect(replay.tools).toEqual(params.tools)
  expect(replay.providerOptions).toEqual(params.providerOptions)
  bytes.fill(0)
  source.pathname = "/changed"
  const first = replay.prompt[0]
  if (first.role !== "user") throw new Error("Missing user")
  const binary = first.content[0]
  const url = first.content[1]
  if (binary.type !== "file" || !(binary.data instanceof Uint8Array)) throw new Error("Missing bytes")
  if (url.type !== "file" || !(url.data instanceof URL)) throw new Error("Missing URL")
  binary.data.fill(8)
  url.data.pathname = "/mutated"
  const nested = ForkContext.capture(
    identity,
    ForkContext.inherit(restored.snapshot, { prompt: [{ role: "user", content: [{ type: "text", text: "nested" }] }] }),
  )
  expect(nested.request.prompt.slice(0, snapshot.request.prompt.length)).toEqual(snapshot.request.prompt)
  expect(Object.isFrozen(restored.snapshot.request.prompt[0])).toBe(true)
  expect(ForkContext.read(ForkContext.remapMetadata(metadata, new Map([["child", "clone"]])))?.firstUserMessageID).toBe(
    "clone",
  )
  expect(JSON.stringify(restored.snapshot)).toBe(JSON.stringify(snapshot))
})

test("v1 local records replay without interpreting tag-shaped JSON and migrate on write", () => {
  const snapshot = ForkContext.capture(identity, {
    prompt: [{ role: "user", content: [{ type: "file", data: image, mediaType: "image/png" }] }],
    providerOptions: { plugin: { collision } },
  })
  const record = { opencode_fork_context: { version: 1, firstUserMessageID: "old", snapshot } }
  const restored = ForkContext.read(JSON.parse(JSON.stringify(record)))
  if (!restored) throw new Error("Missing v1 snapshot")
  expect(restored.version).toBe(1)
  expect(ForkContext.inherit(restored.snapshot, { prompt: [] }).providerOptions).toEqual(
    snapshot.request.providerOptions,
  )
  expect(ForkContext.read(ForkContext.metadata(restored.snapshot, "new"))?.version).toBe(2)
})

test("strict media validation rejects corrupt tags, MIME, unsupported objects and output shapes", () => {
  for (const data of [
    { $fork: "bytes", base64: "AQ==", size: 2 },
    { $fork: "bytes", base64: "AR==", size: 1 },
    { $fork: "bytes", base64: "AQ", size: 1 },
    { $fork: "bytes", base64: "", size: -1 },
    { $fork: "bytes", base64: "", size: 0, extra: true },
    { $fork: "url", href: "javascript:alert(1)" },
    { $fork: "url", href: "not a URL" },
    { $fork: "unknown", href },
  ]) {
    expect(() =>
      ForkContext.read({
        opencode_fork_context: {
          version: 2,
          firstUserMessageID: "first",
          snapshot: {
            ...identity,
            request: { prompt: [{ role: "user", content: [{ type: "file", data, mediaType: "image/png" }] }] },
          },
        },
      }),
    ).toThrow()
  }
  for (const data of [new Date(), new Uint16Array([1]), new URL("javascript:alert(1)"), collision]) {
    expect(() =>
      ForkContext.capture(identity, {
        prompt: [{ role: "user", content: [{ type: "file", data: data as never, mediaType: "image/png" }] }],
      }),
    ).toThrow()
  }
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  for (const value of [cycle, () => 1, new Date()]) {
    expect(() =>
      ForkContext.capture(identity, { prompt: [], providerOptions: { plugin: { value: value as never } } }),
    ).toThrow()
  }
  expect(() =>
    ForkContext.capture(identity, {
      prompt: [{ role: "user", content: [{ type: "file", data: image, mediaType: "bad\r\nimage/png" }] }],
    }),
  ).toThrow()
  expect(() =>
    ForkContext.capture(identity, {
      prompt: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c",
              toolName: "read",
              output: { type: "content", value: [{ type: "unknown" }] } as never,
            },
          ],
        },
      ],
    }),
  ).toThrow()
  const binary = ForkContext.capture(identity, {
    prompt: [{ role: "user", content: [{ type: "file", data: new Uint8Array([1]), mediaType: "image/png" }] }],
  })
  expect(() =>
    ForkContext.read({ opencode_fork_context: { version: 1, firstUserMessageID: "first", snapshot: binary } }),
  ).toThrow("v1")
})

test("all installed V3 tool-content variants survive JSON persistence unchanged", () => {
  const output: LanguageModelV3ToolResultOutput = {
    type: "content",
    value: [
      { type: "image-data", data: image, mediaType: "image/png" },
      { type: "image-url", url: href },
      { type: "file-data", data: "AA==", mediaType: "application/pdf", filename: "exact.pdf" },
      { type: "file-url", url: href },
      { type: "file-id", fileId: { openai: "file-1" } },
      { type: "image-file-id", fileId: "file-2" },
      { type: "custom", providerOptions: { plugin: { collision } } },
      { type: "text", text: "after media" },
    ],
  }
  const params: LanguageModelV3CallOptions = {
    prompt: [{ role: "tool", content: [{ type: "tool-result", toolCallId: "c", toolName: "read", output }] }],
  }
  const saved = ForkContext.read(
    JSON.parse(JSON.stringify(ForkContext.metadata(ForkContext.capture(identity, params), "first"))),
  )
  if (!saved) throw new Error("Missing tool-content snapshot")
  expect(ForkContext.inherit(saved.snapshot, { prompt: [] }).prompt).toEqual(params.prompt)
})

test("multi-megabyte binary views round trip without resizing or truncation", () => {
  const bytes = new Uint8Array(2 * 1024 * 1024 + 2).fill(173).subarray(1, -1)
  const original = ForkContext.capture(identity, {
    prompt: [{ role: "user", content: [{ type: "file", data: bytes, mediaType: "image/png" }] }],
  })
  const saved = ForkContext.read(JSON.parse(JSON.stringify(ForkContext.metadata(original, "first"))))
  if (!saved) throw new Error("Missing large snapshot")
  expect(ForkContext.inherit(saved.snapshot, { prompt: [] }).prompt).toEqual([
    { role: "user", content: [{ type: "file", data: bytes, mediaType: "image/png" }] },
  ])
})

for (const npm of ["@ai-sdk/openai", "@ai-sdk/openai-compatible", "@ai-sdk/anthropic"] as const) {
  test(`${npm}: actual wire media prefix is identical after persistence and nested replay`, async () => {
    const bodies: Record<string, unknown>[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        bodies.push(await request.json())
        return new Response("", { headers: { "content-type": "text/event-stream" } })
      },
    })
    servers.push(server)
    const options = { apiKey: "test", baseURL: `${server.url.origin}/v1` }
    const model =
      npm === "@ai-sdk/openai"
        ? createOpenAI(options).responses("gpt-4.1")
        : npm === "@ai-sdk/anthropic"
          ? createAnthropic(options)("claude-sonnet-4-20250514")
          : createOpenAICompatible({ ...options, name: "test" })("test")
    const params: LanguageModelV3CallOptions = {
      prompt: [
        {
          role: "user",
          content: [
            { type: "file", data: new Uint8Array(Buffer.from(image, "base64")), mediaType: "image/png" },
            { type: "file", data: new URL(href), mediaType: "image/png" },
            { type: "text", text: "after images" },
          ],
        },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "call", toolName: "read", input: {} }] },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call",
              toolName: "read",
              output: {
                type: "content",
                value: [
                  { type: "image-data", data: image, mediaType: "image/png" },
                  { type: "image-url", url: href },
                  { type: "text", text: "tool text" },
                ],
              },
            },
          ],
        },
        { role: "user", content: [{ type: "text", text: "final parent" }] },
      ],
      tools: [{ type: "function", name: "read", inputSchema: { type: "object" } }],
    }
    await (await model.doStream(params)).stream.cancel()
    const saved = ForkContext.read(
      JSON.parse(JSON.stringify(ForkContext.metadata(ForkContext.capture({ ...identity, npm }, params), "first"))),
    )
    if (!saved) throw new Error("Missing parent snapshot")
    const child = ForkContext.inherit(saved.snapshot, {
      prompt: [{ role: "user", content: [{ type: "text", text: "child" }] }],
    })
    await (await model.doStream(child)).stream.cancel()
    const nested = ForkContext.read(
      JSON.parse(JSON.stringify(ForkContext.metadata(ForkContext.capture({ ...identity, npm }, child), "nested"))),
    )
    if (!nested) throw new Error("Missing nested snapshot")
    await (await model.doStream(ForkContext.inherit(nested.snapshot, { prompt: [] }))).stream.cancel()
    const blocks = (body: Record<string, unknown>) => {
      if (npm === "@ai-sdk/openai") return body.input as unknown[]
      if (npm === "@ai-sdk/openai-compatible") return body.messages as unknown[]
      return (body.messages as { role: string; content: unknown[] }[]).flatMap((message) =>
        message.content.map((content) => ({ role: message.role, content })),
      )
    }
    expect(bodies).toHaveLength(3)
    expect(JSON.stringify(bodies[0])).toContain(image)
    expect(JSON.stringify(bodies[0])).toContain(href)
    if (npm === "@ai-sdk/openai") {
      expect(bodies[0].input).toEqual(
        expect.arrayContaining([
          {
            type: "function_call_output",
            call_id: "call",
            output: [
              { type: "input_image", image_url: `data:image/png;base64,${image}` },
              { type: "input_image", image_url: href },
              { type: "input_text", text: "tool text" },
            ],
          },
        ]),
      )
    }
    if (npm === "@ai-sdk/anthropic") {
      expect(blocks(bodies[0])).toEqual(
        expect.arrayContaining([
          {
            role: "user",
            content: expect.objectContaining({
              type: "tool_result",
              tool_use_id: "call",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/png", data: image } },
                { type: "image", source: { type: "url", url: href } },
                { type: "text", text: "tool text" },
              ],
            }),
          },
        ]),
      )
    }
    for (const body of bodies.slice(1)) {
      expect(blocks(body).slice(0, blocks(bodies[0]).length)).toEqual(blocks(bodies[0]))
      expect(body.tools).toEqual(bodies[0].tools)
    }
  })
}
