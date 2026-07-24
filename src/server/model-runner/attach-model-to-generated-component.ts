import { copyFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ModelManifest } from "@/shared/job-types"
import { isCircuitJson, selectPreferredComponentCircuitJson } from "../component-circuit-json"
import type { JobStore } from "../job-store"

export { isCircuitJson } from "../component-circuit-json"

export function selectPublishedComponentCircuitJson(input: {
  existing: unknown
  integrated: unknown
  recovered?: unknown[]
}): import("circuit-json").AnyCircuitElement[] | undefined {
  return selectPreferredComponentCircuitJson(input.integrated, input.existing, ...(input.recovered ?? []))
}

export async function attachModelToGeneratedComponent(input: {
  job_id: string
  job_dir: string
  model_dir: string
  job_store: JobStore
}): Promise<void> {
  const integrated_component = join(input.model_dir, "component-with-model.circuit.tsx")
  const original_component = join(input.model_dir, "component.circuit.tsx")
  await Promise.all([
    copyFile(integrated_component, join(input.job_dir, "index.circuit.tsx")),
    copyFile(original_component, join(input.job_dir, "component.circuit.tsx")),
    copyFile(join(input.model_dir, "model.lib"), join(input.job_dir, "model.lib")),
  ])
  const [component_code, circuit_json_value, durable_component_circuit_json, built_component_circuit_json] =
    await Promise.all([
      readFile(integrated_component, "utf8"),
      readFile(join(input.job_dir, "dist", "spice", "component-with-model", "circuit.json"), "utf8")
        .then((text) => JSON.parse(text))
        .catch(() => undefined),
      readFile(join(input.job_dir, "component.circuit.json"), "utf8")
        .then((text) => JSON.parse(text))
        .catch(() => undefined),
      readFile(join(input.job_dir, "dist", "index", "circuit.json"), "utf8")
        .then((text) => JSON.parse(text))
        .catch(() => undefined),
    ])
  const circuit_json = selectPublishedComponentCircuitJson({
    existing: input.job_store.getJob(input.job_id)?.circuit_json,
    integrated: circuit_json_value,
    recovered: [durable_component_circuit_json, built_component_circuit_json],
  })
  input.job_store.updateJob(input.job_id, {
    component_code,
    ...(circuit_json ? { circuit_json } : {}),
  })
}

export async function writeServerIntegratedComponent(input: {
  model_dir: string
  manifest: ModelManifest
  model_source: string
}): Promise<void> {
  const spice_pin_mapping = Object.fromEntries(
    input.manifest.pins.map((pin) => [pin.spice_node, pin.component_pin]),
  )
  await Bun.write(
    join(input.model_dir, "component-with-model.circuit.tsx"),
    getServerComponentWrapperSource({
      spice_model: `(
      <spicemodel
        source={modelSource}
        spicePinMapping={${JSON.stringify(spice_pin_mapping, null, 2)}}
      />
    )`,
      model_source: input.model_source,
    }),
  )
}

export async function writeServerStructuralComponent(input: { model_dir: string }): Promise<void> {
  await Bun.write(
    join(input.model_dir, "component-with-model.circuit.tsx"),
    getServerComponentWrapperSource(),
  )
}

function getServerComponentWrapperSource(input?: { spice_model: string; model_source: string }): string {
  return `import { cloneElement, type ComponentProps, type ReactElement, type ReactNode } from "react"
import Component from "./component.circuit"

${input ? `const modelSource = ${JSON.stringify(input.model_source)}\n` : ""}
export type ComponentWithModelProps = ComponentProps<typeof Component>
type ModelElementProps = ComponentWithModelProps & { name?: string; spiceModel?: ReactNode }
const renderComponent = Component as unknown as (
  props: ComponentWithModelProps,
) => ReactElement<ModelElementProps>

export default function ComponentWithModel(props: ComponentWithModelProps) {
  return cloneElement(renderComponent(props), {
    ...props,
    ${input ? `spiceModel: ${input.spice_model},` : ""}
  })
}
`
}

function normalizeModelSource(source: string): string {
  return source.replace(/\r\n?/g, "\n").trim()
}

export function assertIntegratedCircuitUsesCanonicalModel(value: unknown, model_source: string): void {
  if (!isCircuitJson(value)) throw new Error("The integrated component did not produce valid Circuit JSON")
  const spice_models = value.filter((element) => element.type === "simulation_spice_subcircuit")
  if (
    spice_models.length !== 1 ||
    !("subcircuit_source" in spice_models[0]!) ||
    typeof spice_models[0]!.subcircuit_source !== "string" ||
    normalizeModelSource(spice_models[0]!.subcircuit_source) !== normalizeModelSource(model_source)
  ) {
    throw new Error("The integrated component does not contain exactly one canonical model.lib subcircuit")
  }
}
