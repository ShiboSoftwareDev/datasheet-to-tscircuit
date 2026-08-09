import { expect, test } from "bun:test"
import {
  MAX_CONCURRENT_REFERENCE_GRAPH_DIGITIZATIONS,
  runReferenceGraphWorkerPool,
} from "@/server/model-workflow/characterization/reference-graph-worker-pool"

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolve_promise, reject_promise) => {
    resolve = resolve_promise
    reject = reject_promise
  })
  return { promise, resolve, reject }
}

test("reference graph workers run concurrently without exceeding the configured limit", async () => {
  const graphs = ["graph-1", "graph-2", "graph-3", "graph-4", "graph-5"]
  const release = deferred()
  const reached_limit = deferred()
  let active = 0
  let maximum_active = 0

  const run = runReferenceGraphWorkerPool({
    graphs,
    signal: new AbortController().signal,
    async digitize(graph) {
      active += 1
      maximum_active = Math.max(maximum_active, active)
      if (active === MAX_CONCURRENT_REFERENCE_GRAPH_DIGITIZATIONS) reached_limit.resolve()
      await release.promise
      active -= 1
      return graph
    },
  })

  await reached_limit.promise
  expect(maximum_active).toBeGreaterThan(1)
  expect(maximum_active).toBeLessThanOrEqual(MAX_CONCURRENT_REFERENCE_GRAPH_DIGITIZATIONS)
  release.resolve()
  expect(await run).toEqual(graphs)
  expect(maximum_active).toBe(MAX_CONCURRENT_REFERENCE_GRAPH_DIGITIZATIONS)
})

test("reference graph results retain discovery order when workers finish out of order", async () => {
  const graphs = ["graph-1", "graph-2", "graph-3", "graph-4"]
  const releases = Object.fromEntries(graphs.map((graph) => [graph, deferred()]))
  const starts = Object.fromEntries(graphs.map((graph) => [graph, deferred()]))
  const completion_order: string[] = []

  const run = runReferenceGraphWorkerPool({
    graphs,
    signal: new AbortController().signal,
    async digitize(graph) {
      starts[graph]!.resolve()
      await releases[graph]!.promise
      completion_order.push(graph)
      return { graph, proof: `${graph}-proof`, attempts: 1 }
    },
  })

  await Promise.all([starts["graph-1"]!.promise, starts["graph-2"]!.promise])
  releases["graph-2"]!.resolve()
  await starts["graph-3"]!.promise
  releases["graph-3"]!.resolve()
  await starts["graph-4"]!.promise
  releases["graph-1"]!.resolve()
  releases["graph-4"]!.resolve()

  const results = await run
  expect(completion_order).toEqual(["graph-2", "graph-3", "graph-1", "graph-4"])
  expect(results.map(({ graph }) => graph)).toEqual(graphs)
  expect(results.map(({ proof }) => proof)).toEqual(graphs.map((graph) => `${graph}-proof`))
})

test("a graph failure aborts active siblings and cannot publish partial canonical results", async () => {
  const graphs = ["graph-1", "graph-2", "graph-3", "graph-4"]
  const first_graph_started = deferred()
  const failure = Object.assign(new Error("graph-2 exhausted its artifact retries"), {
    debug_dir: "reference-observer/graph-2/rejected-attempts/8",
  })
  const started: string[] = []
  const disposed: string[] = []
  let sibling_abort: unknown
  let canonical_published = false

  const run = (async () => {
    const results = await runReferenceGraphWorkerPool({
      graphs,
      signal: new AbortController().signal,
      async digitize(graph, _graph_index, signal) {
        started.push(graph)
        if (graph === "graph-1") {
          first_graph_started.resolve()
          try {
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true })
            })
          } catch (error) {
            sibling_abort = error
            throw error
          } finally {
            disposed.push(graph)
          }
        }
        await first_graph_started.promise
        throw failure
      },
    })
    canonical_published = true
    return results
  })()

  const caught = await run.catch((error) => error)

  expect(caught).toBe(failure)
  expect(sibling_abort).toBe(failure)
  expect(caught.debug_dir).toBe("reference-observer/graph-2/rejected-attempts/8")
  expect(started).toEqual(["graph-1", "graph-2"])
  expect(disposed).toEqual(["graph-1"])
  expect(canonical_published).toBe(false)
})

test("cancellation reaches active graph work and prevents queued graphs from starting", async () => {
  const controller = new AbortController()
  const cancellation = new Error("operator cancelled reference digitization")
  const active_started = deferred()
  const started: string[] = []
  const disposed: string[] = []
  const received_signals: AbortSignal[] = []

  const run = runReferenceGraphWorkerPool({
    graphs: ["graph-1", "graph-2", "graph-3", "graph-4"],
    signal: controller.signal,
    async digitize(graph, _graph_index, signal) {
      started.push(graph)
      received_signals.push(signal)
      if (started.length === MAX_CONCURRENT_REFERENCE_GRAPH_DIGITIZATIONS) active_started.resolve()
      try {
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason)
            return
          }
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          })
        })
        return graph
      } finally {
        disposed.push(graph)
      }
    },
  })

  await active_started.promise
  controller.abort(cancellation)
  const caught = await run.catch((error) => error)

  expect(caught).toBe(cancellation)
  expect(started).toEqual(["graph-1", "graph-2"])
  expect(disposed.sort()).toEqual(["graph-1", "graph-2"])
  expect(new Set(received_signals).size).toBe(1)
  expect(received_signals[0]).not.toBe(controller.signal)
  expect(received_signals.every((signal) => signal.aborted && signal.reason === cancellation)).toBe(true)
})
