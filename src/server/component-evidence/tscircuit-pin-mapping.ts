import type { ComponentEvidence } from "./types"

const PHYSICAL_PIN_HINT_PREFIX = "__physical_pin__"

export interface TscircuitPinMapping {
  physical_pin: string
  tscircuit_pin_number: number
  physical_pin_hint: string
}

function encodePhysicalPin(value: string): string {
  return [...new TextEncoder().encode(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function decodePhysicalPin(value: string): string | undefined {
  if (!value.startsWith(PHYSICAL_PIN_HINT_PREFIX)) return undefined
  const encoded = value.slice(PHYSICAL_PIN_HINT_PREFIX.length)
  if (!encoded || encoded.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(encoded)) return undefined
  const bytes = Uint8Array.from(encoded.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16))
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

export function physicalPinHint(physical_pin: string): string {
  return `${PHYSICAL_PIN_HINT_PREFIX}${encodePhysicalPin(physical_pin)}`
}

export function physicalPinFromHints(hints: readonly string[]): string | undefined {
  for (const hint of hints) {
    const physical_pin = decodePhysicalPin(hint)
    if (physical_pin !== undefined) return physical_pin
  }
  return undefined
}

export function createTscircuitPinMappings(evidence: ComponentEvidence): TscircuitPinMapping[] {
  const numeric_pins = evidence.pinout.pins.map(({ number }) =>
    /^(?:pin)?[1-9]\d*$/i.test(number.trim())
      ? Number.parseInt(number.trim().replace(/^pin/i, ""), 10)
      : undefined,
  )
  const preserve_numeric_numbers =
    numeric_pins.every((number) => number !== undefined && Number.isSafeInteger(number)) &&
    new Set(numeric_pins).size === numeric_pins.length
  return evidence.pinout.pins.map((pin, index) => ({
    physical_pin: pin.number,
    tscircuit_pin_number: preserve_numeric_numbers ? numeric_pins[index]! : index + 1,
    physical_pin_hint: physicalPinHint(pin.number),
  }))
}
