import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildAgentPrompt,
  buildTypicalApplicationPrompt,
  parseTypicalApplicationPlan,
  runJob,
} from "@/server/job-runner"
import { JobStore } from "@/server/job-store"

const fakeVisualInspectionHelpers = `
let eventSequence = 0
function emitAgentEvent(event) {
  console.log(JSON.stringify({ protocol: "tsci-agent-event-v1", sequence: ++eventSequence, ...event }))
}
function emitText(text) {
  emitAgentEvent({ type: "text_delta", text })
}
function finishAgent() {
  emitAgentEvent({ type: "agent_end", failed: false })
}
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (character) => character.charCodeAt(0))
async function recordVisualInspection(kind, status = "passed", resultHasImage = true) {
  const component = kind === "component"
  const reference = component ? "visual-reference/land-pattern.png" : "visual-reference/typical-application.png"
  const pcb = component ? "dist/index/pcb.png" : "dist/typical-application/pcb.png"
  const schematic = component ? "dist/index/schematic.png" : "dist/typical-application/schematic.png"
  const build = component ? "tsci build index.circuit.tsx" : "tsci build typical-application.circuit.tsx"
  const { mkdir } = await import("node:fs/promises")
  await mkdir(dir + "/visual-reference", { recursive: true })
  await mkdir(dir + "/" + (component ? "dist/index" : "dist/typical-application"), { recursive: true })
  await Bun.write(dir + "/" + reference, png)
  await Bun.write(dir + "/" + pcb, png)
  await Bun.write(dir + "/" + schematic, png)
  emitAgentEvent({ type: "tool_start", tool_call_id: "build", tool_name: "bash", args: { command: build } })
  emitAgentEvent({ type: "tool_end", tool_call_id: "build", tool_name: "bash", is_error: false, result_has_image: false })
  let readIndex = 0
  for (const path of [reference, pcb, schematic]) {
    const tool_call_id = "read-" + readIndex++
    emitAgentEvent({ type: "tool_start", tool_call_id, tool_name: "read", args: { path } })
    emitAgentEvent({ type: "tool_end", tool_call_id, tool_name: "read", is_error: false, result_has_image: resultHasImage })
  }
  const report = { version: 1, status, reference_image: reference, pcb_image: pcb, schematic_image: schematic }
  await Bun.write(dir + "/" + (component ? "component-visual-inspection.json" : "application-visual-inspection.json"), JSON.stringify(report))
  if (component) {
    await Bun.write(dir + "/footprint-plan.json", JSON.stringify({ version: 1, view: "pcb_top", source_references: [{ page: 9, figure: "Land pattern" }], pads: [{ pin: "1", kind: "smt", x: 0, y: 0, width: 0.6, height: 0.25 }] }))
  }
}
async function recordIndependentPlan(plan) {
  const { mkdir } = await import("node:fs/promises")
  const reference = "visual-reference/typical-application.png"
  const landReference = "visual-reference/land-pattern.png"
  await mkdir(dir + "/visual-reference", { recursive: true })
  await Bun.write(dir + "/" + reference, png)
  await Bun.write(dir + "/" + landReference, png)
  await Bun.write(dir + "/typical-application-plan.json", JSON.stringify(plan))
  await Bun.write(dir + "/footprint-plan.json", JSON.stringify({ version: 1, view: "pcb_top", source_references: [{ page: 9, figure: "Land pattern" }], pads: [{ pin: "1", kind: "smt", x: 0, y: 0, width: 0.6, height: 0.25 }] }))
  for (const [index, path] of [landReference, reference].entries()) {
    const tool_call_id = "reference-read-" + index
    emitAgentEvent({ type: "tool_start", tool_call_id, tool_name: "read", args: { path } })
    emitAgentEvent({ type: "tool_end", tool_call_id, tool_name: "read", is_error: false, result_has_image: true })
  }
}
`

test("agent prompt requires an implemented and build-verified TSX component", () => {
  const prompt = buildAgentPrompt("Use the QFN package")
  expect(prompt).toContain("datasheet.pdf")
  expect(prompt).toContain("Replace index.circuit.tsx")
  expect(prompt).toContain("tsci build")
  expect(prompt).toContain("`read` tool")
  expect(prompt).toContain("footprint and schematic renders")
  expect(prompt).toContain("aliases compact and readable")
  expect(prompt).toContain("pad-by-pad dimensional checklist")
  expect(prompt).toContain("placementDrcChecksDisabled")
  expect(prompt).toContain("typical-application-plan.json")
  expect(prompt).toContain("Do not create typical-application.circuit.tsx")
  expect(prompt).toContain("Use the QFN package")
  const application_prompt = buildTypicalApplicationPrompt("Use the QFN package")
  expect(application_prompt).toContain("server has independently")
  expect(application_prompt).toContain('"./index.circuit"')
  expect(application_prompt).toContain("PCB and schematic")
  expect(application_prompt).toContain("do not suppress placement DRC")
  expect(application_prompt).toContain("Use the QFN package")
  expect(
    parseTypicalApplicationPlan({
      version: 2,
      title: "Typical application",
      description: "Datasheet reference circuit",
      source_references: [{ page: 8, figure: "Figure 4" }],
      components: [
        { reference: "U1", kind: "sensor" },
        { reference: "C1", kind: "capacitor", value: "1uF" },
      ],
      connections: [{ net: "VCC", pins: ["U1.VCC", "C1.pin1"] }],
    }).source_references[0]?.page,
  ).toBe(8)
})

test("component readiness releases before the typical application completes", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-phases-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "phased-agent")
  const tsci_path = join(job_dir, "phased-tsci")
  await Promise.all([
    Bun.write(
      agent_path,
      `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
if (prompt.includes("phase 1")) {
  await Bun.write(dir + "/index.circuit.tsx", 'export default function Part() { return <chip name="U1" footprint="soic8" /> }\\n')
  await Bun.write(dir + "/typical-application-plan.json", JSON.stringify({ version: 2, title: "Typical sensor application", description: "Unverified draft with wrong pull-up", source_references: [{ page: 8, figure: "Figure 4" }], components: [{ reference: "U1", kind: "sensor" }, { reference: "C1", kind: "capacitor", value: "1uF" }], connections: [{ net: "VOUT", pins: ["U1.VOUT", "C1.pin1"] }, { net: "GND", pins: ["U1.GND", "C1.pin2"] }] }))
  await recordVisualInspection("component", "inconclusive", false)
  emitText("component phase complete")
} else if (prompt.includes("Independently extract")) {
  await recordIndependentPlan({ version: 2, title: "Typical sensor application", description: "Sensor with supply bypass", source_references: [{ page: 8, figure: "Figure 4" }], components: [{ reference: "U1", kind: "sensor" }, { reference: "C1", kind: "capacitor", value: "1uF" }], connections: [{ net: "VCC", pins: ["U1.VCC", "C1.pin1"] }, { net: "GND", pins: ["U1.GND", "C1.pin2"] }] })
} else {
  if (!(await Bun.file(dir + "/dist/index/circuit.json").exists())) throw new Error("component was not built before application phase")
  if (!(await Bun.file(dir + "/component.circuit.tsx").exists())) throw new Error("component snapshot was not published")
  await Bun.write(dir + "/typical-application.circuit.tsx", 'import Part from "./index.circuit"\\nexport default function TypicalApplication() { return <board><Part name="U1" /><capacitor name="C1" capacitance="1uF" /></board> }\\n')
  await recordVisualInspection("application", "inconclusive", false)
  emitText("application phase complete")
}
finishAgent()
`,
    ),
    Bun.write(
      tsci_path,
      `#!/usr/bin/env bun
import { appendFile, mkdir } from "node:fs/promises"
const target = Bun.argv.slice(2)[1]
const stem = target.replace(/\\.circuit\\.tsx$/, "")
await appendFile(process.cwd() + "/build-targets.log", target + "\\n")
await mkdir(process.cwd() + "/dist/" + stem, { recursive: true })
const circuit = target === "index.circuit.tsx" || target === "component-validation.circuit.tsx"
  ? [{ type: "source_component", source_component_id: "part", name: "U1" }, { type: "pcb_smtpad", pcb_smtpad_id: "pad1", pcb_component_id: "pcb1", pcb_port_id: "port1", port_hints: ["1"], x: 0, y: 0, width: 0.6, height: 0.25 }]
  : [
      { type: "source_component", source_component_id: "part", name: "U1" },
      { type: "source_port", source_port_id: "u1_vcc", source_component_id: "part", name: "VCC", subcircuit_connectivity_map_key: "vcc" },
      { type: "source_port", source_port_id: "u1_gnd", source_component_id: "part", name: "GND", subcircuit_connectivity_map_key: "gnd" },
      { type: "source_component", source_component_id: "cap", name: "C1", ftype: "simple_capacitor", capacitance: 0.000001 },
      { type: "source_port", source_port_id: "c1_1", source_component_id: "cap", name: "pin1", pin_number: 1, subcircuit_connectivity_map_key: "vcc" },
      { type: "source_port", source_port_id: "c1_2", source_component_id: "cap", name: "pin2", pin_number: 2, subcircuit_connectivity_map_key: "gnd" },
    ]
await Bun.write(process.cwd() + "/dist/" + stem + "/circuit.json", JSON.stringify(circuit))
`,
    ),
  ])
  await Promise.all([chmod(agent_path, 0o755), chmod(tsci_path, 0o755)])

  const job_store = new JobStore()
  const states: Array<{ component_ready?: boolean; is_complete: boolean }> = []
  job_store.createJob({ job_id: "job_phases", job_dir, file_name: "sensor.pdf" })
  job_store.subscribe("job_phases", (event) => {
    if (event.event_type !== "log") {
      states.push({ component_ready: event.job.component_ready, is_complete: event.job.is_complete })
    }
  })

  await runJob({ job_id: "job_phases" }, { job_store, agent_bin: agent_path, tsci_bin: tsci_path })

  const job = job_store.getJob("job_phases")
  expect(states.some((state) => state.component_ready === true && state.is_complete === false)).toBe(true)
  expect(job?.display_status).toBe("complete")
  expect(job?.component_ready).toBe(true)
  expect(job?.component_code).toContain("function Part")
  expect(await Bun.file(join(job_dir, "component.circuit.tsx")).text()).toBe(
    await Bun.file(join(job_dir, "index.circuit.tsx")).text(),
  )
  expect(job?.typical_application_code).toContain('from "./index.circuit"')
  expect(job?.circuit_json?.[0]?.type).toBe("source_component")
  expect(job?.typical_application_circuit_json?.[0]?.type).toBe("source_component")
  for (const path of [
    "dist/index/pcb.png",
    "dist/index/schematic.png",
    "dist/typical-application/pcb.png",
    "dist/typical-application/schematic.png",
  ]) {
    expect(await Bun.file(join(job_dir, path)).exists()).toBe(true)
  }
  expect(await Bun.file(join(job_dir, "typical-application-plan.draft.json")).text()).toContain('"VOUT"')
  expect(await Bun.file(join(job_dir, "typical-application-plan.json")).text()).toContain('"VCC"')
  expect(job?.logs.map((log) => log.message).join("\n")).toContain(
    "Component pixel inspection was inconclusive; continuing",
  )
  expect(job?.logs.map((log) => log.message).join("\n")).toContain(
    "Application pixel inspection was inconclusive; continuing",
  )
  expect(await Bun.file(join(job_dir, "build-targets.log")).text()).toBe(
    "index.circuit.tsx\ncomponent-validation.circuit.tsx\ntypical-application.circuit.tsx\n",
  )

  await rm(job_dir, { recursive: true, force: true })
})

test("semantic Circuit JSON errors keep the typical application from completing the job", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-clean-gate-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "clean-gate-agent")
  const tsci_path = join(job_dir, "clean-gate-tsci")
  await Promise.all([
    Bun.write(
      agent_path,
      `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
if (prompt.includes("phase 1")) {
  await Bun.write(dir + "/index.circuit.tsx", 'export default function Part() { return <chip name="U1" footprint="soic8" /> }\\n')
  await Bun.write(dir + "/typical-application-plan.json", JSON.stringify({ version: 2, title: "Typical application", description: "Datasheet circuit", source_references: [{ page: 8 }], components: [{ reference: "U1", kind: "sensor" }, { reference: "C1", kind: "capacitor", value: "1uF" }], connections: [{ net: "VCC", pins: ["U1.VCC", "C1.pin1"] }] }))
  await recordVisualInspection("component")
} else if (prompt.includes("Independently extract")) {
  await recordIndependentPlan({ version: 2, title: "Typical application", description: "Datasheet circuit", source_references: [{ page: 8 }], components: [{ reference: "U1", kind: "sensor" }, { reference: "C1", kind: "capacitor", value: "1uF" }], connections: [{ net: "VCC", pins: ["U1.VCC", "C1.pin1"] }] })
} else {
  await Bun.write(dir + "/typical-application.circuit.tsx", 'import Part from "./index.circuit"\\nexport default function Application() { return <board><Part name="U1" /></board> }\\n')
  await recordVisualInspection("application")
}
finishAgent()
`,
    ),
    Bun.write(
      tsci_path,
      `#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
const target = Bun.argv.slice(2)[1]
const stem = target.replace(/\\.circuit\\.tsx$/, "")
await mkdir(process.cwd() + "/dist/" + stem, { recursive: true })
const circuit = target === "index.circuit.tsx" || target === "component-validation.circuit.tsx"
  ? [{ type: "source_component", source_component_id: "part", name: "U1" }, { type: "pcb_smtpad", pcb_smtpad_id: "pad1", pcb_component_id: "pcb1", pcb_port_id: "port1", port_hints: ["1"], x: 0, y: 0, width: 0.6, height: 0.25 }]
  : [
      { type: "source_component", source_component_id: "application", name: "APP" },
      { type: "pcb_pad_pad_clearance_error", message: "C1 overlaps U1" },
    ]
await Bun.write(process.cwd() + "/dist/" + stem + "/circuit.json", JSON.stringify(circuit))
`,
    ),
  ])
  await Promise.all([chmod(agent_path, 0o755), chmod(tsci_path, 0o755)])

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_clean_gate", job_dir, file_name: "sensor.pdf" })

  await runJob({ job_id: "job_clean_gate" }, { job_store, agent_bin: agent_path, tsci_bin: tsci_path })

  const job = job_store.getJob("job_clean_gate")
  expect(job?.display_status).toBe("failed")
  expect(job?.is_complete).toBe(true)
  expect(job?.component_ready).toBe(true)
  expect(job?.typical_application_code).toContain("function Application")
  expect(job?.typical_application_circuit_json?.some((element) => element.type.endsWith("_error"))).toBe(true)
  expect(job?.error_message).toContain("Typical application failed clean build validation")
  expect(job?.error_message).toContain("pcb_pad_pad_clearance_error")

  await rm(job_dir, { recursive: true, force: true })
})

test("server-owned tsci board validation catches overlapping pads before component readiness", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-footprint-gate-"))
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  const agent_path = join(job_dir, "footprint-gate-agent")
  const tsci_path = join(job_dir, "footprint-gate-tsci")
  await Promise.all([
    Bun.write(
      agent_path,
      `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
${fakeVisualInspectionHelpers}
const plan = { version: 2, title: "Typical application", description: "Datasheet circuit", source_references: [{ page: 8 }], components: [{ reference: "U1", kind: "sensor" }, { reference: "C1", kind: "capacitor" }], connections: [{ net: "VCC", pins: ["U1.VCC", "C1.pin1"] }] }
if (prompt.includes("Independently extract")) {
  await recordIndependentPlan(plan)
} else {
  await Bun.write(dir + "/index.circuit.tsx", 'export default function Part() { return <chip name="U1" footprint="soic8" /> }\\n')
  await Bun.write(dir + "/typical-application-plan.json", JSON.stringify(plan))
  await recordVisualInspection("component")
}
finishAgent()
`,
    ),
    Bun.write(
      tsci_path,
      `#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
const target = Bun.argv.slice(2)[1]
const stem = target.replace(/\\.circuit\\.tsx$/, "")
await mkdir(process.cwd() + "/dist/" + stem, { recursive: true })
const circuit = target === "component-validation.circuit.tsx"
  ? [
      { type: "source_component", source_component_id: "part", name: "U1" },
      { type: "pcb_smtpad", pcb_smtpad_id: "pad1", pcb_component_id: "pcb1", pcb_port_id: "port1", port_hints: ["1"], x: 0, y: 0, width: 0.6, height: 0.25 },
      { type: "pcb_pad_pad_clearance_error", message: "U1.GND overlaps U1.L1" },
    ]
  : [{ type: "source_component", source_component_id: "part", name: "U1" }, { type: "pcb_smtpad", pcb_smtpad_id: "pad1", pcb_component_id: "pcb1", pcb_port_id: "port1", port_hints: ["1"], x: 0, y: 0, width: 0.6, height: 0.25 }]
await Bun.write(process.cwd() + "/dist/" + stem + "/circuit.json", JSON.stringify(circuit))
`,
    ),
  ])
  await Promise.all([chmod(agent_path, 0o755), chmod(tsci_path, 0o755)])

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_footprint_gate", job_dir, file_name: "sensor.pdf" })
  await runJob({ job_id: "job_footprint_gate" }, { job_store, agent_bin: agent_path, tsci_bin: tsci_path })

  const job = job_store.getJob("job_footprint_gate")
  expect(job?.display_status).toBe("failed")
  expect(job?.component_ready).not.toBe(true)
  expect(job?.error_message).toContain("failed board-level tsci validation")
  expect(job?.error_message).toContain("pcb_pad_pad_clearance_error")

  await rm(job_dir, { recursive: true, force: true })
})

test("cancelling a running job terminates its agent process", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-runner-cancel-"))
  const agent_path = join(job_dir, "slow-agent")
  await Bun.write(
    agent_path,
    `#!/usr/bin/env bun
console.log("slow agent started")
await Bun.sleep(30_000)
`,
  )
  await chmod(agent_path, 0o755)

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_cancel", job_dir, file_name: "sensor.pdf" })
  const run_promise = runJob(
    { job_id: "job_cancel" },
    { job_store, agent_bin: agent_path, tsci_bin: "unused-tsci" },
  )

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Agent did not start")), 2_000)
    const unsubscribe = job_store.subscribe("job_cancel", (job_event) => {
      if (job_event.event_type === "log" && job_event.log.message.includes("slow agent started")) {
        clearTimeout(timeout)
        unsubscribe?.()
        resolve()
      }
    })
  })

  expect(job_store.requestCancellation("job_cancel")).toBe("requested")
  await Promise.race([
    run_promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Cancellation timed out")), 4_000)),
  ])

  const job = job_store.getJob("job_cancel")
  expect(job?.display_status).toBe("cancelled")
  expect(job?.is_complete).toBe(true)
  expect(job?.has_errors).toBe(false)
  expect(job?.logs.at(-1)?.message).toContain("active job process was stopped")

  await rm(job_dir, { recursive: true, force: true })
})
