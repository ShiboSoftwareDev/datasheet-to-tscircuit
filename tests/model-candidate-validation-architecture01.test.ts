import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import ts from "typescript"

const stage_files = ["validate-model.ts", "repair-model.ts"] as const

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

test("initial and repaired candidates use the same authoritative validation service", async () => {
  for (const file_name of stage_files) {
    const path = join(import.meta.dir, "../src/server/model-workflow/stages", file_name)
    const source = await readFile(path, "utf8")
    const source_file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
    const candidate_validation_imports = source_file.statements.flatMap((statement) => {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== "../candidate-validation"
      ) {
        return []
      }
      const bindings = statement.importClause?.namedBindings
      return bindings && ts.isNamedImports(bindings) ? bindings.elements.map(({ name }) => name.text) : []
    })
    const calls = calledIdentifiers(source_file)

    expect(candidate_validation_imports).toEqual(["validateCandidate"])
    expect(calls.filter((name) => name === "validateCandidate")).toHaveLength(1)
    for (const implementation_detail of [
      "runSpiceValidation",
      "checkCandidateStimulusCausality",
      "attachStimulusCausalityCheck",
      "buildValidationCircuitPreviews",
      "persistCandidateValidationUi",
      "projectCandidateValidationUi",
      "classifyValidationInfrastructureFailure",
    ]) {
      expect(calls).not.toContain(implementation_detail)
    }
  }
})
