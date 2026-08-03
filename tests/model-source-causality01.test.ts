import { describe, expect, test } from "bun:test"
import {
  assertFreshModelTopologyIntegrity,
  buildModelGenerationPrompt,
  ModelStrategyRegistry,
  type ModelContract,
  validateModelSource,
} from "@/server/modeling"

const model_interface = {
  entry_name: "CAUSAL_TEST",
  pins: [{ spice_node: "IN" }, { spice_node: "OUT" }, { spice_node: "GND" }],
}

const time_pin_interface = {
  entry_name: "TIME_PIN_TEST",
  pins: [{ spice_node: "TIME" }, { spice_node: "OUT" }, { spice_node: "GND" }],
}

function source(body: string): string {
  return `.SUBCKT CAUSAL_TEST IN OUT GND\n${body}\n.ENDS CAUSAL_TEST\n`
}

describe("generated model causality boundary", () => {
  test("rejects autonomous behavioral expressions that read ngspice time", () => {
    const scripted_expressions = [
      "BPLAY OUT GND V=table(time, 0, 0, 1m, 1)",
      "BPLAY OUT GND V={if(TIME < 1m, 0, 1)}",
      "BPLAY OUT GND I=V(IN) * sin(2*pi*time)",
      "EPLAY OUT GND VALUE={table(time, 0, 0, 1m, 1)}",
      "RPLAY OUT GND R='time'",
      ".param playback=time\nBPLAY OUT GND V={playback}",
      ".func playback(x) {x + time}\nBPLAY OUT GND V=playback(V(IN))",
    ]

    for (const expression of scripted_expressions) {
      expect(() => validateModelSource(source(expression), model_interface)).toThrow(
        /model\.lib line \d+ contains an autonomous behavioral expression.*elapsed-time variable/,
      )
    }

    expect(() =>
      validateModelSource(
        ".SUBCKT CAUSAL_TEST IN OUT GND PARAMS: playback=time\nRLOAD OUT GND 1k\n.ENDS CAUSAL_TEST\n",
        model_interface,
      ),
    ).toThrow(/model\.lib line 1 contains an autonomous behavioral expression/)

    expect(() => validateModelSource(source("VPLAY OUT GND {time}"), model_interface)).toThrow(
      /model\.lib line 2 contains an autonomous source expression/,
    )
  })

  test("normalizes continuations before rejecting a split time script", () => {
    expect(() =>
      validateModelSource(source("BPLAY OUT GND V=table(\n+ time, 0, 0, 1m, 1)"), model_interface),
    ).toThrow(/model\.lib line 2 contains an autonomous behavioral expression/)
  })

  test("rejects every independent transient waveform source form inside the DUT", () => {
    const source_forms = [
      "VPLAY OUT GND PWL(0 0 1m 1)",
      "VPLAY OUT GND PWL 0 0 1m 1",
      "IPLAY OUT GND DC 0 PULSE(0 1m 0 1u 1u 1m 2m)",
      "VPLAY OUT GND SIN(0 1 1k)",
      "IPLAY OUT GND EXP(0 1 1u 1u 2u 1u)",
      "VPLAY OUT GND SFFM(0 1 1k 0.2 10)",
      "IPLAY OUT GND AM(1 1 10 1k 0)",
      "VPLAY OUT GND TRRANDOM(1 1u 0 1)",
      "IPLAY OUT GND TRNOISE(1m 1u 0)",
    ]

    for (const transient_source of source_forms) {
      expect(() => validateModelSource(source(transient_source), model_interface)).toThrow(
        /model\.lib line 2 contains an independent transient source/,
      )
    }

    expect(() =>
      validateModelSource(source("VPLAY OUT GND DC 0\n+ PULSE(0 1 0 1u 1u 1m 2m)"), model_interface),
    ).toThrow(/model\.lib line 2 contains an independent transient source/)
  })

  test("rejects opaque code models, scripted initial state, and autonomous randomness", () => {
    expect(() =>
      validateModelSource(
        source("AOSC [OUT] OSCILLATOR\n.MODEL OSCILLATOR d_osc(cntl_array=[0 1])"),
        model_interface,
      ),
    ).toThrow(/XSPICE code-model device/)
    expect(() => validateModelSource(source("CPLAY OUT GND 1u IC=1"), model_interface)).toThrow(
      /autonomous initial-condition script/,
    )
    expect(() => validateModelSource(source(".IC V(OUT)=1\nRLOAD OUT GND 1k"), model_interface)).toThrow(
      /autonomous initial-condition script/,
    )
    expect(() => validateModelSource(source("BPLAY OUT GND V=white(1)"), model_interface)).toThrow(
      /autonomous random\/noise expression/,
    )
  })

  test("rejects fixture-cancelling derivative operators and non-positive passives", () => {
    for (const derivative of [
      "BCANCEL OUT GND I={-22u*DDT(V(OUT,GND))}",
      "BSTATE OUT GND V={IDT(V(IN))}",
      "BWRAP OUT GND V={IDTMOD(V(IN), 1, 0)}",
    ]) {
      expect(() => validateModelSource(source(derivative), model_interface)).toThrow(
        /DDT\/IDT implicit derivative state/,
      )
    }
    for (const passive of ["CNEG OUT GND -22u", "RZERO OUT GND 0", "LNEG OUT GND -1e-6"]) {
      expect(() => validateModelSource(source(passive), model_interface)).toThrow(
        /non-positive passive value/,
      )
    }
  })

  test("allows a TIME pin and causal input-dependent equations and device state", () => {
    const causal_source = `.SUBCKT TIME_PIN_TEST TIME OUT GND
* Words in comments are not executable: table(time, ...) and PULSE(...)
RIN TIME NSTATE 1k
CSTATE NSTATE GND 1u
LSTATE NSTATE OUT 1m
BOUT OUT GND V=table(V(TIME), 0, 0, 1, 0.5, 5, 1)
ECLAMP NCLAMP GND VALUE={limit(V(TIME), 0, 5)}
RCLAMP NCLAMP GND 1k $ ignored replay example: table(time, 0, 0, 1, 1)
.ENDS TIME_PIN_TEST
`
    expect(() => validateModelSource(causal_source, time_pin_interface)).not.toThrow()
  })

  test("allows TIME as a formal helper-function argument supplied by an electrical input", () => {
    const causal_function = source(
      ".func scale(TIME) {TIME * 2}\nBOUT OUT GND V=scale(V(IN))\nRLOAD OUT GND 1k",
    )
    expect(() => validateModelSource(causal_function, model_interface)).not.toThrow()
  })
})

test("model-generation guidance makes the causal boundary and model-card disclosure explicit", () => {
  const contract = {
    version: 1,
    interface: {
      version: 1,
      part_number: "CAUSAL-TEST",
      entry_name: "CAUSAL_TEST",
      pins: [
        {
          physical_pin: "1",
          component_pin: "pin1",
          source_port_id: "source_port_1",
          spice_node: "IN",
          labels: ["IN"],
          role: "input",
        },
        {
          physical_pin: "2",
          component_pin: "pin2",
          source_port_id: "source_port_2",
          spice_node: "OUT",
          labels: ["OUT"],
          role: "output",
        },
        {
          physical_pin: "3",
          component_pin: "pin3",
          source_port_id: "source_port_3",
          spice_node: "GND",
          labels: ["GND"],
          role: "ground",
        },
      ],
    },
    characterization: {
      version: 1,
      family: "other",
      strategy: "behavioral",
      requirements: [],
      assumptions: [],
      limitations: [],
    },
  } satisfies ModelContract
  const prompt = buildModelGenerationPrompt({ contract, strategy_guidance: "Use causal equations." })

  expect(prompt).toContain("ngspice's built-in time variable")
  expect(prompt).toContain("PWL, PULSE, SIN, EXP, SFFM, AM")
  expect(prompt).toContain("XSPICE A/code-model devices")
  expect(prompt).toContain("Do not use DDT, IDT, or IDTMOD")
  expect(prompt).toContain("Every literal R, C, and L value must be positive")
  expect(prompt).toContain("zero-at-equilibrium deviation states")
  expect(prompt).toContain("zero-state startup neutral")
  expect(prompt).toContain("model-card.md must name the public electrical stimulus")
})

describe("fresh power-converter topology integrity", () => {
  const contract = {
    version: 1,
    interface: {
      version: 1,
      part_number: "CONVERTER-TEST",
      entry_name: "CONVERTER_TEST",
      pins: [
        {
          physical_pin: "1",
          component_pin: "vin",
          source_port_id: "source_port_1",
          spice_node: "VIN",
          labels: ["VIN"],
          role: "power_input",
        },
        {
          physical_pin: "2",
          component_pin: "vout",
          source_port_id: "source_port_2",
          spice_node: "VOUT",
          labels: ["VOUT"],
          role: "power_output",
        },
        {
          physical_pin: "3",
          component_pin: "gnd",
          source_port_id: "source_port_3",
          spice_node: "GND",
          labels: ["GND"],
          role: "ground",
        },
      ],
    },
    characterization: {
      version: 1,
      family: "power_converter",
      strategy: "behavioral",
      requirements: [
        {
          requirement_id: "load_step",
          title: "Load step",
          behavior: "Regulate VOUT during a load step",
          analysis: "transient",
          support: { status: "modeled" },
          conditions: {},
          expected: { unit: "V" },
          reference_curve: {
            x_quantity: "time",
            x_unit: "s",
            y_quantity: "voltage",
            y_unit: "V",
            points: [
              { x: 0, y: 3.3 },
              { x: 1e-6, y: 3.2 },
            ],
            electrical_binding: {
              response: { type: "voltage", positive: "dut.VOUT", negative: "gnd" },
              stimulus: {
                type: "current_step",
                positive: "dut.VOUT",
                negative: "gnd",
                pulse: { low: 0.1, high: 1, delay: 1e-6, rise: 1e-7, fall: 1e-7, width: 5e-6, period: 20e-6 },
              },
            },
          },
          sources: [{ page: 1, locator: "Figure 1", statement: "Load transient" }],
        },
      ],
      assumptions: [],
      limitations: [],
    },
  } satisfies ModelContract

  const valid = `.SUBCKT CONVERTER_TEST VIN VOUT GND
BERR NERR GND I={3.3-V(VOUT,GND)}
CCTRL NERR GND 1u
RCTRL NERR GND 10k
BDRIVE NREG GND V={3.3+V(NERR,GND)}
ROUT NREG VOUT 100m
.ENDS CONVERTER_TEST
`

  test("allows private error-driven controller state behind finite output impedance", () => {
    expect(() => assertFreshModelTopologyIntegrity(valid, contract)).not.toThrow()
  })

  test("rejects direct and zero-volt-sensor output energy-storage mirrors", () => {
    for (const body of [
      "CFAST VOUT GND 1u",
      "VCAP VOUT NCAP 0\nCSENSE NCAP GND 22u",
      "VCAP VOUT NCAP DC 0\nLFAKE NCAP GND 1u",
    ]) {
      const candidate = `.SUBCKT CONVERTER_TEST VIN VOUT GND\n${body}\n.ENDS CONVERTER_TEST\n`
      expect(() => assertFreshModelTopologyIntegrity(candidate, contract)).toThrow(
        /energy storage to a modeled power-converter output/,
      )
    }
  })

  test("rejects a fixed independent current on the modeled output", () => {
    const candidate = `.SUBCKT CONVERTER_TEST VIN VOUT GND
IBIAS GND VOUT 0.1
.ENDS CONVERTER_TEST
`
    expect(() => assertFreshModelTopologyIntegrity(candidate, contract)).toThrow(
      /output current must arise from the causal regulator loop/,
    )
  })

  test("rejects synthetic startup state in the modeled output driver", () => {
    const candidate = `.SUBCKT CONVERTER_TEST VIN VOUT GND
CSTART START GND 1u
RSTART START GND 1G
BSTARTSTATE GND START I={20*(V(VIN,GND)-V(START,GND))}
BSTART GND NSTART I={(1-V(START,GND))*(3.3-V(VOUT,GND))}
ROUT NSTART VOUT 10m
.ENDS CONVERTER_TEST
`
    expect(() => assertFreshModelTopologyIntegrity(candidate, contract)).toThrow(
      /private state start.*not driven by the measured output response/,
    )
  })

  test("allows output drivers to depend on private state driven by output error", () => {
    const candidate = `.SUBCKT CONVERTER_TEST VIN VOUT GND
CCTRL CTRL GND 1u
RCTRL CTRL GND 1G
BERROR GND CTRL I={3.3-V(VOUT,GND)}
BDRIVE GND NREG I={(3.3+V(CTRL,GND)-V(NREG,GND))/0.1}
ROUT NREG VOUT 10m
.ENDS CONVERTER_TEST
`
    expect(() => assertFreshModelTopologyIntegrity(candidate, contract)).not.toThrow()
  })

  test("gives power converters a causal averaged-regulator strategy", () => {
    const guidance = new ModelStrategyRegistry().require("behavioral", "power_converter").guidance
    expect(guidance).toContain("averaged closed-loop regulator")
    expect(guidance).toContain("positive finite output resistance")
    expect(guidance).toContain("server-owned application fixture")
    expect(guidance).toContain("first reference sample")
  })
})
