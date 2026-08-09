import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import ts from "typescript"

function calledIdentifiers(source_file: ts.SourceFile): string[] {
  const calls: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      calls.push(node.expression.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source_file)
  return calls
}

async function stageCalls(file_name: string): Promise<string[]> {
  const path = join(import.meta.dir, "../src/server/model-workflow/stages", file_name)
  const source = await readFile(path, "utf8")
  return calledIdentifiers(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true))
}

test("simulation execution, comparison, and repair retain separate authoritative boundaries", async () => {
  const run_calls = await stageCalls("validate-model.ts")
  expect(run_calls).toContain("runValidationCircuitSimulations")
  expect(run_calls).toContain("writeTscircuitSimulationArtifacts")
  for (const comparison_detail of [
    "validateCandidate",
    "runSpiceValidation",
    "compareValidationCircuitSimulations",
    "persistCandidateValidationUi",
    "projectCandidateValidationUi",
    "createModelRepairFeedback",
  ]) {
    expect(run_calls).not.toContain(comparison_detail)
  }

  const comparison_calls = await stageCalls("compare-simulation-outputs.ts")
  expect(comparison_calls).toContain("readTscircuitSimulationArtifacts")
  expect(comparison_calls).toContain("compareValidationCircuitSimulations")
  expect(comparison_calls).not.toContain("runValidationCircuitSimulations")
  expect(comparison_calls).not.toContain("runSpiceValidation")
  expect(comparison_calls).not.toContain("validateCandidate")
  expect(comparison_calls).not.toContain("createModelRepairFeedback")

  const repair_calls = await stageCalls("repair-model.ts")
  expect(repair_calls.filter((name) => name === "validateCandidate")).toHaveLength(1)
  expect(repair_calls).toContain("createModelRepairFeedback")
  expect(repair_calls).toContain("projectCandidateValidationUi")
  for (const implementation_detail of [
    "runSpiceValidation",
    "checkCandidateStimulusCausality",
    "attachStimulusCausalityCheck",
    "buildValidationCircuitPreviews",
    "persistCandidateValidationUi",
    "classifyValidationInfrastructureFailure",
  ]) {
    expect(repair_calls).not.toContain(implementation_detail)
  }
})
