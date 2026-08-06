import type { AnyCircuitElement } from "circuit-json"
import type { SpiceEndpoint, ValidationCase, ValidationExecutionError } from "../../spice-validation/types"
import { asRecord, simulatorError } from "./errors"
import { resolvePlannedEndpoint } from "./waveform-probes"

function validateApplicationLogicOverlay(input: {
  overlay: Extract<
    NonNullable<ValidationCase["application_fixture"]>["condition_overlays"][number],
    { type: "logic_state" }
  >
  overlay_index: number
  circuit_json: readonly AnyCircuitElement[]
}): ValidationExecutionError[] {
  const path = `application_fixture.condition_overlays[${input.overlay_index}]`
  const positive = resolvePlannedEndpoint({
    circuit_json: input.circuit_json,
    endpoint: input.overlay.endpoint,
    subject: `logic-state overlay ${input.overlay_index}`,
    path: `${path}.endpoint`,
  })
  const negative = resolvePlannedEndpoint({
    circuit_json: input.circuit_json,
    endpoint: input.overlay.reference,
    subject: `logic-state overlay ${input.overlay_index}`,
    path: `${path}.reference`,
  })
  const resolution_errors = [positive.error, negative.error].filter(
    (error): error is ValidationExecutionError => error !== undefined,
  )
  if (resolution_errors.length > 0) return resolution_errors
  const positive_endpoint = positive.endpoint
  const negative_endpoint = negative.endpoint
  if (!positive_endpoint || !negative_endpoint) {
    return [
      simulatorError(
        "viewer_logic_overlay_endpoint_unresolved",
        `Logic-state overlay ${input.overlay_index} has an unresolved topology endpoint`,
        path,
      ),
    ]
  }

  const expected_port_ids = [positive_endpoint, negative_endpoint].flatMap((endpoint) =>
    endpoint.kind === "source_port" ? [endpoint.id] : [],
  )
  const expected_net_sets = [positive_endpoint, negative_endpoint].flatMap((endpoint) =>
    endpoint.kind === "source_net"
      ? [new Set([endpoint.id])]
      : endpoint.kind === "ground"
        ? [endpoint.ids]
        : [],
  )
  const conditioned_port_id = positive_endpoint.kind === "source_port" ? positive_endpoint.id : undefined
  const touching_traces = input.circuit_json.flatMap((element) => {
    const trace = asRecord(element)
    if (trace.type !== "source_trace") return []
    const port_ids = Array.isArray(trace.connected_source_port_ids)
      ? trace.connected_source_port_ids.filter((id): id is string => typeof id === "string")
      : []
    const net_ids = Array.isArray(trace.connected_source_net_ids)
      ? trace.connected_source_net_ids.filter((id): id is string => typeof id === "string")
      : []
    return conditioned_port_id && port_ids.includes(conditioned_port_id) ? [{ port_ids, net_ids }] : []
  })
  const exact_traces = touching_traces.filter(({ port_ids, net_ids }) => {
    if (
      port_ids.length !== expected_port_ids.length ||
      new Set(port_ids).size !== expected_port_ids.length ||
      expected_port_ids.some((id) => !port_ids.includes(id)) ||
      net_ids.length !== expected_net_sets.length ||
      new Set(net_ids).size !== expected_net_sets.length
    ) {
      return false
    }
    return expected_net_sets.every((allowed) => net_ids.some((id) => allowed.has(id)))
  })
  if (touching_traces.length !== 1 || exact_traces.length !== 1) {
    return [
      simulatorError(
        "viewer_logic_overlay_short_mismatch",
        `Logic-state overlay ${input.overlay_index} must compile to exactly one direct topology trace from ${input.overlay.endpoint} to ${input.overlay.reference}; found ${touching_traces.length} touching traces and ${exact_traces.length} exact traces`,
        path,
      ),
    ]
  }
  return []
}

export function validateApplicationNodeGroups(input: {
  validation_case: ValidationCase
  circuit_json: readonly AnyCircuitElement[]
}): ValidationExecutionError[] {
  const application = input.validation_case.application_fixture
  if (!application) return []
  const errors: ValidationExecutionError[] = []
  for (const [overlay_index, overlay] of application.condition_overlays.entries()) {
    if (overlay.type !== "logic_state") continue
    errors.push(
      ...validateApplicationLogicOverlay({
        overlay,
        overlay_index,
        circuit_json: input.circuit_json,
      }),
    )
  }
  const expected_by_dut_port = new Map<string, { endpoint: SpiceEndpoint; net_ids: ReadonlySet<string> }>()

  for (const [group_index, group] of application.node_groups.entries()) {
    const target_endpoint: SpiceEndpoint = group.is_ground ? "gnd" : `net.${group.id}`
    const target = resolvePlannedEndpoint({
      circuit_json: input.circuit_json,
      endpoint: target_endpoint,
      subject: `application node group ${group.id}`,
      path: `application_fixture.node_groups[${group_index}]`,
    })
    if (target.error) {
      errors.push(target.error)
      continue
    }
    const expected_net_ids =
      target.endpoint.kind === "source_net"
        ? new Set([target.endpoint.id])
        : target.endpoint.kind === "ground"
          ? target.endpoint.ids
          : new Set<string>()
    if (expected_net_ids.size === 0) {
      errors.push(
        simulatorError(
          "viewer_application_node_unresolved",
          `Application node group ${group.id} has no unique Circuit JSON source net`,
          `application_fixture.node_groups[${group_index}]`,
        ),
      )
      continue
    }
    for (const [endpoint_index, endpoint] of group.dut_endpoints.entries()) {
      const resolved = resolvePlannedEndpoint({
        circuit_json: input.circuit_json,
        endpoint,
        subject: `application node group ${group.id}`,
        path: `application_fixture.node_groups[${group_index}].dut_endpoints[${endpoint_index}]`,
      })
      if (resolved.error) {
        errors.push(resolved.error)
        continue
      }
      if (resolved.endpoint.kind !== "source_port") {
        errors.push(
          simulatorError(
            "viewer_application_dut_endpoint_unresolved",
            `Application endpoint ${endpoint} did not resolve to one DUT source port`,
            `application_fixture.node_groups[${group_index}].dut_endpoints[${endpoint_index}]`,
          ),
        )
        continue
      }
      expected_by_dut_port.set(resolved.endpoint.id, { endpoint, net_ids: expected_net_ids })
    }
  }

  const dut_components = input.circuit_json.flatMap((element) => {
    const record = asRecord(element)
    return record.type === "source_component" && record.name === "DUT" ? [record] : []
  })
  const dut_component_id = dut_components[0]?.source_component_id
  const dut_port_ids = new Set(
    typeof dut_component_id !== "string"
      ? []
      : input.circuit_json.flatMap((element) => {
          const record = asRecord(element)
          return record.type === "source_port" &&
            record.source_component_id === dut_component_id &&
            typeof record.source_port_id === "string"
            ? [record.source_port_id]
            : []
        }),
  )
  const overlay_dut_port_ids = new Set(
    application.condition_overlays.flatMap((overlay, overlay_index) => {
      const resolved = resolvePlannedEndpoint({
        circuit_json: input.circuit_json,
        endpoint: overlay.endpoint,
        subject: `application condition overlay ${overlay_index}`,
        path: `application_fixture.condition_overlays[${overlay_index}].endpoint`,
      })
      if (resolved.error) {
        errors.push(resolved.error)
        return []
      }
      return resolved.endpoint.kind === "source_port" ? [resolved.endpoint.id] : []
    }),
  )
  const net_traces_by_dut_port = new Map<string, Array<{ port_ids: string[]; net_ids: string[] }>>()
  for (const element of input.circuit_json) {
    const trace = asRecord(element)
    if (trace.type !== "source_trace") continue
    const port_ids = Array.isArray(trace.connected_source_port_ids)
      ? trace.connected_source_port_ids.filter((id): id is string => typeof id === "string")
      : []
    const net_ids = Array.isArray(trace.connected_source_net_ids)
      ? trace.connected_source_net_ids.filter((id): id is string => typeof id === "string")
      : []
    if (net_ids.length === 0) continue
    for (const port_id of port_ids.filter((id) => dut_port_ids.has(id))) {
      const earlier = net_traces_by_dut_port.get(port_id) ?? []
      earlier.push({ port_ids, net_ids })
      net_traces_by_dut_port.set(port_id, earlier)
    }
  }
  for (const [port_id, expected] of expected_by_dut_port) {
    const traces = net_traces_by_dut_port.get(port_id) ?? []
    const exact = traces.filter(
      ({ port_ids, net_ids }) =>
        port_ids.length === 1 &&
        port_ids[0] === port_id &&
        net_ids.length === 1 &&
        expected.net_ids.has(net_ids[0]!),
    )
    if (traces.length !== 1 || exact.length !== 1) {
      errors.push(
        simulatorError(
          "viewer_application_node_group_mismatch",
          `Application endpoint ${expected.endpoint} must have exactly one direct trace to its server-owned node group; found ${traces.length} DUT-to-net traces and ${exact.length} exact matches`,
          `application_fixture.${expected.endpoint}`,
        ),
      )
    }
  }
  for (const [port_id, traces] of net_traces_by_dut_port) {
    if (expected_by_dut_port.has(port_id) || overlay_dut_port_ids.has(port_id)) continue
    if (traces.length > 0) {
      errors.push(
        simulatorError(
          "viewer_application_extra_node_group",
          "A detached or ungrouped DUT endpoint has an unexpected direct source-net trace",
          "application_fixture.node_groups",
        ),
      )
    }
  }
  return errors
}
