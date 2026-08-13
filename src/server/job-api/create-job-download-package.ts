import type { CircuitJson } from "circuit-json"
import { convertCircuitJsonToAltiumZip } from "circuit-json-to-altium"
import {
  CircuitJsonToKicadLibraryConverter,
  CircuitJsonToKicadPcbConverter,
  CircuitJsonToKicadProConverter,
  CircuitJsonToKicadSchConverter,
} from "circuit-json-to-kicad"
import JSZip from "jszip"
import type { Job, TypicalApplicationPreview } from "@/shared/job-types"
import { readModelPublication, readVerifiedPublicationArtifact } from "../modeling"
import { readBaseComponentSource } from "./resolve-job-file-artifact"

export type PackagedJobFileKind =
  | "component_tsx"
  | "component_kicad"
  | "component_altium"
  | "typical_application_tsx"
  | "typical_application_kicad"
  | "typical_application_altium"

export interface JobDownloadPackage {
  artifact_bytes: Uint8Array<ArrayBuffer>
  content_type: "application/zip"
  download_name: string
}

interface ComponentSources {
  base_source: string
  wrapper_source?: string
  model_source?: Uint8Array<ArrayBuffer>
}

interface ResolvedApplication extends TypicalApplicationPreview {
  code: string
  circuit_json?: CircuitJson
}

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true })
const MODEL_SOURCE_BYTE_LIMIT = 2 * 1024 * 1024

export function isPackagedJobFileKind(value: string | null): value is PackagedJobFileKind {
  return (
    value === "component_tsx" ||
    value === "component_kicad" ||
    value === "component_altium" ||
    value === "typical_application_tsx" ||
    value === "typical_application_kicad" ||
    value === "typical_application_altium"
  )
}

function safeFileStem(value: string, fallback: string): string {
  const sanitized = value
    .replace(/\.[^.]+$/, "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  return sanitized || fallback
}

function resolveApplication(job: Job, application_id?: string): ResolvedApplication | undefined {
  const applications = job.typical_applications?.applications ?? []
  const selected_id = application_id ?? job.typical_applications?.default_application_id
  const selected = selected_id
    ? applications.find((application) => application.application_id === selected_id)
    : applications[0]
  if (selected?.code) return { ...selected, code: selected.code }

  if (applications.length > 0 || !job.typical_application_code) return undefined
  return {
    application_id: "reference",
    title: job.typical_application_title ?? "Typical application",
    origin: "datasheet_reference",
    code: job.typical_application_code,
    circuit_json: job.typical_application_circuit_json,
  }
}

async function readComponentSources(input: {
  job: Job
  job_dir: string
  job_id: string
}): Promise<ComponentSources | undefined> {
  const publication = await readModelPublication(input.job_dir, input.job_id)
  const base_bytes = await readBaseComponentSource(input.job_dir, {
    allow_legacy_index_fallback: !publication,
  })
  const base_source = base_bytes ? TEXT_DECODER.decode(base_bytes) : input.job.component_code
  if (!base_source) return undefined
  if (!publication) return { base_source }

  const [wrapper_source, model_source] = await Promise.all([
    readVerifiedPublicationArtifact({
      publication,
      bundle: "published_component",
      relative_path: "index.circuit.tsx",
      max_bytes: MODEL_SOURCE_BYTE_LIMIT,
    }),
    readVerifiedPublicationArtifact({
      publication,
      bundle: "published_component",
      relative_path: "model.lib",
      max_bytes: MODEL_SOURCE_BYTE_LIMIT,
    }),
  ])
  return {
    base_source,
    wrapper_source: TEXT_DECODER.decode(wrapper_source),
    model_source,
  }
}

function addComponentSources(input: { zip: JSZip; sources: ComponentSources; directory?: string }): void {
  const directory = input.directory ? `${input.directory.replace(/\/$/, "")}/` : ""
  const { zip, sources } = input
  if (sources.wrapper_source) {
    zip.file(`${directory}index.circuit.tsx`, sources.wrapper_source)
    zip.file(`${directory}component.circuit.tsx`, sources.base_source)
  } else {
    zip.file(`${directory}index.circuit.tsx`, sources.base_source)
  }
  if (sources.model_source) zip.file("models/model.lib", sources.model_source)
}

function addApplicationSources(input: {
  zip: JSZip
  directory?: string
  application_file: string
  application_source: string
  component_sources: ComponentSources
}): void {
  const directory = input.directory ? `${input.directory.replace(/\/$/, "")}/` : ""
  input.zip.file(`${directory}${input.application_file}`, input.application_source)
  if (input.component_sources.wrapper_source) {
    const component_wrapper = input.component_sources.wrapper_source.replace(
      'from "./component.circuit"',
      'from "./component-base.circuit"',
    )
    if (component_wrapper === input.component_sources.wrapper_source) {
      throw new Error("Published component wrapper does not import its canonical base component")
    }
    input.zip.file(`${directory}component.circuit.tsx`, component_wrapper)
    input.zip.file(`${directory}component-base.circuit.tsx`, input.component_sources.base_source)
  } else {
    input.zip.file(`${directory}component.circuit.tsx`, input.component_sources.base_source)
  }
}

function componentCircuitVariants(job: Job): Array<{
  footprint_id: string
  circuit_json: CircuitJson
}> {
  const variants = (job.component_footprints?.footprints ?? []).flatMap((footprint) =>
    footprint.circuit_json
      ? [{ footprint_id: footprint.footprint_id, circuit_json: footprint.circuit_json }]
      : [],
  )
  if (variants.length > 0) {
    const default_footprint_id = job.component_footprints?.default_footprint_id
    return variants.sort((first, second) => {
      if (first.footprint_id === default_footprint_id) return -1
      if (second.footprint_id === default_footprint_id) return 1
      return 0
    })
  }
  return job.circuit_json ? [{ footprint_id: "default", circuit_json: job.circuit_json }] : []
}

function createFpLibTable(library_name: string): string {
  return `(fp_lib_table\n  (version 7)\n  (lib (name "${library_name}")(type "KiCad")(uri "\${KIPRJMOD}/footprints/${library_name}.pretty")(options "")(descr ""))\n)\n`
}

function createSymLibTable(symbol_libraries: string[]): string {
  const entries = symbol_libraries
    .map(
      (library_name) =>
        `  (lib (name "${library_name}")(type "KiCad")(uri "\${KIPRJMOD}/symbols/${library_name}.kicad_sym")(options "")(descr ""))`,
    )
    .join("\n")
  return `(sym_lib_table\n  (version 7)\n${entries}\n)\n`
}

function prepareKicadFootprintName(input: { circuit_json: CircuitJson; footprint_id: string }): CircuitJson {
  const circuit_json = structuredClone(input.circuit_json)
  const variant_suffix = safeFileStem(input.footprint_id, "variant")
  for (const element of circuit_json) {
    if (element.type !== "pcb_component") continue
    const source_component = circuit_json.find(
      (candidate) =>
        candidate.type === "source_component" &&
        candidate.source_component_id === element.source_component_id,
    )
    const component_name =
      source_component &&
      "manufacturer_part_number" in source_component &&
      typeof source_component.manufacturer_part_number === "string"
        ? safeFileStem(source_component.manufacturer_part_number, "component")
        : "component"
    element.metadata = {
      ...element.metadata,
      kicad_footprint: {
        ...element.metadata?.kicad_footprint,
        footprintName: `${component_name}_${variant_suffix}`,
      },
    }
  }
  return circuit_json
}

function convertKicadLibrary(input: {
  circuit_json: CircuitJson
  library_name: string
}): ReturnType<CircuitJsonToKicadLibraryConverter["getOutput"]> {
  const converter = new CircuitJsonToKicadLibraryConverter(input.circuit_json, {
    libraryName: input.library_name,
    footprintLibraryName: input.library_name,
  })
  converter.runUntilFinished()
  return converter.getOutput()
}

function addComponentKicadLibrary(input: { zip: JSZip; job: Job; library_name: string }): boolean {
  const variants = componentCircuitVariants(input.job)
  if (variants.length === 0) return false

  const footprint_contents: Record<string, string> = {}
  let symbol_library_written = false

  for (const variant of variants) {
    let output = convertKicadLibrary({
      circuit_json: variant.circuit_json,
      library_name: input.library_name,
    })
    if (!symbol_library_written) {
      input.zip.file(`symbols/${input.library_name}.kicad_sym`, output.kicadSymString)
      symbol_library_written = true
    }

    const collides = output.footprints.some((footprint) => {
      const file_name = `${safeFileStem(footprint.footprintName, "footprint")}.kicad_mod`
      const existing = footprint_contents[file_name]
      return Boolean(existing && existing !== footprint.kicadModString)
    })
    if (collides) {
      output = convertKicadLibrary({
        circuit_json: prepareKicadFootprintName({
          circuit_json: variant.circuit_json,
          footprint_id: variant.footprint_id,
        }),
        library_name: input.library_name,
      })
    }

    for (const footprint of output.footprints) {
      const file_name = `${safeFileStem(footprint.footprintName, "footprint")}.kicad_mod`
      const existing = footprint_contents[file_name]
      if (existing && existing !== footprint.kicadModString) {
        throw new Error(`KiCad footprint filename collision for ${file_name}`)
      }
      footprint_contents[file_name] = footprint.kicadModString
    }
  }

  for (const [file_name, contents] of Object.entries(footprint_contents)) {
    input.zip.file(`footprints/${input.library_name}.pretty/${file_name}`, contents)
  }
  input.zip.file("fp-lib-table", createFpLibTable(input.library_name))
  input.zip.file("sym-lib-table", createSymLibTable([input.library_name]))
  return true
}

function addApplicationKicadProject(input: {
  zip: JSZip
  circuit_json: CircuitJson
  project_name: string
}): void {
  const schematic_name = `${input.project_name}.kicad_sch`
  const pcb_name = `${input.project_name}.kicad_pcb`
  const schematic_converter = new CircuitJsonToKicadSchConverter(input.circuit_json)
  schematic_converter.runUntilFinished()
  for (const schematic of schematic_converter.getOutputFiles({ schematicFilename: schematic_name })) {
    input.zip.file(schematic.filename, schematic.content)
  }

  const pcb_converter = new CircuitJsonToKicadPcbConverter(input.circuit_json, {
    includeBuiltin3dModels: false,
    projectName: input.project_name,
  })
  pcb_converter.runUntilFinished()
  input.zip.file(pcb_name, pcb_converter.getOutputString())

  const project_converter = new CircuitJsonToKicadProConverter(input.circuit_json, {
    projectName: input.project_name,
    schematicFilename: schematic_name,
    pcbFilename: pcb_name,
    schematicSheetPlan: schematic_converter.schematicSheetPlan,
  })
  project_converter.runUntilFinished()
  input.zip.file(`${input.project_name}.kicad_pro`, project_converter.getOutputString())
}

async function addAltiumProject(input: {
  zip: JSZip
  circuit_json: CircuitJson
  project_name: string
  directory?: string
}): Promise<void> {
  const archive_bytes = await convertCircuitJsonToAltiumZip(input.circuit_json, input.project_name)
  const archive = await JSZip.loadAsync(archive_bytes)
  const directory = input.directory ? `${input.directory.replace(/\/$/, "")}/` : ""
  for (const file of Object.values(archive.files)) {
    const file_name = `${directory}${file.name}`
    if (file.dir) {
      input.zip.folder(file_name)
    } else {
      input.zip.file(file_name, await file.async("uint8array"))
    }
  }
}

async function addComponentAltiumProjects(input: {
  zip: JSZip
  job: Job
  project_name: string
}): Promise<boolean> {
  const variants = componentCircuitVariants(input.job)
  if (variants.length === 0) return false

  for (const [index, variant] of variants.entries()) {
    const variant_name = safeFileStem(variant.footprint_id, `variant-${index + 1}`)
    const is_default = index === 0
    await addAltiumProject({
      zip: input.zip,
      circuit_json: variant.circuit_json,
      project_name: is_default ? input.project_name : `${input.project_name}-${variant_name}`,
      directory: is_default ? undefined : `variants/${index + 1}-${variant_name}`,
    })
  }
  return true
}

async function generateZip(zip: JSZip): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  })
  return new Uint8Array(bytes)
}

export async function createJobDownloadPackage(input: {
  file_kind: PackagedJobFileKind
  job: Job
  job_dir: string
  application_id?: string
}): Promise<JobDownloadPackage | undefined> {
  const component_sources = await readComponentSources({
    job: input.job,
    job_dir: input.job_dir,
    job_id: input.job.job_id,
  })
  if (!component_sources) return undefined

  const part_name = safeFileStem(input.job.file_name, "component")
  const zip = new JSZip()
  if (input.file_kind === "component_tsx") {
    addComponentSources({ zip, sources: component_sources })
    return {
      artifact_bytes: await generateZip(zip),
      content_type: "application/zip",
      download_name: `${part_name}-component-tsx.zip`,
    }
  }

  if (input.file_kind === "component_kicad") {
    const library_name = `${part_name}_component`
    if (!addComponentKicadLibrary({ zip, job: input.job, library_name })) return undefined
    addComponentSources({ zip, sources: component_sources, directory: "sources" })
    return {
      artifact_bytes: await generateZip(zip),
      content_type: "application/zip",
      download_name: `${part_name}-component-kicad.zip`,
    }
  }

  if (input.file_kind === "component_altium") {
    const project_name = `${part_name}-component`
    if (!(await addComponentAltiumProjects({ zip, job: input.job, project_name }))) return undefined
    addComponentSources({ zip, sources: component_sources, directory: "sources" })
    return {
      artifact_bytes: await generateZip(zip),
      content_type: "application/zip",
      download_name: `${part_name}-component-altium.zip`,
    }
  }

  const application = resolveApplication(input.job, input.application_id)
  if (!application) return undefined
  const application_name = safeFileStem(application.application_id, "application")
  const application_file = `${application_name}.circuit.tsx`
  if (input.file_kind === "typical_application_tsx") {
    addApplicationSources({
      zip,
      application_file,
      application_source: application.code,
      component_sources,
    })
    if (component_sources.model_source) zip.file("model.lib", component_sources.model_source)
    return {
      artifact_bytes: await generateZip(zip),
      content_type: "application/zip",
      download_name: `${part_name}-${application_name}-tsx.zip`,
    }
  }

  if (!application.circuit_json) return undefined
  const project_name = `${part_name}-${application_name}`
  if (input.file_kind === "typical_application_kicad") {
    addApplicationKicadProject({ zip, circuit_json: application.circuit_json, project_name })
    addComponentKicadLibrary({
      zip,
      job: input.job,
      library_name: `${part_name}_component`,
    })
  } else {
    await addAltiumProject({ zip, circuit_json: application.circuit_json, project_name })
  }
  addApplicationSources({
    zip,
    directory: "sources",
    application_file,
    application_source: application.code,
    component_sources,
  })
  if (component_sources.model_source) zip.file("models/model.lib", component_sources.model_source)
  return {
    artifact_bytes: await generateZip(zip),
    content_type: "application/zip",
    download_name: `${project_name}-${input.file_kind === "typical_application_kicad" ? "kicad" : "altium"}.zip`,
  }
}
