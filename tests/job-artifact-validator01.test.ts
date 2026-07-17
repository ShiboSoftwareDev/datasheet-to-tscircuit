import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import { AGENT_EVENT_PROTOCOL, type TrustedAgentEvent } from "@/server/agent-event-protocol"
import {
  getFootprintPlanErrors,
  getTypicalApplicationComponentValueErrors,
  getTypicalApplicationConnectivityErrors,
  validateVisualInspection,
} from "@/server/job-artifact-validator"

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
  ).rejects.toThrow("Visual inspection was inconclusive")
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

  await rm(job_dir, { recursive: true, force: true })
})
