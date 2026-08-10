import { expect, test } from "bun:test"
import { isTransientAgentTransportFailure } from "@/server/infrastructure/agent/transport-failure"

test("an incomplete provider response stream is retried as a transport failure", () => {
  expect(
    isTransientAgentTransportFailure(
      "tsci-agent: OpenAI Responses stream ended before a terminal response event",
    ),
  ).toBe(true)
})

test("artifact and tool failures are not mistaken for transport failures", () => {
  expect(isTransientAgentTransportFailure("model-reference-observation.json is missing")).toBe(false)
  expect(isTransientAgentTransportFailure("tsci simulate analog exited with code 1")).toBe(false)
})
