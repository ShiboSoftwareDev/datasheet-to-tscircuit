import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import { isCircuitJson } from "../component-circuit-json"
import { getPinoutEvidenceErrors } from "../component-evidence"
import { getComponentSchematicPlanErrors } from "../component-schematic-plan"
import { ProcessError, type ProcessRunner } from "../infrastructure/process"
import { buildTscircuitSource } from "../infrastructure/tscircuit"
import {
  getFootprintPlanErrors,
  getTypicalApplicationComponentValueErrors,
  getTypicalApplicationConnectivityErrors,
  getTypicalApplicationSourceErrors,
  getTypicalApplicationTargetComponentErrors,
} from "../job-artifact-validator"
import type { JobStore } from "../job-store"
import {
  type CircuitValidationRecord,
  readApprovedEvidence,
  readJson,
  updateJobValidation,
  validateGeneratedSource,
  writeJson,
} from "./stage-helpers"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isInfrastructureProcessFailure(error: unknown): error is ProcessError {
  return (
    error instanceof ProcessError &&
    (error.code === "process_spawn_failed" ||
      error.code === "process_output_handler_failed" ||
      error.code === "process_idle_timeout" ||
      error.code === "process_wall_timeout")
  )
}

function records(circuit_json: AnyCircuitElement[]): Array<Record<string, unknown> & { type: string }> {
  return circuit_json as Array<Record<string, unknown> & { type: string }>
}

function componentShapeErrors(
  circuit_json: AnyCircuitElement[],
  expected_pin_count: number,
  expected_pad_count: number,
): string[] {
  if (circuit_json.length === 0) return ["tsci produced empty Circuit JSON"]
  const circuit_records = records(circuit_json)
  const source_components = circuit_records.filter(({ type }) => type === "source_component")
  const source_ports = circuit_records.filter(({ type }) => type === "source_port")
  const pads = circuit_records.filter(({ type }) => type === "pcb_smtpad" || type === "pcb_plated_hole")
  const errors: string[] = []
  if (source_components.length !== 1) {
    errors.push(`expected exactly one source_component, found ${source_components.length}`)
  }
  if (source_ports.length !== expected_pin_count) {
    errors.push(`expected ${expected_pin_count} source ports, found ${source_ports.length}`)
  }
  if (pads.length !== expected_pad_count) {
    errors.push(`expected ${expected_pad_count} copper pads, found ${pads.length}`)
  }
  if (!circuit_records.some(({ type }) => type === "schematic_component")) {
    errors.push("component produced no schematic_component")
  }
  return errors
}

function applicationShapeErrors(
  circuit_json: AnyCircuitElement[],
  pcb_implementation: "verified" | "schematic_only" | undefined,
): string[] {
  if (circuit_json.length === 0) return ["tsci produced empty Circuit JSON"]
  const circuit_records = records(circuit_json)
  const source_components = circuit_records.filter(({ type }) => type === "source_component")
  const u1_components = source_components.filter((component) =>
    [component.name, component.reference, component.refdes]
      .filter((value): value is string => typeof value === "string")
      .some((value) => value.trim().toLowerCase() === "u1"),
  )
  const errors: string[] = []
  if (u1_components.length !== 1) {
    errors.push(`expected exactly one target source_component named U1, found ${u1_components.length}`)
  }
  if (!circuit_records.some(({ type }) => type === "schematic_component")) {
    errors.push("application produced no schematic_component")
  }
  const pcb_elements = circuit_records.filter(({ type }) => type.startsWith("pcb_"))
  if (pcb_implementation === "verified" && !pcb_elements.some(({ type }) => type === "pcb_component")) {
    errors.push("verified application produced no pcb_component")
  }
  if (pcb_implementation === "schematic_only" && pcb_elements.length > 0) {
    errors.push("schematic-only application produced PCB elements")
  }
  return errors
}

export async function validateComponent(input: {
  job_id: string
  job_dir: string
  job_store: JobStore
  tsci_bin: string
  process_runner: ProcessRunner
  signal: AbortSignal
  on_output: (stream: "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<CircuitValidationRecord> {
  const evidence = await readApprovedEvidence(input.job_dir)
  let circuit_json: AnyCircuitElement[] = []
  const build_errors: string[] = []
  try {
    const build = await buildTscircuitSource({
      workspace: input.job_dir,
      source_file: "index.circuit.tsx",
      output_stem: "index",
      tsci_bin: input.tsci_bin,
      process_runner: input.process_runner,
      signal: input.signal,
      checks: ["netlist"],
      render: { pcb: true, schematic: true },
      on_output: input.on_output,
    })
    circuit_json = build.circuit_json
    build_errors.push(...build.errors)
  } catch (error) {
    if (input.signal.aborted) throw error
    if (isInfrastructureProcessFailure(error)) throw error
    build_errors.push(errorMessage(error))
  }
  const shape_errors = componentShapeErrors(
    circuit_json,
    evidence.component_evidence.pinout.pins.length,
    evidence.footprint_plan.pads.length,
  )
  const footprint_errors = getFootprintPlanErrors(evidence.footprint_plan, circuit_json)
  const pinout_errors = getPinoutEvidenceErrors(evidence.component_evidence, circuit_json)
  const schematic_errors = getComponentSchematicPlanErrors(evidence.schematic_plan, circuit_json)
  const board_errors: string[] = []
  if (build_errors.length === 0 && circuit_json.length > 0) {
    const fixture_path = join(input.job_dir, "component-validation.circuit.tsx")
    await Bun.write(
      fixture_path,
      `import Component from "./index.circuit"\nexport default () => <board><Component /></board>\n`,
    )
    try {
      const board = await buildTscircuitSource({
        workspace: input.job_dir,
        source_file: "component-validation.circuit.tsx",
        output_stem: "component-validation",
        tsci_bin: input.tsci_bin,
        process_runner: input.process_runner,
        signal: input.signal,
        ignored_error_types: ["source_pin_must_be_connected_error"],
        checks: ["placement", "routing-difficulty"],
        on_output: input.on_output,
      })
      board_errors.push(...board.errors)
    } catch (error) {
      if (input.signal.aborted) throw error
      if (isInfrastructureProcessFailure(error)) throw error
      board_errors.push(errorMessage(error))
    } finally {
      await rm(fixture_path, { force: true })
    }
  }
  const errors = [
    ...build_errors.map((error) => `build: ${error}`),
    ...shape_errors.map((error) => `shape: ${error}`),
    ...board_errors.map((error) => `board_drc: ${error}`),
    ...footprint_errors.map((error) => `footprint: ${error}`),
    ...pinout_errors.map((error) => `pinout: ${error}`),
    ...schematic_errors.map((error) => `schematic: ${error}`),
  ]
  updateJobValidation(input.job_store, input.job_id, {
    component_build: build_errors.length === 0 && shape_errors.length === 0 ? "passed" : "failed",
    component_drc:
      board_errors.length === 0 && build_errors.length === 0 && shape_errors.length === 0
        ? "passed"
        : "failed",
    footprint: footprint_errors.length === 0 && shape_errors.length === 0 ? "passed" : "failed",
    pinout: pinout_errors.length === 0 && shape_errors.length === 0 ? "passed" : "failed",
    component_schematic: schematic_errors.length === 0 && shape_errors.length === 0 ? "passed" : "failed",
    component_visual: build_errors.length === 0 && shape_errors.length === 0 ? "inconclusive" : "failed",
  })
  const record: CircuitValidationRecord = {
    version: 1,
    passed: errors.length === 0,
    errors,
    circuit_json,
  }
  await Promise.all([
    writeJson(join(input.job_dir, "component-validation.json"), record),
    circuit_json.length > 0
      ? writeJson(join(input.job_dir, "component.circuit.json"), circuit_json)
      : Promise.resolve(),
  ])
  return record
}

export async function validateApplication(input: {
  job_id: string
  job_dir: string
  job_store: JobStore
  tsci_bin: string
  process_runner: ProcessRunner
  signal: AbortSignal
  on_output: (stream: "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<CircuitValidationRecord> {
  const evidence = await readApprovedEvidence(input.job_dir)
  if (evidence.application_plan.availability === "not_present") {
    updateJobValidation(input.job_store, input.job_id, {
      application_build: "not_applicable",
      application_connectivity: "not_applicable",
      application_schematic: "not_applicable",
      application_visual: "not_applicable",
    })
    const record: CircuitValidationRecord = {
      version: 1,
      passed: true,
      errors: [],
      circuit_json: [],
    }
    await writeJson(join(input.job_dir, "application-validation.json"), record)
    return record
  }
  const source = await readFile(join(input.job_dir, "typical-application.circuit.tsx"), "utf8")
  const source_errors: string[] = []
  try {
    validateGeneratedSource(source, "application")
    source_errors.push(
      ...getTypicalApplicationSourceErrors(
        source,
        evidence.application_plan.pcb_implementation,
        evidence.application_plan,
      ),
    )
  } catch (error) {
    source_errors.push(errorMessage(error))
  }
  let circuit_json: AnyCircuitElement[] = []
  const build_errors: string[] = []
  if (source_errors.length === 0) {
    try {
      const build = await buildTscircuitSource({
        workspace: input.job_dir,
        source_file: "typical-application.circuit.tsx",
        output_stem: "typical-application",
        tsci_bin: input.tsci_bin,
        process_runner: input.process_runner,
        signal: input.signal,
        build_args:
          evidence.application_plan.pcb_implementation === "schematic_only" ? ["--disable-pcb"] : [],
        checks:
          evidence.application_plan.pcb_implementation === "schematic_only"
            ? ["netlist"]
            : ["netlist", "placement", "routing-difficulty"],
        render: {
          pcb: evidence.application_plan.pcb_implementation === "verified",
          schematic: true,
        },
        on_output: input.on_output,
      })
      circuit_json = build.circuit_json
      build_errors.push(...build.errors)
    } catch (error) {
      if (input.signal.aborted) throw error
      if (isInfrastructureProcessFailure(error)) throw error
      build_errors.push(errorMessage(error))
    }
  }
  const shape_errors = applicationShapeErrors(circuit_json, evidence.application_plan.pcb_implementation)
  const target_component_errors: string[] = []
  if (circuit_json.length > 0) {
    const validated_component = await readJson(join(input.job_dir, "component.circuit.json"))
    if (!isCircuitJson(validated_component)) {
      target_component_errors.push("Validated component Circuit JSON is missing or malformed")
    } else {
      target_component_errors.push(
        ...getTypicalApplicationTargetComponentErrors(validated_component, circuit_json),
      )
    }
  }
  const connectivity_errors = [
    ...target_component_errors,
    ...getTypicalApplicationConnectivityErrors(evidence.application_plan, circuit_json),
    ...getTypicalApplicationComponentValueErrors(evidence.application_plan, circuit_json),
  ]
  const errors = [
    ...source_errors.map((error) => `source: ${error}`),
    ...build_errors.map((error) => `build: ${error}`),
    ...shape_errors.map((error) => `shape: ${error}`),
    ...connectivity_errors.map((error) => `connectivity: ${error}`),
  ]
  updateJobValidation(input.job_store, input.job_id, {
    application_build:
      build_errors.length === 0 && source_errors.length === 0 && shape_errors.length === 0
        ? "passed"
        : "failed",
    application_connectivity:
      connectivity_errors.length === 0 && shape_errors.length === 0 ? "passed" : "failed",
    application_schematic: source_errors.length === 0 && shape_errors.length === 0 ? "passed" : "failed",
    application_visual: build_errors.length === 0 && shape_errors.length === 0 ? "inconclusive" : "failed",
  })
  const record: CircuitValidationRecord = {
    version: 1,
    passed: errors.length === 0,
    errors,
    circuit_json,
  }
  await writeJson(join(input.job_dir, "application-validation.json"), record)
  return record
}
