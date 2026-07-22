import { resolve } from "node:path"
import { runPromptInSandbox } from "tsci-agent/lib"
import { agentContentHasImage } from "./agent-content-has-image"
import { copyAgentSandboxBack } from "./copy-agent-sandbox-back"
import { emitTrustedAgentEvent, type TrustedAgentEventEmitter } from "./emit-trusted-agent-event"
import { getAgentContentText } from "./get-agent-content-text"
import { readCliOption } from "./read-cli-option"

export async function runStructuredAgentCommand(args: string[]): Promise<void> {
  if (args[0] !== "do") throw new Error("structured-agent-runner only supports the do command")
  const use_openai = args.includes("--use-openai")
  const prompt = readCliOption(args, "--prompt")
  const directory = resolve(readCliOption(args, "--dir"))
  const emitter: TrustedAgentEventEmitter = { sequence: 0 }

  await using result = await runPromptInSandbox(prompt, {
    dir: directory,
    piArgs: use_openai ? ["--model", "openai-codex/gpt-5.6-terra"] : undefined,
    onEvent(event) {
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent
        if (update?.type === "text_delta" && update.delta) {
          emitTrustedAgentEvent({ type: "text_delta", text: update.delta }, emitter)
        } else if (update?.type === "thinking_delta" && update.delta) {
          emitTrustedAgentEvent({ type: "thinking_delta", text: update.delta }, emitter)
        }
        return
      }
      if (event.type === "tool_execution_start") {
        emitTrustedAgentEvent(
          {
            type: "tool_start",
            tool_call_id: event.toolCallId,
            tool_name: event.toolName,
            args: event.args,
          },
          emitter,
        )
        return
      }
      if (event.type === "tool_execution_end") {
        emitTrustedAgentEvent(
          {
            type: "tool_end",
            tool_call_id: event.toolCallId,
            tool_name: event.toolName,
            is_error: event.isError,
            result_has_image: agentContentHasImage(event.result.content),
            result_text: getAgentContentText(event.result.content),
          },
          emitter,
        )
        return
      }
      if (event.type === "agent_end") {
        emitTrustedAgentEvent(
          {
            type: "agent_end",
            failed: event.messages.some(
              (message) => message.role === "assistant" && message.stopReason === "error",
            ),
          },
          emitter,
        )
      }
    },
  })

  await copyAgentSandboxBack({
    sandboxDirectory: result.sandboxDir,
    originalDirectory: result.originalDir,
  })
}
