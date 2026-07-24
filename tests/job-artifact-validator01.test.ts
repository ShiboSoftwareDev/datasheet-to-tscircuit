import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import { AGENT_EVENT_PROTOCOL, type TrustedAgentEvent } from "@/server/agent-event-protocol"
import {
  assertVisualInspectionSnapshotMatches,
  captureVisualInspectionSnapshot,
  getApplicationSchematicLayoutAdvisories,
  getFootprintPlanErrors,
  getTypicalApplicationComponentValueErrors,
  getTypicalApplicationConnectivityErrors,
  getTypicalApplicationSourceErrors,
  validateAgentImageReads,
  validateVisualInspection,
} from "@/server/job-artifact-validator"

test("application source gate rejects only standalone netlabel JSX elements", () => {
  expect(
    getTypicalApplicationSourceErrors(
      '<board><netlabel net="VIN" /><trace from=".U1 > .VIN" to="net.VIN" /></board>',
    ),
  ).toEqual(["Typical application source must not instantiate <netlabel> elements"])
  expect(
    getTypicalApplicationSourceErrors(
      '<board><netalias net="VIN" /><trace from=".U1 > .VIN" to="net.VIN" schDisplayLabel="VIN" /></board>',
    ),
  ).toEqual([])
  expect(getTypicalApplicationSourceErrors('<trace from=".U1 > .VIN" to={sel.net.VIN} />')).toEqual([])
  expect(
    getTypicalApplicationSourceErrors(
      '<board><inductor name="L1" footprint="0805" pcbX={1} /></board>',
      "schematic_only",
    ),
  ).toEqual([
    "Schematic-only typical application source must not assign PCB footprints",
    "Schematic-only typical application source must not assign PCB placement props",
  ])

  const verified_plan = {
    components: [
      { reference: "U1" },
      {
        reference: "L1",
        manufacturer_part_number: "DFE201612E-R47M",
        footprint: "0805",
      },
    ],
    connections: [{ net: "SW", pins: ["U1.SW", "L1.pin1"] }],
  }
  expect(
    getTypicalApplicationSourceErrors(
      '<board><inductor name="L1" inductance="0.47uH" manufacturerPartNumber="DFE201612E-R47M" footprint="0805" /></board>',
      "verified",
      verified_plan,
    ),
  ).toEqual([])
  expect(
    getTypicalApplicationSourceErrors(
      '<board><inductor name="L1" inductance="0.47uH" manufacturerPartNumber="DFE201612E-R47M" footprint="0402" /></board>',
      "verified",
      verified_plan,
    ),
  ).toContain('Verified PCB component L1 must set literal footprint="0805"')

  const schematic_only_plan = {
    components: [
      { reference: "U1" },
      {
        reference: "C1",
        manufacturer_part_number: "GRM188R60J106ME84",
      },
    ],
    connections: [{ net: "VIN", pins: ["U1.VIN", "C1.pin1"] }],
  }
  expect(
    getTypicalApplicationSourceErrors(
      '<group><capacitor name="C1" capacitance="10uF" /></group>',
      "schematic_only",
      schematic_only_plan,
    ),
  ).toEqual(['Application component C1 must set literal manufacturerPartNumber="GRM188R60J106ME84"'])
  expect(
    getTypicalApplicationSourceErrors(
      '<group><capacitor name="C1" capacitance="10uF" manufacturerPartNumber="GRM188R60J106ME84" /></group>',
      "schematic_only",
      schematic_only_plan,
    ),
  ).toEqual([])
})

test("compiled application schematic reports long-wire compactness as an advisory", () => {
  const circuit = [
    ...Array.from({ length: 7 }, (_, index) => ({
      type: "schematic_component",
      schematic_component_id: `component-${index}`,
      source_component_id: `source-${index}`,
      center: { x: index, y: 0 },
    })),
    { type: "schematic_net_label", schematic_net_label_id: "label-1", text: "VIN" },
    {
      type: "schematic_trace",
      schematic_trace_id: "trace-1",
      edges: [{ from: { x: -5, y: 0 }, to: { x: 4.5, y: 0 } }],
    },
  ] as unknown as AnyCircuitElement[]
  const advisories = getApplicationSchematicLayoutAdvisories(circuit)
  expect(advisories).toHaveLength(1)
  expect(advisories[0]).toContain("is 9.50 units long")
  expect(advisories[0]).toContain("compact-layout target")

  expect(
    getApplicationSchematicLayoutAdvisories([
      { type: "schematic_component", center: { x: 0, y: 0 } },
      {
        type: "schematic_trace",
        edges: [{ from: { x: 0, y: 0 }, to: { x: 3, y: 0 } }],
      },
    ] as unknown as AnyCircuitElement[]),
  ).toEqual([])

  const observed_runs = [6.9, 7.13].map((length) =>
    getApplicationSchematicLayoutAdvisories([
      ...Array.from({ length: 7 }, (_, index) => ({
        type: "schematic_component",
        center: { x: index, y: 0 },
      })),
      {
        type: "schematic_trace",
        edges: [{ from: { x: 0, y: 0 }, to: { x: length, y: 0 } }],
      },
    ] as unknown as AnyCircuitElement[]),
  )
  expect(observed_runs[0]?.[0]).toContain("is 6.90 units long")
  expect(observed_runs[1]?.[0]).toContain("is 7.13 units long")
})

const connectivityPlan = {
  components: [{ reference: "U1" }, { reference: "R3" }],
  connections: [
    { net: "VIN", pins: ["U1.VIN", "R3.pin1"] },
    { net: "PG", pins: ["U1.PG", "R3.pin2"] },
  ],
}

function applicationCircuit(r3_pullup_net: "vin" | "vout"): AnyCircuitElement[] {
  return [
    { type: "source_component", source_component_id: "u1", name: "U1" },
    {
      type: "source_port",
      source_port_id: "u1_vin",
      source_component_id: "u1",
      name: "VIN",
      subcircuit_connectivity_map_key: "vin",
    },
    {
      type: "source_port",
      source_port_id: "u1_pg",
      source_component_id: "u1",
      name: "PG",
      subcircuit_connectivity_map_key: "pg",
    },
    { type: "source_component", source_component_id: "r3", name: "R3" },
    {
      type: "source_port",
      source_port_id: "r3_1",
      source_component_id: "r3",
      name: "pin1",
      pin_number: 1,
      subcircuit_connectivity_map_key: r3_pullup_net,
    },
    {
      type: "source_port",
      source_port_id: "r3_2",
      source_component_id: "r3",
      name: "pin2",
      pin_number: 2,
      subcircuit_connectivity_map_key: "pg",
    },
  ] as unknown as AnyCircuitElement[]
}

test("datasheet connectivity gate catches a cleanly-built pull-up on the wrong net", () => {
  expect(getTypicalApplicationConnectivityErrors(connectivityPlan, applicationCircuit("vin"))).toEqual([])
  expect(getTypicalApplicationConnectivityErrors(connectivityPlan, applicationCircuit("vout"))).toEqual([
    "VIN: expected pins are not electrically connected: U1.VIN, R3.pin1",
  ])
})

test("datasheet connectivity resolves punctuation-bearing endpoints through polarity aliases", () => {
  const plan = {
    components: [{ reference: "U1" }, { reference: "R1" }],
    connections: [
      { net: "SENSE_POS", pins: ["U1.IN+", "R1.1"] },
      { net: "SENSE_NEG", pins: ["U1.IN−", "R1.2"] },
    ],
  }
  const circuit = [
    { type: "source_component", source_component_id: "u1", name: "U1" },
    { type: "source_component", source_component_id: "r1", name: "R1" },
    {
      type: "source_port",
      source_port_id: "u1_pos",
      source_component_id: "u1",
      name: "IN_POS",
      port_hints: ["IN_POS", "pin10", "10"],
      subcircuit_connectivity_map_key: "sense-pos",
    },
    {
      type: "source_port",
      source_port_id: "u1_neg",
      source_component_id: "u1",
      name: "IN_NEG",
      port_hints: ["IN_NEG", "pin9", "9"],
      subcircuit_connectivity_map_key: "sense-neg",
    },
    {
      type: "source_port",
      source_port_id: "r1_1",
      source_component_id: "r1",
      name: "pin1",
      pin_number: 1,
      subcircuit_connectivity_map_key: "sense-pos",
    },
    {
      type: "source_port",
      source_port_id: "r1_2",
      source_component_id: "r1",
      name: "pin2",
      pin_number: 2,
      subcircuit_connectivity_map_key: "sense-neg",
    },
  ]

  expect(getTypicalApplicationConnectivityErrors(plan, circuit as unknown as AnyCircuitElement[])).toEqual([])

  circuit[2]!.name = "IN_NEG"
  circuit[2]!.port_hints = ["IN_NEG", "pin10", "10"]
  circuit[3]!.name = "IN_POS"
  circuit[3]!.port_hints = ["IN_POS", "pin9", "9"]
  expect(getTypicalApplicationConnectivityErrors(plan, circuit as unknown as AnyCircuitElement[])).toEqual([
    "SENSE_POS: expected pins are not electrically connected: U1.IN+, R1.1",
    "SENSE_NEG: expected pins are not electrically connected: U1.IN−, R1.2",
  ])
})

test("datasheet connectivity accepts swapped pins only for interchangeable passives", () => {
  const plan = {
    components: [{ reference: "U1" }, { reference: "L1" }],
    connections: [
      { net: "SW_L1", pins: ["U1.L1", "L1.1"] },
      { net: "SW_L2", pins: ["U1.L2", "L1.2"] },
    ],
  }
  const circuit = (interchangeable: boolean) =>
    [
      { type: "source_component", source_component_id: "u1", name: "U1" },
      {
        type: "source_component",
        source_component_id: "l1",
        name: "L1",
        are_pins_interchangeable: interchangeable,
      },
      {
        type: "source_port",
        source_port_id: "u1_l1",
        source_component_id: "u1",
        name: "L1",
        subcircuit_connectivity_map_key: "switch-a",
      },
      {
        type: "source_port",
        source_port_id: "u1_l2",
        source_component_id: "u1",
        name: "L2",
        subcircuit_connectivity_map_key: "switch-b",
      },
      {
        type: "source_port",
        source_port_id: "l1_pin1",
        source_component_id: "l1",
        name: "pin1",
        pin_number: 1,
        subcircuit_connectivity_map_key: "switch-b",
      },
      {
        type: "source_port",
        source_port_id: "l1_pin2",
        source_component_id: "l1",
        name: "pin2",
        pin_number: 2,
        subcircuit_connectivity_map_key: "switch-a",
      },
    ] as unknown as AnyCircuitElement[]

  expect(getTypicalApplicationConnectivityErrors(plan, circuit(true))).toEqual([])
  expect(getTypicalApplicationConnectivityErrors(plan, circuit(false))).toEqual([
    "SW_L1: expected pins are not electrically connected: U1.L1, L1.1",
    "SW_L2: expected pins are not electrically connected: U1.L2, L1.2",
  ])
})

test("footprint gate catches a special pad whose width was copied from the ordinary pads", () => {
  const plan = {
    version: 1 as const,
    view: "pcb_top" as const,
    source_references: [{ page: 31, figure: "DLA0010A land pattern" }],
    pads: [
      { pin: "1", kind: "smt" as const, x: -1, y: 0, width: 0.6, height: 0.3 },
      { pin: "8", kind: "smt" as const, x: 1, y: 0, width: 1.3, height: 0.3 },
    ],
  }
  const circuit = [
    { type: "pcb_smtpad", port_hints: ["1"], x: -1, y: 0, width: 0.6, height: 0.3 },
    { type: "pcb_smtpad", port_hints: ["8"], x: 1, y: 0, width: 0.9, height: 0.3 },
  ] as unknown as AnyCircuitElement[]

  expect(getFootprintPlanErrors(plan, circuit)).toEqual(["Pin 8: width 0.9 mm (expected 1.3 mm)"])
})

test("footprint gate validates unassigned mechanical copper without inventing an electrical pin", () => {
  const plan = {
    version: 1 as const,
    view: "pcb_top" as const,
    source_references: [{ page: 4 }],
    pads: [{ pin: null, kind: "smt" as const, x: 0, y: 2, width: 1.2, height: 1.2 }],
  }
  const circuit = [
    { type: "pcb_smtpad", x: 0, y: 2, width: 1.2, height: 1.2 },
  ] as unknown as AnyCircuitElement[]

  expect(getFootprintPlanErrors(plan, circuit)).toEqual([])
})

test("application value gate catches a changed feedback-divider value", () => {
  const plan = {
    components: [
      { reference: "R1", kind: "resistor", value: "511k" },
      { reference: "R2", kind: "resistor", value: "100k" },
    ],
    connections: [{ net: "FB", pins: ["R1.pin2", "R2.pin1"] }],
  }
  const circuit = [
    { type: "source_component", source_component_id: "r1", name: "R1", resistance: 511_000 },
    { type: "source_component", source_component_id: "r2", name: "R2", resistance: 110_000 },
  ] as unknown as AnyCircuitElement[]

  expect(getTypicalApplicationComponentValueErrors(plan, circuit)).toEqual([
    "Application component R2 has resistance 110000, expected 100k",
  ])
})

test("application component gate enforces sourced manufacturer part numbers", () => {
  const plan = {
    components: [
      {
        reference: "L1",
        kind: "inductor",
        value: "0.47uH",
        manufacturer_part_number: "DFE201612E-R47M",
        footprint: "0805",
      },
    ],
    connections: [{ net: "SW", pins: ["L1.pin1", "L1.pin2"] }],
  }
  const circuit = [
    {
      type: "source_component",
      source_component_id: "l1",
      name: "L1",
      inductance: "0.47uH",
      manufacturer_part_number: "UNSOURCED-0805",
    },
    {
      type: "cad_component",
      cad_component_id: "l1-cad",
      pcb_component_id: "l1-pcb",
      source_component_id: "l1",
      footprinter_string: "0402",
      position: { x: 0, y: 0, z: 0 },
      model_object_fit: "contain_within_bounds",
    },
  ] as unknown as AnyCircuitElement[]

  expect(getTypicalApplicationComponentValueErrors(plan, circuit)).toContain(
    'Application component L1 has manufacturer part number "UNSOURCED-0805", expected "DFE201612E-R47M"',
  )
  expect(getTypicalApplicationComponentValueErrors(plan, circuit)).toContain(
    'Application component L1 has footprint "0402", expected "0805"',
  )
})

test("application component gate trusts the generated target IC ordering code", () => {
  const plan = {
    components: [
      {
        reference: "U1",
        kind: "buck-boost converter",
        manufacturer_part_number: "TPS63802DLA",
      },
    ],
    connections: [],
  }
  const circuit = [
    {
      type: "source_component",
      source_component_id: "u1",
      name: "U1",
      manufacturer_part_number: "TPS63802DLAR",
    },
  ] as unknown as AnyCircuitElement[]

  expect(getTypicalApplicationComponentValueErrors(plan, circuit)).toEqual([])
})

test("visual gate accepts honest inconclusive reports but rejects unsupported pass claims", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-visual-gate-"))
  const png = Uint8Array.from(
    atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
    (character) => character.charCodeAt(0),
  )
  const expected_images = {
    reference: "visual-reference/land-pattern.png",
    pcb: "dist/index/pcb.png",
    schematic: "dist/index/schematic.png",
  }
  await Promise.all([
    mkdir(join(job_dir, "visual-reference"), { recursive: true }),
    mkdir(join(job_dir, "dist/index"), { recursive: true }),
  ])
  for (const path of Object.values(expected_images)) await Bun.write(join(job_dir, path), png)
  await Bun.write(
    join(job_dir, "component-visual-inspection.json"),
    JSON.stringify({
      version: 1,
      status: "passed",
      reference_image: expected_images.reference,
      pcb_image: expected_images.pcb,
      schematic_image: expected_images.schematic,
    }),
  )
  const events: TrustedAgentEvent[] = [
    {
      protocol: AGENT_EVENT_PROTOCOL,
      sequence: 1,
      type: "tool_start",
      tool_call_id: "build",
      tool_name: "bash",
      args: { command: "tsci build index.circuit.tsx" },
    },
    {
      protocol: AGENT_EVENT_PROTOCOL,
      sequence: 2,
      type: "tool_end",
      tool_call_id: "build",
      tool_name: "bash",
      is_error: false,
      result_has_image: false,
    },
    ...Object.values(expected_images).flatMap((path, index): TrustedAgentEvent[] => [
      {
        protocol: AGENT_EVENT_PROTOCOL,
        sequence: index * 2 + 3,
        type: "tool_start",
        tool_call_id: `read-${index}`,
        tool_name: "read",
        args: { path },
      },
      {
        protocol: AGENT_EVENT_PROTOCOL,
        sequence: index * 2 + 4,
        type: "tool_end",
        tool_call_id: `read-${index}`,
        tool_name: "read",
        is_error: false,
        result_has_image: true,
      },
    ]),
  ]
  const input = {
    job_dir,
    events,
    report_file: "component-visual-inspection.json",
    build_command: "tsci build index.circuit.tsx",
    expected_images,
  }
  await expect(validateVisualInspection(input)).resolves.toEqual({ status: "passed" })
  await Bun.write(
    join(job_dir, "component-visual-inspection.json"),
    JSON.stringify({
      version: 1,
      status: "passed",
      reference_image: expected_images.reference,
      schematic_image: expected_images.schematic,
    }),
  )
  await expect(validateVisualInspection(input)).rejects.toThrow(
    `must set pcb_image to ${expected_images.pcb}`,
  )
  await expect(
    validateVisualInspection({
      ...input,
      expected_images: {
        reference: expected_images.reference,
        schematic: expected_images.schematic,
      },
    }),
  ).resolves.toEqual({ status: "passed" })
  await Bun.write(
    join(job_dir, "component-visual-inspection.json"),
    JSON.stringify({
      version: 1,
      status: "passed",
      reference_image: expected_images.reference,
      pcb_image: expected_images.pcb,
      schematic_image: expected_images.schematic,
    }),
  )
  await expect(
    validateVisualInspection({
      ...input,
      expected_images: {
        reference: expected_images.reference,
        schematic: expected_images.schematic,
      },
    }),
  ).rejects.toThrow("must omit pcb_image")
  for (const executable of ["npx tsci", "bunx tsci", "./node_modules/.bin/tsci", "node_modules/.bin/tsci"]) {
    const wrapped_events: TrustedAgentEvent[] = events.map((event) =>
      event.type === "tool_start" && event.tool_call_id === "build"
        ? {
            ...event,
            args: {
              command: `${executable} build index.circuit.tsx --ignore-warnings --pcb-png --schematic-svgs`,
            },
          }
        : event,
    )
    await expect(validateVisualInspection({ ...input, events: wrapped_events })).resolves.toEqual({
      status: "passed",
    })
  }
  for (const environment_prefix of [
    "NODE_ENV=development",
    'NODE_ENV="development"',
    "env NODE_ENV='development'",
  ]) {
    const environment_prefixed_events: TrustedAgentEvent[] = events.map((event) =>
      event.type === "tool_start" && event.tool_call_id === "build"
        ? {
            ...event,
            args: {
              command: `${environment_prefix} tsci build index.circuit.tsx --ignore-warnings --pcb-png --schematic-svgs`,
            },
          }
        : event,
    )
    await expect(
      validateVisualInspection({ ...input, events: environment_prefixed_events }),
    ).resolves.toEqual({ status: "passed" })
  }
  await expect(
    validateVisualInspection({
      ...input,
      events: events.map((event) =>
        event.type === "tool_start" && event.tool_call_id === "build"
          ? {
              ...event,
              args: { command: "NODE_ENV=production tsci build index.circuit.tsx" },
            }
          : event,
      ),
    }),
  ).rejects.toThrow("missing final build command")
  await expect(
    validateVisualInspection({
      ...input,
      events: events.map((event) =>
        event.type === "tool_start" && event.tool_call_id === "build"
          ? {
              ...event,
              args: { command: "npx tsci build index.circuit.tsx && touch unexpected" },
            }
          : event,
      ),
    }),
  ).rejects.toThrow("missing final build command")
  await Bun.write(
    join(job_dir, "component-visual-inspection.json"),
    JSON.stringify({
      version: 1,
      status: "passed",
      reference_image: expected_images.reference,
      pcb_render: expected_images.pcb,
      schematic_render: expected_images.schematic,
    }),
  )
  await expect(validateVisualInspection(input)).resolves.toEqual({ status: "passed" })
  const canonical_report = JSON.parse(
    await Bun.file(join(job_dir, "component-visual-inspection.json")).text(),
  )
  expect(canonical_report.pcb_image).toBe(expected_images.pcb)
  expect(canonical_report.schematic_image).toBe(expected_images.schematic)
  expect(canonical_report.basis).toBe("agent_visual_attestation")
  expect(canonical_report.pcb_render).toBeUndefined()
  await expect(
    validateVisualInspection({
      ...input,
      events: [
        ...events,
        {
          protocol: AGENT_EVENT_PROTOCOL,
          sequence: 9,
          type: "text_delta",
          text: "There are no pixels present.",
        },
      ],
    }),
  ).rejects.toThrow("Image inspection was unavailable")
  await expect(
    validateVisualInspection({
      ...input,
      events: events.map((event) =>
        event.type === "tool_end" && event.tool_call_id === "read-2"
          ? { ...event, result_has_image: false }
          : event,
      ),
    }),
  ).rejects.toThrow("was not successfully inspected as pixels")

  await Bun.write(
    join(job_dir, "component-visual-inspection.json"),
    JSON.stringify({ version: 1, status: "inconclusive" }),
  )
  await expect(
    validateVisualInspection({
      ...input,
      events: events.map((event) =>
        event.type === "tool_end" && event.tool_name === "read"
          ? { ...event, result_has_image: false }
          : event,
      ),
    }),
  ).resolves.toEqual({ status: "inconclusive" })

  await expect(
    validateAgentImageReads({
      job_dir,
      expected_images: [expected_images.reference],
      events: [
        {
          protocol: AGENT_EVENT_PROTOCOL,
          sequence: 1,
          type: "tool_start",
          tool_call_id: "read-resize-failure",
          tool_name: "read",
          args: { path: expected_images.reference },
        },
        {
          protocol: AGENT_EVENT_PROTOCOL,
          sequence: 2,
          type: "tool_end",
          tool_call_id: "read-resize-failure",
          tool_name: "read",
          is_error: false,
          result_has_image: false,
          result_text:
            "Read image file [image/png]\n[Image omitted: could not be resized below the inline image size limit.]",
        },
      ],
    }),
  ).rejects.toThrow("Image inspection was unavailable")

  const snapshot = await captureVisualInspectionSnapshot({ job_dir, expected_images })
  await Bun.write(join(job_dir, expected_images.pcb), "different authoritative render")
  await expect(assertVisualInspectionSnapshotMatches({ job_dir, snapshot })).rejects.toThrow(
    "did not reproduce the agent-inspected image",
  )

  await rm(job_dir, { recursive: true, force: true })
})

test("evidence image inspection accepts a byte-identical canonical copy", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-evidence-image-alias-"))
  const png = Uint8Array.from(
    atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
    (character) => character.charCodeAt(0),
  )
  const rendered_page = "visual-reference/pages/page-036.png"
  const canonical_reference = "visual-reference/land-pattern.png"
  await mkdir(join(job_dir, "visual-reference/pages"), { recursive: true })
  await Promise.all([
    Bun.write(join(job_dir, rendered_page), png),
    Bun.write(join(job_dir, canonical_reference), png),
  ])
  const events: TrustedAgentEvent[] = [
    {
      protocol: AGENT_EVENT_PROTOCOL,
      sequence: 1,
      type: "tool_start",
      tool_call_id: "read-rendered-page",
      tool_name: "read",
      args: { path: rendered_page },
    },
    {
      protocol: AGENT_EVENT_PROTOCOL,
      sequence: 2,
      type: "tool_end",
      tool_call_id: "read-rendered-page",
      tool_name: "read",
      is_error: false,
      result_has_image: true,
    },
  ]

  await expect(
    validateAgentImageReads({
      job_dir,
      events,
      expected_images: [canonical_reference],
      allow_identical_copies: true,
    }),
  ).resolves.toBeUndefined()

  await Bun.write(join(job_dir, canonical_reference), Uint8Array.from([...png, 0]))
  await expect(
    validateAgentImageReads({
      job_dir,
      events,
      expected_images: [canonical_reference],
      allow_identical_copies: true,
    }),
  ).rejects.toThrow("was not successfully inspected as pixels")

  await rm(job_dir, { recursive: true, force: true })
})
