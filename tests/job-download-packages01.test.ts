import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CircuitJson } from "circuit-json"
import JSZip from "jszip"
import { createJobDownloadPackage, isPackagedJobFileKind } from "@/server/job-api/create-job-download-package"
import type { Job } from "@/shared/job-types"

const temporary_directories: string[] = []

test("recognizes Altium component and application downloads as packaged exports", () => {
  expect(isPackagedJobFileKind("component_altium")).toBe(true)
  expect(isPackagedJobFileKind("typical_application_altium")).toBe(true)
})

afterEach(async () => {
  await Promise.all(
    temporary_directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function componentCircuitJson(pad_spacing: number): CircuitJson {
  return [
    {
      type: "source_component",
      source_component_id: "source_component_u1",
      ftype: "simple_chip",
      name: "U1",
      manufacturer_part_number: "MULTI-PART",
      supplier_part_numbers: {},
    },
    {
      type: "source_port",
      source_port_id: "source_port_u1_1",
      source_component_id: "source_component_u1",
      pin_number: 1,
      name: "IN",
      port_hints: ["pin1", "IN"],
    },
    {
      type: "source_port",
      source_port_id: "source_port_u1_2",
      source_component_id: "source_component_u1",
      pin_number: 2,
      name: "GND",
      port_hints: ["pin2", "GND"],
    },
    {
      type: "schematic_component",
      schematic_component_id: "schematic_component_u1",
      source_component_id: "source_component_u1",
      center: { x: 0, y: 0 },
      size: { width: 2, height: 2 },
      is_box_with_pins: true,
    },
    {
      type: "schematic_port",
      schematic_port_id: "schematic_port_u1_1",
      schematic_component_id: "schematic_component_u1",
      source_port_id: "source_port_u1_1",
      side_of_component: "left",
      center: { x: -1, y: 0 },
    },
    {
      type: "schematic_port",
      schematic_port_id: "schematic_port_u1_2",
      schematic_component_id: "schematic_component_u1",
      source_port_id: "source_port_u1_2",
      side_of_component: "right",
      center: { x: 1, y: 0 },
    },
    {
      type: "pcb_component",
      pcb_component_id: "pcb_component_u1",
      source_component_id: "source_component_u1",
      center: { x: 0, y: 0 },
      width: pad_spacing + 1,
      height: 1,
      layer: "top",
      rotation: 0,
      obstructs_within_bounds: true,
    },
    {
      type: "pcb_smtpad",
      pcb_smtpad_id: "pcb_smtpad_u1_1",
      pcb_component_id: "pcb_component_u1",
      shape: "rect",
      x: -pad_spacing / 2,
      y: 0,
      width: 0.5,
      height: 0.7,
      port_hints: ["pin1"],
      layer: "top",
    },
    {
      type: "pcb_smtpad",
      pcb_smtpad_id: "pcb_smtpad_u1_2",
      pcb_component_id: "pcb_component_u1",
      shape: "rect",
      x: pad_spacing / 2,
      y: 0,
      width: 0.5,
      height: 0.7,
      port_hints: ["pin2"],
      layer: "top",
    },
  ]
}

async function createFixture(): Promise<{ job: Job; job_dir: string }> {
  const job_dir = await mkdtemp(join(tmpdir(), "job-download-package-"))
  temporary_directories.push(job_dir)
  await mkdir(job_dir, { recursive: true })
  const component_code = 'export default () => <chip name="U1" />\n'
  await Bun.write(join(job_dir, "component.circuit.tsx"), component_code)
  const default_circuit = componentCircuitJson(1.5)
  const compact_circuit = componentCircuitJson(0.9)
  const reference_code =
    'import Component from "./component.circuit"\nexport default () => <Component name="U1" />\n'
  const generated_code =
    'import Component from "./component.circuit"\nexport default () => <Component name="U2" />\n'
  return {
    job_dir,
    job: {
      job_id: "job_multi_export",
      file_name: "multi-part.pdf",
      created_at: "2026-08-13T00:00:00.000Z",
      display_status: "complete",
      is_complete: true,
      has_errors: false,
      logs: [],
      component_ready: true,
      component_code,
      circuit_json: default_circuit,
      component_footprints: {
        default_footprint_id: "wide",
        footprints: [
          {
            footprint_id: "wide",
            label: "Wide",
            aliases: [],
            ordering_codes: [],
            package_name: "Wide package",
            pin_count: 2,
            circuit_json: default_circuit,
          },
          {
            footprint_id: "compact",
            label: "Compact",
            aliases: [],
            ordering_codes: [],
            package_name: "Compact package",
            pin_count: 2,
            circuit_json: compact_circuit,
          },
        ],
      },
      typical_application_code: reference_code,
      typical_application_circuit_json: default_circuit,
      typical_applications: {
        default_application_id: "reference",
        applications: [
          {
            application_id: "reference",
            title: "Datasheet reference",
            origin: "datasheet_reference",
            code: reference_code,
            circuit_json: default_circuit,
          },
          {
            application_id: "generated-monitor",
            title: "Generated monitor",
            origin: "ai_generated",
            code: generated_code,
            circuit_json: default_circuit,
          },
        ],
      },
    },
  }
}

test("component exports retain every footprint and provide self-contained TSX sources", async () => {
  const fixture = await createFixture()
  const tsx_package = await createJobDownloadPackage({
    file_kind: "component_tsx",
    ...fixture,
  })
  const kicad_package = await createJobDownloadPackage({
    file_kind: "component_kicad",
    ...fixture,
  })
  const altium_package = await createJobDownloadPackage({
    file_kind: "component_altium",
    ...fixture,
  })
  if (!tsx_package || !kicad_package || !altium_package) {
    throw new Error("Expected component download packages")
  }

  const tsx_zip = await JSZip.loadAsync(tsx_package.artifact_bytes)
  expect(Object.keys(tsx_zip.files)).toContain("index.circuit.tsx")

  const kicad_zip = await JSZip.loadAsync(kicad_package.artifact_bytes)
  const file_names = Object.keys(kicad_zip.files)
  expect(file_names.filter((name) => name.endsWith(".kicad_sym"))).toEqual([
    "symbols/multi-part_component.kicad_sym",
  ])
  expect(file_names.filter((name) => name.endsWith(".kicad_mod"))).toEqual([
    "footprints/multi-part_component.pretty/MULTI-PART.kicad_mod",
    "footprints/multi-part_component.pretty/MULTI-PART_compact.kicad_mod",
  ])
  expect(await kicad_zip.file("symbols/multi-part_component.kicad_sym")?.async("string")).toContain(
    'Footprint" "multi-part_component:MULTI-PART"',
  )
  expect(file_names).toContain("sources/index.circuit.tsx")
  expect(file_names).toContain("fp-lib-table")
  expect(file_names).toContain("sym-lib-table")

  const altium_zip = await JSZip.loadAsync(altium_package.artifact_bytes)
  const altium_file_names = Object.keys(altium_zip.files)
  expect(altium_file_names).toContain("multi-part-component.PrjPcb")
  expect(altium_file_names).toContain("multi-part-component.PcbDoc")
  expect(altium_file_names).toContain("multi-part-component.SchDoc")
  expect(altium_file_names).toContain("variants/2-compact/multi-part-component-compact.PrjPcb")
  expect(altium_file_names).toContain("sources/index.circuit.tsx")
})

test("each typical application exports its selected TSX bundle, KiCad project, and Altium project", async () => {
  const fixture = await createFixture()
  for (const application_id of ["reference", "generated-monitor"]) {
    const tsx_package = await createJobDownloadPackage({
      file_kind: "typical_application_tsx",
      application_id,
      ...fixture,
    })
    const kicad_package = await createJobDownloadPackage({
      file_kind: "typical_application_kicad",
      application_id,
      ...fixture,
    })
    const altium_package = await createJobDownloadPackage({
      file_kind: "typical_application_altium",
      application_id,
      ...fixture,
    })
    if (!tsx_package || !kicad_package || !altium_package) {
      throw new Error("Expected application download packages")
    }

    const tsx_zip = await JSZip.loadAsync(tsx_package.artifact_bytes)
    expect(Object.keys(tsx_zip.files)).toContain(`${application_id}.circuit.tsx`)
    expect(Object.keys(tsx_zip.files)).toContain("component.circuit.tsx")

    const kicad_zip = await JSZip.loadAsync(kicad_package.artifact_bytes)
    const file_names = Object.keys(kicad_zip.files)
    expect(file_names).toContain(`multi-part-${application_id}.kicad_sch`)
    expect(file_names).toContain(`multi-part-${application_id}.kicad_pcb`)
    expect(file_names).toContain(`multi-part-${application_id}.kicad_pro`)
    expect(file_names).toContain(`sources/${application_id}.circuit.tsx`)
    expect(file_names.filter((name) => name.endsWith(".kicad_mod"))).toHaveLength(2)

    const altium_zip = await JSZip.loadAsync(altium_package.artifact_bytes)
    const altium_file_names = Object.keys(altium_zip.files)
    expect(altium_file_names).toContain(`multi-part-${application_id}.PrjPcb`)
    expect(altium_file_names).toContain(`multi-part-${application_id}.PcbDoc`)
    expect(altium_file_names).toContain(`multi-part-${application_id}.SchDoc`)
    expect(altium_file_names).toContain(`sources/${application_id}.circuit.tsx`)
  }
})
