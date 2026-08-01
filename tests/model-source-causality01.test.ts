import { describe, expect, test } from "bun:test"
import { buildModelGenerationPrompt, type ModelContract, validateModelSource } from "@/server/modeling"

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
  expect(prompt).toContain("model-card.md must name the public electrical stimulus")
})
