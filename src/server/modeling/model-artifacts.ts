import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ModelManifest } from "@/shared/job-types"
import type { GeneratedModel, ModelInterface } from "./types"

type ModelSourceInterface = Pick<ModelInterface, "entry_name"> & {
  pins: readonly Pick<ModelInterface["pins"][number], "spice_node">[]
}

function normalizedLines(source: string): string[] {
  const physical = source.replace(/\r\n?/g, "\n").split("\n")
  const logical: string[] = []
  for (const raw_line of physical) {
    const line = raw_line.trim()
    if (line.startsWith("+") && logical.length > 0) {
      logical[logical.length - 1] = `${logical.at(-1)} ${line.slice(1).trim()}`
    } else {
      logical.push(line)
    }
  }
  return logical
}

export function validateModelSource(source: string, model_interface: ModelSourceInterface): void {
  const lines = normalizedLines(source)
  const executable = lines.filter((line) => line && !line.startsWith("*"))
  const external_file_directive = executable.find((line) => /^\.(?:include|lib)\b/i.test(line))
  if (external_file_directive) {
    throw new Error(`model.lib must be self-contained; found ${external_file_directive}`)
  }
  if (executable.some((line) => /^\.(?:control|shell|system)\b/i.test(line) || /(?:^|\s)!/.test(line))) {
    throw new Error("model.lib contains a disallowed control or shell command")
  }
  if (executable.some((line) => /^\.end(?:\s|$)/i.test(line))) {
    throw new Error("model.lib must not contain the top-level .END directive")
  }
  const subcircuits = executable
    .filter((line) => /^\.subckt\b/i.test(line))
    .map((line) => {
      const tokens = line.split(/\s+/)
      const parameter_index = tokens.findIndex(
        (token, index) => index >= 2 && (/^params?:/i.test(token) || token.includes("=")),
      )
      return {
        name: tokens[1] ?? "",
        nodes: tokens.slice(2, parameter_index < 0 ? undefined : parameter_index),
      }
    })
  const public_subcircuits = subcircuits.filter(
    ({ name }) => name.toLowerCase() === model_interface.entry_name.toLowerCase(),
  )
  if (public_subcircuits.length !== 1) {
    throw new Error(
      `model.lib must contain exactly one public .SUBCKT ${model_interface.entry_name}; found ${public_subcircuits.length}`,
    )
  }
  const public_subcircuit = public_subcircuits[0]
  if (!public_subcircuit) return
  const actual_nodes = public_subcircuit.nodes
  const expected_nodes = model_interface.pins.map(({ spice_node }) => spice_node)
  if (
    JSON.stringify(actual_nodes.map((node) => node.toLowerCase())) !==
    JSON.stringify(expected_nodes.map((node) => node.toLowerCase()))
  ) {
    throw new Error(
      `model.lib pin order must be ${expected_nodes.join(" ")}; received ${actual_nodes.join(" ") || "nothing"}`,
    )
  }
  let open_subcircuit: string | undefined
  for (const line of executable) {
    const header = /^\.subckt\s+(\S+)/i.exec(line)
    if (header) {
      if (open_subcircuit) {
        throw new Error(`model.lib nests .SUBCKT ${header[1]} inside ${open_subcircuit}`)
      }
      open_subcircuit = header[1]
      continue
    }
    const ending = /^\.ends(?:\s+(\S+))?\s*$/i.exec(line)
    if (ending) {
      if (!open_subcircuit) throw new Error("model.lib contains .ENDS without an open .SUBCKT")
      if (ending[1] && ending[1].toLowerCase() !== open_subcircuit.toLowerCase()) {
        throw new Error(`model.lib closes ${open_subcircuit} with mismatched .ENDS ${ending[1]}`)
      }
      open_subcircuit = undefined
      continue
    }
    if (open_subcircuit) continue
    if (/^\.model\s+\S+\s+\S+/i.test(line)) continue
    throw new Error(
      `model.lib contains executable top-level content outside .SUBCKT/.MODEL: ${line.slice(0, 160)}`,
    )
  }
  if (open_subcircuit) throw new Error(`model.lib does not close .SUBCKT ${open_subcircuit} with .ENDS`)
}

export function createModelManifest(input: {
  model_interface: ModelInterface
  model_source: string
  simulator: string
}): ModelManifest {
  validateModelSource(input.model_source, input.model_interface)
  const revision = createHash("sha256")
    .update(input.model_source.replace(/\r\n?/g, "\n").trim())
    .digest("hex")
    .slice(0, 16)
  return {
    version: 1,
    part_number: input.model_interface.part_number,
    dialect: "portable",
    entry_name: input.model_interface.entry_name,
    model_file: "model.lib",
    revision,
    simulator: input.simulator,
    generated_at: new Date().toISOString(),
    pins: input.model_interface.pins.map(({ component_pin, spice_node }) => ({
      component_pin,
      spice_node,
    })),
  }
}

export async function readGeneratedModel(input: {
  model_dir: string
  model_interface: ModelInterface
  simulator?: string
}): Promise<GeneratedModel> {
  const [source, card] = await Promise.all([
    readFile(join(input.model_dir, "model.lib"), "utf8"),
    readFile(join(input.model_dir, "model-card.md"), "utf8"),
  ])
  const manifest = createModelManifest({
    model_interface: input.model_interface,
    model_source: source,
    simulator: input.simulator ?? "ngspice",
  })
  await Bun.write(join(input.model_dir, "model-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  return { source, card, manifest }
}
