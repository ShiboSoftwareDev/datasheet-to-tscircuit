import { createHash } from "node:crypto"
import { join } from "node:path"
import type { ModelManifest } from "@/shared/job-types"
import { readBoundedTextArtifact } from "../infrastructure/artifacts"
import type { GeneratedModel, ModelInterface } from "./types"
import type { ModelContract } from "./types"

type ModelSourceInterface = Pick<ModelInterface, "entry_name"> & {
  pins: readonly Pick<ModelInterface["pins"][number], "spice_node">[]
}

interface LogicalSpiceLine {
  text: string
  physical_line: number
}

const INDEPENDENT_TRANSIENT_SOURCE_PATTERN = /\b(?:pwl|pulse|sin|exp|sffm|am|trrandom|trnoise)\b/i
const AUTONOMOUS_RANDOM_EXPRESSION_PATTERN = /\b(?:white|unif|aunif|gauss|agauss|rand|random)\s*\(/i
const IMPLICIT_DERIVATIVE_STATE_PATTERN = /\b(?:ddt|idt|idtmod)\s*\(/i
const SPICE_LITERAL_PATTERN =
  /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?:t|g|meg|k|m|u|n|p|f|mil)?(?:[a-z]+)?$/i

function stripInlineComment(line: string): string {
  // ngspice treats `$` as the start of an inline comment. Full-line `*`
  // comments are handled after trimming. Cutting comments before joining `+`
  // continuations prevents examples in comments from becoming executable
  // detector input.
  const comment_index = line.indexOf("$")
  return comment_index < 0 ? line : line.slice(0, comment_index)
}

function normalizedLines(source: string): LogicalSpiceLine[] {
  const physical = source.replace(/\r\n?/g, "\n").split("\n")
  const logical: LogicalSpiceLine[] = []
  for (const [index, raw_line] of physical.entries()) {
    const line = stripInlineComment(raw_line).trim()
    if (!line || line.startsWith("*")) continue
    if (line.startsWith("+") && logical.length > 0) {
      const previous = logical.at(-1)!
      previous.text = `${previous.text} ${line.slice(1).trim()}`
    } else {
      logical.push({ text: line, physical_line: index + 1 })
    }
  }
  return logical
}

function modeledResponseNodes(contract: ModelContract): Set<string> {
  const nodes = new Set<string>()
  for (const requirement of contract.characterization.requirements) {
    if (requirement.support.status !== "modeled") continue
    const response = requirement.reference_curve?.electrical_binding?.response
    if (!response) continue
    for (const endpoint of [response.positive, response.negative]) {
      if (!endpoint.toLowerCase().startsWith("dut.")) continue
      nodes.add(endpoint.slice(4).toLowerCase())
    }
  }
  return nodes
}

function zeroVoltageAliases(lines: readonly LogicalSpiceLine[]): Map<string, Set<string>> {
  const aliases = new Map<string, Set<string>>()
  const add = (left: string, right: string) => {
    const left_key = left.toLowerCase()
    const right_key = right.toLowerCase()
    const left_aliases = aliases.get(left_key) ?? new Set([left_key])
    const right_aliases = aliases.get(right_key) ?? new Set([right_key])
    const combined = new Set([...left_aliases, ...right_aliases])
    for (const node of combined) aliases.set(node, combined)
  }
  for (const { text } of lines) {
    const source =
      /^v\S*\s+(\S+)\s+(\S+)\s+(?:dc\s+)?([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?:\s|$)/i.exec(text)
    if (source && Number(source[3]) === 0) add(source[1], source[2])
  }
  return aliases
}

function addUndirectedEdge(graph: Map<string, Set<string>>, left: string, right: string): void {
  const left_key = left.toLowerCase()
  const right_key = right.toLowerCase()
  if (left_key === "0" || left_key === "gnd" || right_key === "0" || right_key === "gnd") return
  const left_edges = graph.get(left_key) ?? new Set<string>()
  const right_edges = graph.get(right_key) ?? new Set<string>()
  left_edges.add(right_key)
  right_edges.add(left_key)
  graph.set(left_key, left_edges)
  graph.set(right_key, right_edges)
}

function nodesReachableThroughResistors(
  lines: readonly LogicalSpiceLine[],
  starts: ReadonlySet<string>,
): Set<string> {
  const graph = new Map<string, Set<string>>()
  for (const { text } of lines) {
    const resistor = /^r\S*\s+(\S+)\s+(\S+)\s+/i.exec(text)
    if (resistor) addUndirectedEdge(graph, resistor[1], resistor[2])
  }
  const reachable = new Set([...starts].map((node) => node.toLowerCase()))
  const queue = [...reachable]
  while (queue.length > 0) {
    const node = queue.shift()!
    for (const adjacent of graph.get(node) ?? []) {
      if (reachable.has(adjacent)) continue
      reachable.add(adjacent)
      queue.push(adjacent)
    }
  }
  return reachable
}

function probedVoltageNodes(expression: string): Set<string> {
  const nodes = new Set<string>()
  for (const match of expression.matchAll(/\bv\s*\(\s*([^,\s)]+)(?:\s*,\s*([^\s)]+))?\s*\)/gi)) {
    if (match[1]) nodes.add(match[1].toLowerCase())
    if (match[2]) nodes.add(match[2].toLowerCase())
  }
  return nodes
}

/**
 * Family-aware topology rules for fresh candidates. These are deliberately
 * structural rather than value-specific: a model must not pass by copying or
 * cancelling application-fixture dynamics at any component value.
 */
export function assertFreshModelTopologyIntegrity(source: string, contract: ModelContract): void {
  if (contract.characterization.family !== "power_converter") return
  const response_nodes = modeledResponseNodes(contract)
  if (response_nodes.size === 0) return
  const lines = normalizedLines(source)
  const aliases = zeroVoltageAliases(lines)
  const is_response_node = (node: string): boolean => {
    const key = node.toLowerCase()
    if (response_nodes.has(key)) return true
    const equivalent_nodes = aliases.get(key)
    return equivalent_nodes ? [...equivalent_nodes].some((candidate) => response_nodes.has(candidate)) : false
  }

  const output_connected_nodes = nodesReachableThroughResistors(lines, response_nodes)
  const private_state_nodes = new Set<string>()
  for (const { text: line } of lines) {
    const stored_energy = /^[cl]\S*\s+(\S+)\s+(\S+)\s+/i.exec(line)
    if (!stored_energy) continue
    for (const node of [stored_energy[1], stored_energy[2]]) {
      const key = node.toLowerCase()
      if (key !== "0" && key !== "gnd") private_state_nodes.add(key)
    }
  }

  const response_driven_state_nodes = new Set<string>()
  for (const { text: line } of lines) {
    const behavioral = /^[beg]\S*\s+(\S+)\s+(\S+)\s+(.+)$/i.exec(line)
    if (!behavioral) continue
    const probed_nodes = probedVoltageNodes(behavioral[3])
    if (![...probed_nodes].some((node) => response_nodes.has(node))) continue
    const driven_component = nodesReachableThroughResistors(lines, new Set([behavioral[1], behavioral[2]]))
    for (const state_node of private_state_nodes) {
      if (driven_component.has(state_node)) response_driven_state_nodes.add(state_node)
    }
  }

  for (const { text: line, physical_line } of lines) {
    const stored_energy = /^([cl]\S*)\s+(\S+)\s+(\S+)\s+/i.exec(line)
    if (
      stored_energy &&
      (output_connected_nodes.has(stored_energy[2].toLowerCase()) ||
        output_connected_nodes.has(stored_energy[3].toLowerCase()) ||
        is_response_node(stored_energy[2]) ||
        is_response_node(stored_energy[3]))
    ) {
      throw new Error(
        `model.lib line ${physical_line} connects ${stored_energy[1]} energy storage to a modeled power-converter output; output/load passives belong only to the server-owned application fixture, while controller state must use private nodes`,
      )
    }
    const independent_current = /^(i\S*)\s+(\S+)\s+(\S+)\s+/i.exec(line)
    if (
      independent_current &&
      (is_response_node(independent_current[2]) || is_response_node(independent_current[3]))
    ) {
      throw new Error(
        `model.lib line ${physical_line} connects independent current source ${independent_current[1]} to a modeled power-converter output; output current must arise from the causal regulator loop, not a copied fixture load`,
      )
    }
    const behavioral = /^([beg]\S*)\s+(\S+)\s+(\S+)\s+(.+)$/i.exec(line)
    if (
      behavioral &&
      (output_connected_nodes.has(behavioral[2].toLowerCase()) ||
        output_connected_nodes.has(behavioral[3].toLowerCase()))
    ) {
      const probed_nodes = probedVoltageNodes(behavioral[4])
      const uncaused_state = [...probed_nodes].find(
        (node) => private_state_nodes.has(node) && !response_driven_state_nodes.has(node),
      )
      if (uncaused_state) {
        throw new Error(
          `model.lib line ${physical_line} drives a modeled power-converter output from private state ${uncaused_state}, but that state is not driven by the measured output response; synthetic enable/startup settling states are not valid substitutes for the causal regulator loop`,
        )
      }
    }
  }
}

function expressionContainsBuiltinTime(expression: string): boolean {
  const masked = [...expression]
  let index = 0
  while (index < expression.length) {
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expression.slice(index))?.[0]
    if (!identifier) {
      index += 1
      continue
    }
    const identifier_start = index
    index += identifier.length
    let open_parenthesis = index
    while (/\s/.test(expression[open_parenthesis] ?? "")) open_parenthesis += 1
    if (!/^[vi]$/i.test(identifier) || expression[open_parenthesis] !== "(") continue

    let depth = 0
    let close_parenthesis = open_parenthesis
    for (; close_parenthesis < expression.length; close_parenthesis += 1) {
      const character = expression[close_parenthesis]
      if (character === "(") depth += 1
      if (character === ")") {
        depth -= 1
        if (depth === 0) {
          close_parenthesis += 1
          break
        }
      }
    }
    // V(TIME) and I(TIME) name an electrical node or branch; TIME there is not
    // ngspice's elapsed-time variable. Mask the complete probe call before the
    // reserved-variable scan. Malformed calls remain for ngspice to reject.
    if (depth === 0) {
      for (let mask_index = identifier_start; mask_index < close_parenthesis; mask_index += 1) {
        masked[mask_index] = " "
      }
      index = close_parenthesis
    }
  }
  return /\btime\b/i.test(masked.join(""))
}

function behavioralExpression(line: string): string | undefined {
  const subcircuit_header = /^\.subckt\s+\S+\s+(.+)$/i.exec(line)?.[1]
  if (subcircuit_header) {
    const tokens = subcircuit_header.split(/\s+/)
    const parameter_index = tokens.findIndex((token) => /^params?:/i.test(token) || token.includes("="))
    if (parameter_index >= 0) return tokens.slice(parameter_index).join(" ")
    return undefined
  }

  const behavioral_source = /^b\S*\s+\S+\s+\S+\s+(.+)$/i.exec(line)
  if (behavioral_source) return behavioral_source[1]

  const parameter = /^\.param\b(.+)$/i.exec(line)?.[1]
  if (parameter) {
    const assignment_index = parameter.indexOf("=")
    return assignment_index < 0 ? undefined : parameter.slice(assignment_index + 1)
  }

  const spice_function = /^\.func\s+\S+?\s*\(([^)]*)\)\s*=?\s*(.+)$/i.exec(line)
  if (spice_function) {
    const arguments_list = new Set(
      spice_function[1]
        .split(",")
        .map((argument) => argument.trim().toLowerCase())
        .filter(Boolean),
    )
    // A formal function argument named TIME is ordinary caller-supplied data,
    // not the simulator clock. The body is still checked when TIME is not a
    // declared formal parameter.
    return arguments_list.has("time") ? undefined : spice_function[2]
  }

  const expression_source = /^[eg]\S*\s+\S+\s+\S+\s+(.+)$/i.exec(line)?.[1]
  if (expression_source && /\b(?:value|table|laplace)\b/i.test(expression_source)) {
    return expression_source
  }

  const behavioral_passive = /^[rcl]\S*\s+\S+\s+\S+\s+(.+)$/i.exec(line)?.[1]
  if (behavioral_passive) return behavioral_passive

  const braced_expressions = [...line.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1])
  return braced_expressions.length > 0 ? braced_expressions.join(" ") : undefined
}

function assertCausalModelSource(lines: readonly LogicalSpiceLine[]): void {
  for (const { text: line, physical_line } of lines) {
    if (/^a\S*\s+/i.test(line)) {
      throw new Error(
        `model.lib line ${physical_line} contains an XSPICE code-model device; fresh models allow inspectable analog devices and equations only`,
      )
    }
    if (/^\.ic\b/i.test(line) || /^[cl]\S*\s+.+\bic\s*=/i.test(line)) {
      throw new Error(
        `model.lib line ${physical_line} contains an autonomous initial-condition script; dynamic state must be established causally through public electrical pins`,
      )
    }
    const passive_value = /^[rcl]\S*\s+\S+\s+\S+\s+(\S+)/i.exec(line)?.[1]
    const passive_literal = passive_value ? SPICE_LITERAL_PATTERN.exec(passive_value)?.[1] : undefined
    if (passive_literal !== undefined && Number(passive_literal) <= 0) {
      throw new Error(
        `model.lib line ${physical_line} contains a non-positive passive value; R, C, and L primitives must represent positive physical state or damping`,
      )
    }
    const independent_source = /^[vi]\S*\s+\S+\s+\S+\s+(.+)$/i.exec(line)
    if (independent_source && INDEPENDENT_TRANSIENT_SOURCE_PATTERN.test(independent_source[1])) {
      throw new Error(
        `model.lib line ${physical_line} contains an independent transient source; PWL, PULSE, SIN, EXP, SFFM, and AM waveforms belong only in server-owned validation fixtures`,
      )
    }
    if (independent_source && expressionContainsBuiltinTime(independent_source[1])) {
      throw new Error(
        `model.lib line ${physical_line} contains an autonomous source expression that references ngspice's elapsed-time variable`,
      )
    }

    const expression = behavioralExpression(line)
    if (expression && expressionContainsBuiltinTime(expression)) {
      throw new Error(
        `model.lib line ${physical_line} contains an autonomous behavioral expression that references ngspice's elapsed-time variable`,
      )
    }
    if (expression && AUTONOMOUS_RANDOM_EXPRESSION_PATTERN.test(expression)) {
      throw new Error(
        `model.lib line ${physical_line} contains an autonomous random/noise expression; fresh transient behavior must be caused by public electrical pins`,
      )
    }
    if (expression && IMPLICIT_DERIVATIVE_STATE_PATTERN.test(expression)) {
      throw new Error(
        `model.lib line ${physical_line} contains DDT/IDT implicit derivative state; use positive C/L/device state driven by public electrical pins instead of cancelling fixture dynamics`,
      )
    }
  }
}

export function validateModelSource(source: string, model_interface: ModelSourceInterface): void {
  const lines = normalizedLines(source)
  const executable = lines.map(({ text }) => text)
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
  assertCausalModelSource(lines)
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

export function validateFreshModelSource(source: string, contract: ModelContract): void {
  validateModelSource(source, contract.interface)
  assertFreshModelTopologyIntegrity(source, contract)
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
    readBoundedTextArtifact({
      path: join(input.model_dir, "model.lib"),
      max_bytes: 2 * 1024 * 1024,
    }),
    readBoundedTextArtifact({
      path: join(input.model_dir, "model-card.md"),
      max_bytes: 512 * 1024,
    }),
  ])
  const manifest = createModelManifest({
    model_interface: input.model_interface,
    model_source: source,
    simulator: input.simulator ?? "ngspice",
  })
  await Bun.write(join(input.model_dir, "model-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  return { source, card, manifest }
}
