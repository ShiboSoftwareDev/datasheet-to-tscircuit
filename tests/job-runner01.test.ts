import { expect, test } from "bun:test"
import { buildAgentPrompt } from "@/server/job-runner"

test("agent prompt requires an implemented and build-verified TSX component", () => {
  const prompt = buildAgentPrompt("Use the QFN package")
  expect(prompt).toContain("datasheet.pdf")
  expect(prompt).toContain("Replace index.circuit.tsx")
  expect(prompt).toContain("tsci build")
  expect(prompt).toContain("Use the QFN package")
})
