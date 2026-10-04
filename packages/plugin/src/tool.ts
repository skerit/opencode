import { z } from "zod"

export type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  /**
   * Current project directory for this session.
   * Prefer this over process.cwd() when resolving relative paths.
   */
  directory: string
  /**
   * Project worktree root for this session.
   * Useful for generating stable relative paths (e.g. path.relative(worktree, absPath)).
   */
  worktree: string
  abort: AbortSignal
  metadata(input: { title?: string; metadata?: { [key: string]: any } }): void
  ask(input: AskInput): Promise<void>
}

type AskInput = {
  permission: string
  patterns: string[]
  always: string[]
  metadata: { [key: string]: any }
}

export type ToolAttachment = {
  type: "file"
  mime: string
  url: string
  filename?: string
}

export type ToolResult =
  | string
  | {
      title?: string
      output: string
      metadata?: { [key: string]: any }
      attachments?: ToolAttachment[]
    }

/**
 * Raw-text input for providers with grammar-constrained custom tools (OpenAI Responses GPT-5 and later).
 * Elsewhere the tool stays a JSON function tool; either way the text arrives as `args[argument]`.
 */
export type ToolFreeform = {
  /** Name of the string argument that receives the raw text. */
  argument: string
  syntax: "lark" | "regex"
  definition: string
}

export function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
  freeform?: ToolFreeform
}) {
  return input
}
tool.schema = z

export type ToolDefinition = ReturnType<typeof tool>
