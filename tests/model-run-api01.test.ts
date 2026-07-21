import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JobStore } from "@/server/job-store"
import { createModelRunApiHandler } from "@/server/model-run-api"
import { ModelRunStore } from "@/server/model-run-store"

test("model API starts and extends the same fixed run using time-only effort", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-api-"))
  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_1", job_dir, file_name: "sensor.pdf" })
  job_store.updateJob("job_1", { display_status: "agent_running", is_complete: false })
  const started_run_ids: string[] = []
  const handle = createModelRunApiHandler({
    job_store,
    model_run_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    model_base_effort_ms: 1_000,
    run_model: async ({ model_run_id }) => {
      started_run_ids.push(model_run_id)
    },
  })

  const create_response = await handle(
    new Request("http://localhost/api/model-run/create?job_id=job_1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ effort_multiplier: 2 }),
    }),
  )
  const created = (await create_response?.json()) as { model_run: { model_run_id: string } }
  const extend_response = await handle(
    new Request("http://localhost/api/model-run/extend?job_id=job_1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ additional_effort: 1 }),
    }),
  )
  const extended = (await extend_response?.json()) as {
    model_run: { model_run_id: string; effort_multiplier: number; allocated_time_ms: number }
  }

  expect(create_response?.status).toBe(202)
  expect(extend_response?.status).toBe(202)
  expect(extended.model_run.model_run_id).toBe(created.model_run.model_run_id)
  expect(extended.model_run.effort_multiplier).toBe(3)
  expect(extended.model_run.allocated_time_ms).toBe(3_000)
  expect(started_run_ids).toEqual([created.model_run.model_run_id])

  model_run_store.updateModelRun(created.model_run.model_run_id, {
    status: "failed",
    is_complete: true,
    has_errors: true,
    error_message: "fixture failure",
  })
  const retry_response = await handle(
    new Request("http://localhost/api/model-run/retry?job_id=job_1", { method: "POST" }),
  )
  const retried = (await retry_response?.json()) as {
    model_run: { model_run_id: string; status: string; effort_multiplier: number }
  }
  expect(retry_response?.status).toBe(202)
  expect(retried.model_run.model_run_id).toBe(created.model_run.model_run_id)
  expect(retried.model_run.status).toBe("queued")
  expect(retried.model_run.effort_multiplier).toBe(3)
  expect(started_run_ids).toEqual([created.model_run.model_run_id, created.model_run.model_run_id])

  await rm(job_dir, { recursive: true, force: true })
})

test("model API serves the saved datasheet image for each benchmark", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-reference-api-"))
  const model_dir = join(job_dir, "spice")
  const figure_dir = join(model_dir, "evidence", "figures")
  const crop_dir = join(model_dir, "evidence", "crops")
  const page_dir = join(model_dir, "evidence", "pages")
  await Promise.all([
    mkdir(figure_dir, { recursive: true }),
    mkdir(crop_dir, { recursive: true }),
    mkdir(page_dir, { recursive: true }),
  ])

  const explicit_image = new Uint8Array([137, 80, 78, 71, 1])
  const figure_image = new Uint8Array([137, 80, 78, 71, 2])
  const page_image = new Uint8Array([137, 80, 78, 71, 4])
  await Promise.all([
    Bun.write(join(figure_dir, "explicit.png"), explicit_image),
    Bun.write(join(crop_dir, "fig-10-3.png"), figure_image),
    Bun.write(join(crop_dir, "page-22-r1c1.png"), new Uint8Array([137, 80, 78, 71, 5])),
    Bun.write(join(crop_dir, "page-22-r1c2.png"), new Uint8Array([137, 80, 78, 71, 6])),
    Bun.write(join(page_dir, "datasheet-page-22.png"), page_image),
    Bun.write(join(job_dir, "outside.png"), new Uint8Array([137, 80, 78, 71, 3])),
    Bun.write(
      join(model_dir, "benchmarks.json"),
      JSON.stringify({
        version: 1,
        benchmarks: [
          {
            id: "explicit",
            source: {
              page: 24,
              figure: "Figure 10-15",
              image: "evidence/figures/explicit.png",
            },
          },
          { id: "figure-match", source: { page: 18, figure: "Figure 10-3" } },
          { id: "page-match", source: { page: 22 } },
          { id: "outside", source: { source_image: "../outside.png" } },
        ],
      }),
    ),
  ])

  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_reference", job_dir, file_name: "sensor.pdf" })
  model_run_store.createModelRun({
    model_run_id: "model_reference",
    job_id: "job_reference",
    model_dir,
    effort_multiplier: 1,
    base_effort_ms: 1_000,
  })
  const handle = createModelRunApiHandler({
    job_store,
    model_run_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
  })

  const explicit_response = await handle(
    new Request("http://localhost/api/model-run/reference-image?job_id=job_reference&benchmark_id=explicit"),
  )
  expect(explicit_response?.status).toBe(200)
  expect(explicit_response?.headers.get("Content-Type")).toBe("image/png")
  expect(explicit_response?.headers.get("Content-Disposition")).toBe(
    'inline; filename="explicit-datasheet-reference.png"',
  )
  expect(new Uint8Array(await explicit_response!.arrayBuffer())).toEqual(explicit_image)

  const figure_response = await handle(
    new Request(
      "http://localhost/api/model-run/reference-image?job_id=job_reference&benchmark_id=figure-match",
    ),
  )
  expect(figure_response?.status).toBe(200)
  expect(new Uint8Array(await figure_response!.arrayBuffer())).toEqual(figure_image)

  const page_response = await handle(
    new Request(
      "http://localhost/api/model-run/reference-image?job_id=job_reference&benchmark_id=page-match",
    ),
  )
  expect(page_response?.status).toBe(200)
  expect(new Uint8Array(await page_response!.arrayBuffer())).toEqual(page_image)

  const outside_response = await handle(
    new Request("http://localhost/api/model-run/reference-image?job_id=job_reference&benchmark_id=outside"),
  )
  expect(outside_response?.status).toBe(404)

  await rm(job_dir, { recursive: true, force: true })
})
