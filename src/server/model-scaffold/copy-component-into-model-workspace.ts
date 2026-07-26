import { copyFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { ComponentNotReadyError } from "./component-not-ready-error"

export async function copyComponentIntoModelWorkspace(input: {
  job_dir: string
  model_dir: string
}): Promise<void> {
  const preserved_original = join(input.job_dir, "component.circuit.tsx")
  if (!(await Bun.file(preserved_original).exists())) {
    throw new ComponentNotReadyError(
      "The authoritative component-ready snapshot is missing; refusing to copy the unvalidated working component into the model workspace",
    )
  }
  await copyFile(preserved_original, join(input.model_dir, "component.circuit.tsx"))
  const application_plan = join(input.job_dir, "typical-application-plan.json")
  if (await Bun.file(application_plan).exists()) {
    await copyFile(application_plan, join(input.model_dir, "typical-application-plan.json"))
  }
  for (const relative_path of [
    "typical-application.circuit.tsx",
    join("dist", "typical-application", "circuit.json"),
  ]) {
    const source = join(input.job_dir, relative_path)
    if (!(await Bun.file(source).exists())) continue
    const destination = join(input.model_dir, relative_path)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }
}
