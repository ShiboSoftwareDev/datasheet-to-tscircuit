import { readFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import type { ModelManifest } from "@/shared/job-types"
import { writeServerIntegratedComponent } from "./attach-model-to-generated-component"
import { getStubComponentPins } from "./get-benchmark-application-plan"
import type { ModelExecution } from "./model-execution"

function getFallbackEntryName(value: string | undefined): string {
  const normalized = (value ?? "UNVERIFIED_COMPONENT")
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^[^A-Za-z_]+/, "")
  return normalized || "UNVERIFIED_COMPONENT"
}

export async function createUnverifiedFallbackModel(execution: ModelExecution): Promise<{
  model_source: string
  manifest: ModelManifest
  model_card: string
}> {
  const job = execution.context.job_store.getJob(execution.model_run.job_id)
  const component_source =
    (await readFile(join(execution.model_dir, "component.circuit.tsx"), "utf8").catch(() => undefined)) ??
    job?.component_code ??
    ""
  const pins = getStubComponentPins({
    component_circuit_json: job?.circuit_json,
    component_source,
  })
  const source_component = job?.circuit_json?.find(
    (element) => element.type === "source_component",
  ) as unknown as Record<string, unknown> | undefined
  const part_number =
    typeof source_component?.manufacturer_part_number === "string"
      ? source_component.manufacturer_part_number
      : typeof source_component?.name === "string"
        ? source_component.name
        : "UNVERIFIED_COMPONENT"
  const entry_name = getFallbackEntryName(part_number)
  const candidate_paths = [
    join(execution.model_dir, "model.lib"),
    ...(await readdir(join(execution.model_dir, "candidates"), { recursive: true })
      .then((entries) =>
        entries
          .filter((entry) => entry.endsWith("model.lib"))
          .map((entry) => join(execution.model_dir, "candidates", entry)),
      )
      .catch(() => [])),
  ]
  const candidate_sources = await Promise.all(
    candidate_paths.map(async (path) => ({
      source: await readFile(path, "utf8").catch(() => undefined),
      modified_at: (await stat(path).catch(() => undefined))?.mtimeMs ?? 0,
    })),
  )
  candidate_sources.sort((left, right) => right.modified_at - left.modified_at)
  const recovered_candidate = candidate_sources
    .filter((candidate): candidate is { source: string; modified_at: number } =>
      Boolean(candidate.source?.trim()),
    )
    .map((candidate) => {
      const subcircuit = candidate.source.match(/^\s*\.subckt\s+(\S+)\s+([^\r\n]+)/im)
      const spice_nodes = subcircuit?.[2]
        ?.trim()
        .split(/\s+/)
        .filter((node) => !/^params?:/i.test(node))
      return subcircuit?.[1] && spice_nodes?.length === pins.length
        ? { source: candidate.source, entry_name: subcircuit[1], spice_nodes }
        : undefined
    })
    .find((candidate) => candidate !== undefined)
  const selected_entry_name = recovered_candidate?.entry_name ?? entry_name
  const selected_pins = recovered_candidate
    ? pins.map((pin, index) => ({ ...pin, spice_node: recovered_candidate.spice_nodes[index]! }))
    : pins
  const model_source =
    recovered_candidate?.source ??
    [
      `* UNVERIFIED high-impedance fallback for ${part_number}`,
      `* This preserves a parseable output when model extraction or validation cannot finish.`,
      `.SUBCKT ${entry_name} ${pins.map((pin) => pin.spice_node).join(" ")}`,
      ...pins.map((pin, index) => `RFALLBACK${index + 1} ${pin.spice_node} 0 1G`),
      `.ENDS ${entry_name}`,
      "",
    ].join("\n")
  const manifest: ModelManifest = {
    version: 1,
    part_number,
    dialect: "portable",
    entry_name: selected_entry_name,
    model_file: "model.lib",
    revision: recovered_candidate ? "candidate-unverified" : "fallback-unverified",
    simulator: "ngspice",
    generated_at: new Date().toISOString(),
    pins: selected_pins,
  }
  const model_card = `# ${part_number} fallback SPICE model

> Warning: this is an unverified recovery output. ${
    recovered_candidate
      ? "It preserves the latest parseable candidate model"
      : "It is an automatically generated high-impedance fallback that preserves pin mapping but does not model the component's electrical behavior"
  }, and it has not passed benchmark validation.

Use this output only as a visible recovery artifact. Add effort or retry the model workflow before simulation or production decisions.
`
  await Promise.all([
    Bun.write(join(execution.model_dir, "model.lib"), model_source),
    Bun.write(join(execution.model_dir, "model-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    Bun.write(join(execution.model_dir, "model-card.md"), model_card),
  ])
  await writeServerIntegratedComponent({
    model_dir: execution.model_dir,
    manifest,
    model_source,
  })
  return { model_source, manifest, model_card }
}
