import type { JSONValue, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { jsonSchema, type Tool } from "ai"
import z from "zod"

// Tags are interpreted only in FilePart.data, never in arbitrary JSON payloads.
const binary = z
  .object({
    $fork: z.literal("bytes"),
    base64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
    size: z.number().int().nonnegative().safe(),
  })
  .strict()
  .refine((value) => {
    if (value.base64.length !== Math.ceil(value.size / 3) * 4) return false
    const bytes = Buffer.from(value.base64, "base64")
    return bytes.length === value.size && bytes.toString("base64") === value.base64
  }, "Invalid fork binary encoding")
const url = z
  .object({ $fork: z.literal("url"), href: z.string().url() })
  .strict()
  .refine(
    (value) => new URL(value.href).href === value.href && new URL(value.href).protocol !== "javascript:",
    "Invalid fork URL",
  )
const data = z.union([z.string(), binary, url])
const json: z.ZodType<JSONValue> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(z.string(), json)]),
)
const options = z.record(z.string(), z.record(z.string(), json))
const partOptions = { providerOptions: options.optional() }
const text = z.object({ type: z.literal("text"), text: z.string(), ...partOptions }).strict()
const mediaType = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:[ \t]*;[^\r\n]+)?$/)
const output = z.union([
  z.object({ type: z.enum(["text", "error-text"]), value: z.string(), ...partOptions }).strict(),
  z.object({ type: z.enum(["json", "error-json"]), value: json, ...partOptions }).strict(),
  z.object({ type: z.literal("execution-denied"), reason: z.string().optional(), ...partOptions }).strict(),
  z
    .object({
      type: z.literal("content"),
      value: z.array(
        z.union([
          text,
          z.object({ type: z.literal("image-data"), data: z.string(), mediaType, ...partOptions }).strict(),
          z
            .object({
              type: z.literal("file-data"),
              data: z.string(),
              mediaType,
              filename: z.string().optional(),
              ...partOptions,
            })
            .strict(),
          z.object({ type: z.enum(["image-url", "file-url"]), url: z.string(), ...partOptions }).strict(),
          z
            .object({
              type: z.enum(["image-file-id", "file-id"]),
              fileId: z.union([z.string(), z.record(z.string(), z.string())]),
              ...partOptions,
            })
            .strict(),
          z.object({ type: z.literal("custom"), ...partOptions }).strict(),
        ]),
      ),
      ...partOptions,
    })
    .strict(),
])
const reasoning = z.object({ type: z.literal("reasoning"), text: z.string(), ...partOptions }).strict()
const call = z
  .object({
    type: z.literal("tool-call"),
    toolCallId: z.string(),
    toolName: z.string(),
    input: json,
    providerExecuted: z.boolean().optional(),
    ...partOptions,
  })
  .strict()
const result = z
  .object({
    type: z.literal("tool-result"),
    toolCallId: z.string(),
    toolName: z.string(),
    output,
    ...partOptions,
  })
  .strict()
const file = z
  .object({
    type: z.literal("file"),
    data,
    mediaType,
    filename: z.string().optional(),
    ...partOptions,
  })
  .strict()
const prompt = z.array(
  z.union([
    z.object({ role: z.literal("system"), content: z.string(), ...partOptions }).strict(),
    z.object({ role: z.literal("user"), content: z.array(z.union([text, file])), ...partOptions }).strict(),
    z
      .object({
        role: z.literal("assistant"),
        content: z.array(z.union([text, reasoning, file, call, result])),
        ...partOptions,
      })
      .strict(),
    z.object({ role: z.literal("tool"), content: z.array(result), ...partOptions }).strict(),
  ]),
)
const definition = z
  .object({
    type: z.literal("function"),
    name: z.string(),
    description: z.string().optional(),
    inputSchema: z.record(z.string(), json),
    inputExamples: z.array(z.object({ input: z.record(z.string(), json) }).strict()).optional(),
    providerOptions: options.optional(),
    strict: z.boolean().optional(),
  })
  .strict()
const request = z
  .object({
    prompt,
    tools: z.array(definition).optional(),
    providerOptions: options.optional(),
    maxOutputTokens: z.number().finite().optional(),
    temperature: z.number().finite().optional(),
    topP: z.number().finite().optional(),
    topK: z.number().finite().optional(),
    presencePenalty: z.number().finite().optional(),
    frequencyPenalty: z.number().finite().optional(),
    stopSequences: z.array(z.string()).optional(),
    seed: z.number().finite().optional(),
    responseFormat: z
      .object({ type: z.literal("text") })
      .strict()
      .optional(),
  })
  .strict()
const identitySchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
  apiID: z.string(),
  npm: z.enum(["@ai-sdk/openai", "@ai-sdk/openai-compatible", "@ai-sdk/anthropic"]),
  agent: z.string(),
  variant: z.string().optional(),
  cacheSessionID: z.string().min(1).optional(),
})
const snapshotSchema = identitySchema.extend({ request }).strict()
const identityRecord = identitySchema.extend({ version: z.literal(1), firstUserMessageID: z.string().min(1) }).strict()
const envelope = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    firstUserMessageID: z.string().min(1),
    snapshot: snapshotSchema,
  })
  .strict()
const key = "opencode_fork_context"
const identityKey = "opencode_fork_identity"

export type Snapshot = z.infer<typeof snapshotSchema>
export type Identity = z.infer<typeof identitySchema>
export type Turn = { snapshot?: Snapshot }

function plain(value: unknown, seen = new Set<object>()): void {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number" && Number.isFinite(value)) return
  if (typeof value !== "object" || seen.has(value)) throw new Error("Unsupported fork snapshot value")
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error("Fork snapshots require plain JSON outside supported media fields")
  seen.add(value)
  Object.values(value).forEach((item) => plain(item, seen))
  seen.delete(value)
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

export function capture(
  model: Omit<Snapshot, "request" | "npm"> & { npm: string },
  params: LanguageModelV3CallOptions,
): Snapshot {
  const { headers, abortSignal, toolChoice, includeRawChunks, ...body } = params
  const encoded = {
    ...body,
    prompt: body.prompt.map((message) => {
      if (message.role === "system") return message
      if (Object.getPrototypeOf(message) !== Object.prototype && Object.getPrototypeOf(message) !== null)
        throw new Error("Unsupported fork message")
      return {
        ...message,
        content: message.content.map((part) => {
          if (part.type !== "file") return part
          if (Object.getPrototypeOf(part) !== Object.prototype && Object.getPrototypeOf(part) !== null)
            throw new Error("Unsupported fork file")
          const value = part.data
          if (typeof value === "string") return part
          if (value instanceof Uint8Array)
            return {
              ...part,
              data: { $fork: "bytes", base64: Buffer.from(value).toString("base64"), size: value.byteLength },
            }
          if (value instanceof URL) return { ...part, data: { $fork: "url", href: value.href } }
          throw new Error("Unsupported fork media data")
        }),
      }
    }),
  }
  plain(encoded)
  if (toolChoice && toolChoice.type !== "auto") throw new Error("Fork requires automatic tool choice")
  if (body.tools?.some((tool) => tool.type !== "function" || tool.name === "StructuredOutput"))
    throw new Error("Fork does not support provider-native tools or structured output")
  plain(model)
  return freeze(snapshotSchema.parse({ ...model, request: encoded }))
}

export function metadata(snapshot: Snapshot, firstUserMessageID: string): Record<string, unknown> {
  plain(snapshot)
  return JSON.parse(
    JSON.stringify({
      [key]: envelope.parse({ version: 2, snapshot, firstUserMessageID }),
      [identityKey]: { version: 1, firstUserMessageID, ...identitySchema.parse(snapshot) },
    }),
  )
}

export function read(metadata: Record<string, unknown> | undefined) {
  if (!metadata || !Object.hasOwn(metadata, key)) return undefined
  plain(metadata[key])
  const saved = envelope.parse(metadata[key])
  if (saved.version === 1) {
    for (const message of saved.snapshot.request.prompt) {
      if (message.role === "system") continue
      for (const part of message.content) {
        if (part.type === "file" && typeof part.data !== "string") throw new Error("Invalid v1 fork file")
        if (part.type === "tool-result" && !["text", "error-text", "json", "error-json"].includes(part.output.type))
          throw new Error("Invalid v1 fork output")
      }
    }
  }
  return freeze(saved)
}

export function clearMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata ?? {}).filter(([name]) => name !== key))
}

export function identity(metadata: Record<string, unknown> | undefined): Identity | undefined {
  const fork = read(metadata)
  if (fork) return freeze(identitySchema.parse(fork.snapshot))
  if (!metadata || !Object.hasOwn(metadata, identityKey)) return undefined
  plain(metadata[identityKey])
  return freeze(identitySchema.parse(identityRecord.parse(metadata[identityKey])))
}

export function remapMetadata(input: Record<string, unknown> | undefined, idMap: ReadonlyMap<string, string>) {
  const fork = read(input)
  const saved = input && Object.hasOwn(input, identityKey) ? identityRecord.parse(input[identityKey]) : undefined
  const cloned = structuredClone(input)
  const boundary = fork?.firstUserMessageID ?? saved?.firstUserMessageID
  if (!boundary || !cloned) return cloned
  const firstUserMessageID = idMap.get(boundary)
  delete cloned[key]
  delete cloned[identityKey]
  if (!firstUserMessageID) return cloned
  return {
    ...cloned,
    ...(fork ? metadata(fork.snapshot, firstUserMessageID) : { [identityKey]: { ...saved, firstUserMessageID } }),
  }
}

export function suffix<T extends { info: { id: string; role: string } }>(messages: T[], firstUserMessageID: string) {
  const index = messages.findIndex((message) => message.info.id === firstUserMessageID && message.info.role === "user")
  if (index < 0)
    throw new Error(
      "Fork history boundary is missing, possibly due to compaction; refusing to change the cached prefix",
    )
  return messages.slice(index)
}

export function tools(snapshot: Snapshot, bindings: Record<string, Tool>): Record<string, Tool> {
  return Object.fromEntries(
    (snapshot.request.tools ?? []).map((definition) => [
      definition.name,
      {
        description: definition.description,
        inputSchema: jsonSchema(definition.inputSchema),
        strict: definition.strict,
        async execute(args, options) {
          const binding = Object.hasOwn(bindings, definition.name) ? bindings[definition.name] : undefined
          if (!binding?.execute)
            throw new Error(`Fork tool is disabled or unavailable in the child: ${definition.name}`)
          return binding.execute(args, options)
        },
      } satisfies Tool,
    ]),
  )
}

export function inherit(snapshot: Snapshot, params: LanguageModelV3CallOptions): LanguageModelV3CallOptions {
  // Clone before SDK/provider code can mutate the authoritative snapshot.
  const body = structuredClone(snapshot.request)
  const decode = (part: z.infer<typeof file>) => ({
    ...part,
    data:
      typeof part.data === "string"
        ? part.data
        : part.data.$fork === "bytes"
          ? new Uint8Array(Buffer.from(part.data.base64, "base64"))
          : new URL(part.data.href),
  })
  const prompt: LanguageModelV3CallOptions["prompt"] = body.prompt.map((message) => {
    if (message.role === "system" || message.role === "tool") return message
    if (message.role === "user")
      return { ...message, content: message.content.map((part) => (part.type === "file" ? decode(part) : part)) }
    return { ...message, content: message.content.map((part) => (part.type === "file" ? decode(part) : part)) }
  })
  const suffix = params.prompt
  if (snapshot.npm === "@ai-sdk/anthropic") {
    // Historical child metadata must not consume additional cache breakpoints either.
    for (const message of suffix) {
      const nodes = [message, ...(Array.isArray(message.content) ? message.content : [])]
      for (const node of nodes) {
        node.providerOptions = Object.fromEntries(
          Object.entries(node.providerOptions ?? {}).map(([key, value]) => [key, { ...value }]),
        )
        for (const provider of Object.values(node.providerOptions)) {
          delete provider.cacheControl
          delete provider.cache_control
        }
      }
    }
  }
  return {
    ...body,
    prompt: [...prompt, ...suffix],
    headers: params.headers,
    abortSignal: params.abortSignal,
    toolChoice: params.toolChoice,
    includeRawChunks: params.includeRawChunks,
  }
}

export * as ForkContext from "./fork"
