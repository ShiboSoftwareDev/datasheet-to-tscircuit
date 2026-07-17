#!/usr/bin/env bun

import { cp, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { runPromptInSandbox } from "tsci-agent/lib"
import { AGENT_EVENT_PROTOCOL, type TrustedAgentEventPayload } from "./agent-event-protocol"

function readOption(args: string[], name: string): string {
  const index = args.indexOf(name)
  const value = index < 0 ? undefined : args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const text = content
    .flatMap((block) =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n")
    .trim()
  return text ? text.slice(0, 4_000) : undefined
}

function contentHasImage(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (block) => typeof block === "object" && block !== null && "type" in block && block.type === "image",
    )
  )
}

async function copySandboxBack(sandbox_dir: string, original_dir: string): Promise<void> {
  for (const entry of await readdir(sandbox_dir, { withFileTypes: true })) {
    await cp(join(sandbox_dir, entry.name), join(original_dir, entry.name), {
      recursive: entry.isDirectory(),
      force: true,
    })
  }
}

const args = process.argv.slice(2)
if (args[0] !== "do") throw new Error("structured-agent-runner only supports the do command")
const prompt = readOption(args, "--prompt")
const dir = resolve(readOption(args, "--dir"))
let sequence = 0

function emit(event: TrustedAgentEventPayload): void {
  process.stdout.write(
    `${JSON.stringify({ protocol: AGENT_EVENT_PROTOCOL, sequence: ++sequence, ...event })}\n`,
  )
}

await using result = await runPromptInSandbox(prompt, {
  dir,
  onEvent(event) {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent
      if (update?.type === "text_delta" && update.delta) {
        emit({ type: "text_delta", text: update.delta })
      } else if (update?.type === "thinking_delta" && update.delta) {
        emit({ type: "thinking_delta", text: update.delta })
      }
      return
    }
    if (event.type === "tool_execution_start") {
      emit({
        type: "tool_start",
        tool_call_id: event.toolCallId,
        tool_name: event.toolName,
        args: event.args,
      })
      return
    }
    if (event.type === "tool_execution_end") {
      emit({
        type: "tool_end",
        tool_call_id: event.toolCallId,
        tool_name: event.toolName,
        is_error: event.isError,
        result_has_image: contentHasImage(event.result.content),
        result_text: contentText(event.result.content),
      })
      return
    }
    if (event.type === "agent_end") {
      emit({
        type: "agent_end",
        failed: event.messages.some(
          (message) => message.role === "assistant" && message.stopReason === "error",
        ),
      })
    }
  },
})

await copySandboxBack(result.sandboxDir, result.originalDir)
