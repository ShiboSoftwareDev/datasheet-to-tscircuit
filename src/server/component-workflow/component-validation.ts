import { mkdir, readFile, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import { isCircuitElementArray, isCircuitJson } from "../component-circuit-json"
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
import { getApplicationTargetPinCoverageErrors } from "./application-connectivity-verification"
import type { TypicalApplicationPlan } from "./application-plan"
import {
  type CircuitValidationRecord,
  type ApprovedComponentEvidence,
  readApprovedApplicationEvidence,
  readApprovedEvidence,
  readComponentBoundApplicationEvidence,
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

export interface CircuitBuildRecord {
  version: 1
  source_errors: string[]
  build_errors: string[]
  drc_errors: string[]
  circuit_json: AnyCircuitElement[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function readCircuitBuildRecord(path: string): Promise<CircuitBuildRecord> {
  const value = await readJson(path)
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.source_errors) ||
    !value.source_errors.every((entry) => typeof entry === "string") ||
    !Array.isArray(value.build_errors) ||
    !value.build_errors.every((entry) => typeof entry === "string") ||
    !Array.isArray(value.drc_errors) ||
    !value.drc_errors.every((entry) => typeof entry === "string") ||
    !isCircuitElementArray(value.circuit_json)
  ) {
    throw new Error(`Circuit build record is invalid: ${path}`)
  }
  return {
    version: 1,
    source_errors: [...value.source_errors],
    build_errors: [...value.build_errors],
    drc_errors: [...value.drc_errors],
    circuit_json: value.circuit_json,
  }
}

interface CircuitBuildInput {
  job_id: string
  job_dir: string
  job_store: JobStore
  tsci_bin: string
  process_runner: ProcessRunner
  signal: AbortSignal
  on_output: (stream: "stdout" | "stderr", message: string) => void | Promise<void>
  source_relative_path?: string
  output_stem?: string
  build_result_relative_path?: string
  application_plan?: TypicalApplicationPlan
  minimum_pad_clearance_mm?: number
}

export async function buildComponentCandidate(input: CircuitBuildInput): Promise<CircuitBuildRecord> {
  const source_relative_path = input.source_relative_path ?? "index.circuit.tsx"
  const output_stem = input.output_stem ?? "index"
  let circuit_json: AnyCircuitElement[] = []
  const build_errors: string[] = []
  try {
    const build = await buildTscircuitSource({
      workspace: input.job_dir,
      source_file: source_relative_path,
      output_stem,
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
  const drc_errors: string[] = []
  if (build_errors.length === 0 && circuit_json.length > 0) {
    const validation_output_stem =
      output_stem === "index" ? "component-validation" : `${output_stem}-validation`
    const fixture_path = join(input.job_dir, `${validation_output_stem}.circuit.tsx`)
    const source_import = `./${source_relative_path.replace(/\.tsx$/, "")}`
    await Bun.write(
      fixture_path,
      `import Component from ${JSON.stringify(source_import)}\nexport default () => <board${
        input.minimum_pad_clearance_mm === undefined
          ? ""
          : ` minPadEdgeToPadEdgeClearance={${input.minimum_pad_clearance_mm}}`
      }><Component /></board>\n`,
    )
    try {
      const board = await buildTscircuitSource({
        workspace: input.job_dir,
        source_file: `${validation_output_stem}.circuit.tsx`,
        output_stem: validation_output_stem,
        tsci_bin: input.tsci_bin,
        process_runner: input.process_runner,
        signal: input.signal,
        ignored_error_types: ["source_pin_must_be_connected_error"],
        checks: ["placement", "routing-difficulty"],
        on_output: input.on_output,
      })
      drc_errors.push(...board.errors)
    } catch (error) {
      if (input.signal.aborted) throw error
      if (isInfrastructureProcessFailure(error)) throw error
      drc_errors.push(errorMessage(error))
    } finally {
      await rm(fixture_path, { force: true })
    }
  }
  const record: CircuitBuildRecord = {
    version: 1,
    source_errors: [],
    build_errors,
    drc_errors,
    circuit_json,
  }
  const build_result_path = join(input.job_dir, input.build_result_relative_path ?? "component-build.json")
  await mkdir(dirname(build_result_path), { recursive: true })
  await writeJson(build_result_path, record)
  return record
}

export async function validateBuiltComponent(input: {
  job_id: string
  job_dir: string
  job_store: JobStore
  build: CircuitBuildRecord
  evidence?: ApprovedComponentEvidence
  validation_result_relative_path?: string
  update_job_validation?: boolean
}): Promise<CircuitValidationRecord> {
  const evidence = input.evidence ?? (await readApprovedEvidence(input.job_dir))
  const shape_errors = componentShapeErrors(
    input.build.circuit_json,
    evidence.component_evidence.pinout.pins.length,
    evidence.footprint_plan.pads.length,
  )
  const footprint_errors = getFootprintPlanErrors(evidence.footprint_plan, input.build.circuit_json)
  const pinout_errors = getPinoutEvidenceErrors(evidence.component_evidence, input.build.circuit_json)
  const schematic_errors = getComponentSchematicPlanErrors(evidence.schematic_plan, input.build.circuit_json)
  const errors = [
    ...input.build.build_errors.map((error) => `build: ${error}`),
    ...shape_errors.map((error) => `shape: ${error}`),
    ...input.build.drc_errors.map((error) => `board_drc: ${error}`),
    ...footprint_errors.map((error) => `footprint: ${error}`),
    ...pinout_errors.map((error) => `pinout: ${error}`),
    ...schematic_errors.map((error) => `schematic: ${error}`),
  ]
  if (input.update_job_validation !== false)
    updateJobValidation(input.job_store, input.job_id, {
      component_build:
        input.build.build_errors.length === 0 && shape_errors.length === 0 ? "passed" : "failed",
      component_drc:
        input.build.drc_errors.length === 0 &&
        input.build.build_errors.length === 0 &&
        shape_errors.length === 0
          ? "passed"
          : "failed",
      footprint: footprint_errors.length === 0 && shape_errors.length === 0 ? "passed" : "failed",
      pinout: pinout_errors.length === 0 && shape_errors.length === 0 ? "passed" : "failed",
      component_schematic: schematic_errors.length === 0 && shape_errors.length === 0 ? "passed" : "failed",
      component_visual:
        input.build.build_errors.length === 0 && shape_errors.length === 0 ? "inconclusive" : "failed",
    })
  const record: CircuitValidationRecord = {
    version: 1,
    passed: errors.length === 0,
    errors,
    circuit_json: input.build.circuit_json,
  }
  const validation_result_path = join(
    input.job_dir,
    input.validation_result_relative_path ?? "component-validation.json",
  )
  await mkdir(dirname(validation_result_path), { recursive: true })
  await writeJson(validation_result_path, record)
  return record
}

export async function buildApplicationCandidate(input: CircuitBuildInput): Promise<CircuitBuildRecord> {
  const extracted_application_plan = await readApprovedApplicationEvidence(input.job_dir)
  if (!input.application_plan && extracted_application_plan.availability === "not_present") {
    const record: CircuitBuildRecord = {
      version: 1,
      source_errors: [],
      build_errors: [],
      drc_errors: [],
      circuit_json: [],
    }
    await writeJson(join(input.job_dir, "application-build.json"), record)
    return record
  }
  const application_plan =
    input.application_plan ?? (await readComponentBoundApplicationEvidence(input.job_dir))
  const source_relative_path = input.source_relative_path ?? "typical-application.circuit.tsx"
  const output_stem = input.output_stem ?? "typical-application"
  const source = await readFile(join(input.job_dir, source_relative_path), "utf8")
  const source_errors: string[] = []
  try {
    validateGeneratedSource(source, "application")
  } catch (error) {
    source_errors.push(errorMessage(error))
  }
  let circuit_json: AnyCircuitElement[] = []
  const build_errors: string[] = []
  if (source_errors.length === 0) {
    try {
      const build = await buildTscircuitSource({
        workspace: input.job_dir,
        source_file: source_relative_path,
        output_stem,
        tsci_bin: input.tsci_bin,
        process_runner: input.process_runner,
        signal: input.signal,
        build_args: application_plan.pcb_implementation === "schematic_only" ? ["--disable-pcb"] : [],
        checks:
          application_plan.pcb_implementation === "schematic_only"
            ? ["netlist"]
            : ["netlist", "placement", "routing-difficulty"],
        render: {
          pcb: application_plan.pcb_implementation === "verified",
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
  const record: CircuitBuildRecord = {
    version: 1,
    source_errors,
    build_errors,
    drc_errors: [],
    circuit_json,
  }
  await writeJson(join(input.job_dir, input.build_result_relative_path ?? "application-build.json"), record)
  return record
}

export async function validateBuiltApplication(input: {
  job_id: string
  job_dir: string
  job_store: JobStore
  build: CircuitBuildRecord
  application_plan?: TypicalApplicationPlan
  source_relative_path?: string
  validation_result_relative_path?: string
  update_job_validation?: boolean
}): Promise<CircuitValidationRecord> {
  const extracted_application_plan = await readApprovedApplicationEvidence(input.job_dir)
  if (!input.application_plan && extracted_application_plan.availability === "not_present") {
    if (input.update_job_validation !== false)
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
    await writeJson(
      join(input.job_dir, input.validation_result_relative_path ?? "application-validation.json"),
      record,
    )
    return record
  }
  const [application_plan, component_evidence] = await Promise.all([
    input.application_plan ?? readComponentBoundApplicationEvidence(input.job_dir),
    readApprovedEvidence(input.job_dir),
  ])
  const source = await readFile(
    join(input.job_dir, input.source_relative_path ?? "typical-application.circuit.tsx"),
    "utf8",
  )
  const semantic_source_errors = getTypicalApplicationSourceErrors(
    source,
    application_plan.pcb_implementation,
    application_plan,
  )
  const shape_errors = applicationShapeErrors(input.build.circuit_json, application_plan.pcb_implementation)
  const target_component_errors: string[] = []
  if (input.build.circuit_json.length > 0) {
    const validated_component = await readJson(join(input.job_dir, "component.circuit.json"))
    if (!isCircuitJson(validated_component)) {
      target_component_errors.push("Validated component Circuit JSON is missing or malformed")
    } else {
      target_component_errors.push(
        ...getTypicalApplicationTargetComponentErrors(validated_component, input.build.circuit_json),
      )
    }
  }
  const connectivity_errors = [
    ...target_component_errors,
    ...getApplicationTargetPinCoverageErrors({
      availability: application_plan.availability,
      connections: application_plan.connections,
      evidence: component_evidence.component_evidence,
      subject: "Extracted application",
    }),
    ...getTypicalApplicationConnectivityErrors(application_plan, input.build.circuit_json),
    ...getTypicalApplicationComponentValueErrors(application_plan, input.build.circuit_json),
  ]
  const errors = [
    ...input.build.source_errors.map((error) => `source: ${error}`),
    ...semantic_source_errors.map((error) => `source: ${error}`),
    ...input.build.build_errors.map((error) => `build: ${error}`),
    ...shape_errors.map((error) => `shape: ${error}`),
    ...connectivity_errors.map((error) => `connectivity: ${error}`),
  ]
  if (input.update_job_validation !== false)
    updateJobValidation(input.job_store, input.job_id, {
      application_build:
        input.build.build_errors.length === 0 &&
        input.build.source_errors.length === 0 &&
        shape_errors.length === 0
          ? "passed"
          : "failed",
      application_connectivity:
        connectivity_errors.length === 0 && shape_errors.length === 0 ? "passed" : "failed",
      application_schematic:
        input.build.source_errors.length === 0 &&
        semantic_source_errors.length === 0 &&
        shape_errors.length === 0
          ? "passed"
          : "failed",
      application_visual:
        input.build.build_errors.length === 0 && shape_errors.length === 0 ? "inconclusive" : "failed",
    })
  const record: CircuitValidationRecord = {
    version: 1,
    passed: errors.length === 0,
    errors,
    circuit_json: input.build.circuit_json,
  }
  await writeJson(
    join(input.job_dir, input.validation_result_relative_path ?? "application-validation.json"),
    record,
  )
  return record
}

export async function validateComponent(input: CircuitBuildInput): Promise<CircuitValidationRecord> {
  return validateBuiltComponent({
    job_id: input.job_id,
    job_dir: input.job_dir,
    job_store: input.job_store,
    build: await buildComponentCandidate(input),
  })
}

export async function validateApplication(input: CircuitBuildInput): Promise<CircuitValidationRecord> {
  return validateBuiltApplication({
    job_id: input.job_id,
    job_dir: input.job_dir,
    job_store: input.job_store,
    build: await buildApplicationCandidate(input),
  })
}
