import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { isCircuitJson } from "../component-circuit-json"
import { parseComponentEvidence } from "../component-evidence"
import { createModelInterface } from "./model-interface"
import { parseModelContract } from "./parse-model-contract"
import type { ModelContract, ModelInterface } from "./types"

const MODEL_WORKSPACE_GUIDE = `# SPICE model workspace

This workspace is controlled by the server pipeline.

- Read only the inputs named by the current prompt.
- Write only the declared output artifacts for the current stage.
- Never modify model-interface.json, model-contract.json, validation-plan.json,
  component.circuit.tsx, component-evidence.json, or datasheet.pdf.
- Validation plans are declarative JSON. Never create raw .cir or .measure files.
- The server compiles fixtures, runs ngspice, records hashes, and owns pass/fail.
- model.lib must expose exactly one public subcircuit with the exact server-owned
  entry and pin order. Self-contained private helpers are allowed. model-card.md
  must state supported behavior and limits.
- Do not claim that an artifact is validated; only server results can do that.
`

async function copyCanonical(source: string, destination: string): Promise<void> {
  const bytes = await readFile(source)
  await Bun.write(destination, bytes)
}

export async function prepareModelWorkspace(input: {
  job_dir: string
  model_dir: string
}): Promise<ModelInterface> {
  await mkdir(input.model_dir, { recursive: true })
  const evidence_text = await readFile(join(input.job_dir, "component-evidence.json"), "utf8")
  const evidence = parseComponentEvidence(JSON.parse(evidence_text))
  const component_circuit_json: unknown = JSON.parse(
    await readFile(join(input.job_dir, "component.circuit.json"), "utf8"),
  )
  if (!isCircuitJson(component_circuit_json)) {
    throw new Error("component.circuit.json must contain validated Circuit JSON")
  }
  const model_interface = createModelInterface(evidence, component_circuit_json)
  const preserved_component = join(input.job_dir, "component.circuit.tsx")
  const component_source = (await Bun.file(preserved_component).exists())
    ? preserved_component
    : join(input.job_dir, "index.circuit.tsx")
  await Promise.all([
    copyCanonical(join(input.job_dir, "datasheet.pdf"), join(input.model_dir, "datasheet.pdf")),
    copyCanonical(component_source, join(input.model_dir, "component.circuit.tsx")),
    Bun.write(join(input.model_dir, "component-evidence.json"), evidence_text),
    Bun.write(
      join(input.model_dir, "component.circuit.json"),
      `${JSON.stringify(component_circuit_json, null, 2)}\n`,
    ),
    Bun.write(join(input.model_dir, "model-interface.json"), `${JSON.stringify(model_interface, null, 2)}\n`),
    Bun.write(join(input.model_dir, "AGENTS.md"), MODEL_WORKSPACE_GUIDE),
    mkdir(join(input.model_dir, "evidence"), { recursive: true }),
    mkdir(join(input.model_dir, "validation"), { recursive: true }),
    ...[
      "package.json",
      "tsconfig.json",
      "tscircuit.config.json",
      "tscircuit.config.ts",
      "typical-application-plan.json",
      "typical-application.circuit.tsx",
    ].map(async (file_name) => {
      const source = join(input.job_dir, file_name)
      if (await Bun.file(source).exists()) {
        await copyCanonical(source, join(input.model_dir, file_name))
      }
    }),
  ])
  return model_interface
}

export async function writeModelContract(model_dir: string, contract: ModelContract): Promise<void> {
  await Bun.write(join(model_dir, "model-contract.json"), `${JSON.stringify(contract, null, 2)}\n`)
}

export async function readModelContract(model_dir: string): Promise<ModelContract> {
  const value: unknown = JSON.parse(await readFile(join(model_dir, "model-contract.json"), "utf8"))
  return parseModelContract(value)
}
