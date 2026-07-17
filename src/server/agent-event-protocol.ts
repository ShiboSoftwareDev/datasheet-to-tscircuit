export const AGENT_EVENT_PROTOCOL = "tsci-agent-event-v1"

export type TrustedAgentEvent =
  | {
      protocol: typeof AGENT_EVENT_PROTOCOL
      sequence: number
      type: "text_delta"
      text: string
    }
  | {
      protocol: typeof AGENT_EVENT_PROTOCOL
      sequence: number
      type: "thinking_delta"
      text: string
    }
  | {
      protocol: typeof AGENT_EVENT_PROTOCOL
      sequence: number
      type: "tool_start"
      tool_call_id: string
      tool_name: string
      args: unknown
    }
  | {
      protocol: typeof AGENT_EVENT_PROTOCOL
      sequence: number
      type: "tool_end"
      tool_call_id: string
      tool_name: string
      is_error: boolean
      result_has_image: boolean
      result_text?: string
    }
  | {
      protocol: typeof AGENT_EVENT_PROTOCOL
      sequence: number
      type: "agent_end"
      failed: boolean
    }

export type TrustedAgentEventPayload = TrustedAgentEvent extends infer Event
  ? Event extends TrustedAgentEvent
    ? Omit<Event, "protocol" | "sequence">
    : never
  : never

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseTrustedAgentEvent(line: string): TrustedAgentEvent | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (
    !isRecord(value) ||
    value.protocol !== AGENT_EVENT_PROTOCOL ||
    !Number.isInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    typeof value.type !== "string"
  ) {
    return undefined
  }
  if (value.type === "text_delta" || value.type === "thinking_delta") {
    return typeof value.text === "string" ? (value as TrustedAgentEvent) : undefined
  }
  if (value.type === "tool_start") {
    return typeof value.tool_call_id === "string" && typeof value.tool_name === "string"
      ? (value as TrustedAgentEvent)
      : undefined
  }
  if (value.type === "tool_end") {
    return typeof value.tool_call_id === "string" &&
      typeof value.tool_name === "string" &&
      typeof value.is_error === "boolean" &&
      typeof value.result_has_image === "boolean" &&
      (value.result_text === undefined || typeof value.result_text === "string")
      ? (value as TrustedAgentEvent)
      : undefined
  }
  if (value.type === "agent_end") {
    return typeof value.failed === "boolean" ? (value as TrustedAgentEvent) : undefined
  }
  return undefined
}
