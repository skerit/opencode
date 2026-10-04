import { jsonSchema, type ModelMessage, type Tool } from "ai"
import type { Provider } from "@/provider/provider"
import type { Tool as OpencodeTool } from "@/tool/tool"
import { isRecord } from "@/util/record"

// A symbol survives the object spreads that request preparation applies to tools.
const key = Symbol.for("opencode.freeform")

type Marked = Tool & { [key]?: OpencodeTool.Freeform }

export function mark<T extends Tool>(tool: T, freeform: OpencodeTool.Freeform): T {
  ;(tool as Marked)[key] = freeform
  return tool
}

export function freeform(tool: Tool | undefined) {
  return tool ? (tool as Marked)[key] : undefined
}

function isCustom(tool: Tool) {
  const value = tool as { type?: string; id?: string }
  return value.type === "provider" && value.id === "openai.custom"
}

/** Grammar-constrained custom tools exist only on OpenAI Responses models from GPT-5 on. */
export function supported(model: Provider.Model) {
  if (model.api.npm !== "@ai-sdk/openai") return false
  const match = /\bgpt-(\d+)/.exec(model.api.id)
  return match !== null && Number(match[1]) >= 5
}

/** Builds an OpenAI custom tool whose raw text input is validated into `{ [argument]: text }`. */
export function custom(
  name: string,
  description: string,
  spec: OpencodeTool.Freeform,
  execute: Tool["execute"],
): Tool {
  const tool = {
    type: "provider",
    id: "openai.custom",
    args: { name, description, format: { type: "grammar", syntax: spec.syntax, definition: spec.definition } },
    inputSchema: jsonSchema({ type: "string" }, {
      validate: (value) =>
        typeof value === "string"
          ? { success: true, value: { [spec.argument]: value } }
          : { success: false, error: new TypeError(`${name} expects raw text input`) },
    }),
    execute,
  } as unknown as Tool
  return mark(tool, spec)
}

/** Replaces marked function tools with custom tools when the model supports them; other tools pass through. */
export function apply(model: Provider.Model, tools: Record<string, Tool>): Record<string, Tool> {
  if (!supported(model)) return tools
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const spec = freeform(tool)
      if (!spec || isCustom(tool)) return [name, tool]
      return [name, custom(name, tool.description ?? "", spec, tool.execute)]
    }),
  )
}

/**
 * Restores raw text on replayed calls to custom tools.
 * Stored inputs are `{ [argument]: text }`, which the AI SDK would otherwise JSON-encode into the custom call input.
 */
export function unwrap(messages: ModelMessage[], tools: Record<string, Tool>): ModelMessage[] {
  const specs = new Map(
    Object.entries(tools).flatMap(([name, tool]) => {
      const spec = freeform(tool)
      return spec && isCustom(tool) ? [[name, spec] as const] : []
    }),
  )
  if (specs.size === 0) return messages
  return messages.map((message) => {
    if (message.role !== "assistant" || typeof message.content === "string") return message
    let changed = false
    const content = message.content.map((part) => {
      if (part.type !== "tool-call") return part
      const spec = specs.get(part.toolName)
      const input = part.input
      if (!spec || !isRecord(input) || typeof input[spec.argument] !== "string") return part
      changed = true
      return { ...part, input: input[spec.argument] }
    })
    return changed ? { ...message, content } : message
  })
}

export * as CustomTools from "./custom-tools"
