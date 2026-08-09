/**
 * Reference digitization launches an agent plus PDF/image verification processes,
 * so keep this deliberately lower than the preview-build concurrency limit.
 */
export const MAX_CONCURRENT_REFERENCE_GRAPH_DIGITIZATIONS = 2

type WorkerSlot<Result> =
  | { readonly status: "completed"; readonly value: Result }
  | { readonly status: "failed"; readonly error: unknown }

/** Run isolated graph work concurrently while retaining input-order results. */
export async function runReferenceGraphWorkerPool<Graph, Result>(input: {
  graphs: readonly Graph[]
  signal: AbortSignal
  concurrency?: number
  digitize: (graph: Graph, graph_index: number, signal: AbortSignal) => Promise<Result>
}): Promise<Result[]> {
  if (input.graphs.length === 0) return []

  const concurrency = Math.max(
    1,
    Math.min(
      input.graphs.length,
      Math.floor(input.concurrency ?? MAX_CONCURRENT_REFERENCE_GRAPH_DIGITIZATIONS),
    ),
  )
  const slots: Array<WorkerSlot<Result> | undefined> = new Array(input.graphs.length)
  let next_index = 0
  let stopped = false

  const workers = Array.from({ length: concurrency }, async () => {
    while (!stopped) {
      input.signal.throwIfAborted()
      const graph_index = next_index
      if (graph_index >= input.graphs.length) return
      const graph = input.graphs[graph_index]!
      next_index += 1

      try {
        slots[graph_index] = {
          status: "completed",
          value: await input.digitize(graph, graph_index, input.signal),
        }
      } catch (error) {
        slots[graph_index] = { status: "failed", error }
        stopped = true
      }
    }
  })

  // Cancellation can make an idle worker throw while another worker is still
  // disposing its graph workspace. Do not return until every active worker settles.
  await Promise.allSettled(workers)
  input.signal.throwIfAborted()

  // Select by original graph index so simultaneous failures are deterministic.
  const failure = slots.find((slot) => slot?.status === "failed")
  if (failure?.status === "failed") throw failure.error

  return slots.map((slot, graph_index) => {
    if (slot?.status === "completed") return slot.value
    throw new Error(`Reference graph worker ${graph_index} did not produce a result`)
  })
}
