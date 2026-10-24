import { join, relative, resolve, sep } from "node:path";
import { REPO_ROOT, statOrNull } from "./exec.ts";
import { formatIssues, TaskSpecSchema, type TaskSpec } from "./schema.ts";

export type LoadedTask = {
  spec: TaskSpec;
  /** Absolute path to the task YAML. */
  file: string;
  /** Absolute path to the directory containing it. */
  dir: string;
};

/**
 * Task files are `<dir>/<id>.yaml` or `<dir>/<id>/task.yaml`. Relative paths inside
 * a task are always resolved from the repository root, never from the task file,
 * so moving a task between directories cannot change what it measures.
 */
export async function taskFiles(dir: string): Promise<string[]> {
  const found = new Set<string>();
  for (const pattern of ["**/task.yaml", "**/task.yml", "*.yaml", "*.yml"]) {
    const glob = new Bun.Glob(pattern);
    for await (const match of glob.scan({ cwd: dir, dot: false })) {
      found.add(join(dir, match));
    }
  }
  return [...found].sort();
}

export async function loadTaskDir(dir: string): Promise<LoadedTask[]> {
  const files = await taskFiles(dir);
  const tasks: LoadedTask[] = [];
  const seen = new Map<string, string>();

  for (const file of files) {
    const task = await loadTaskFile(file);
    const previous = seen.get(task.spec.id);
    if (previous) {
      throw new Error(`duplicate task id "${task.spec.id}" in ${previous} and ${file}`);
    }
    seen.set(task.spec.id, file);
    tasks.push(task);
  }

  return tasks.sort((a, b) => a.spec.id.localeCompare(b.spec.id));
}

export async function loadTaskFile(file: string): Promise<LoadedTask> {
  const handle = Bun.file(file);
  if (!(await handle.exists())) {
    throw new Error(`task file not found: ${file}`);
  }

  const raw = Bun.YAML.parse(await handle.text());
  const parsed = TaskSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(formatIssues(parsed.error, file));
  }

  const spec = parsed.data;
  const dir = resolve(file, "..");
  await checkReferences(spec, file);
  return { spec, file, dir };
}

async function checkReferences(spec: TaskSpec, file: string): Promise<void> {
  if (spec.source.kind === "path") {
    const target = resolveInsideRoot(spec.source.path, "source.path", file);
    const stat = await statOrNull(target);
    if (!stat?.isDirectory()) {
      throw new Error(`${file}: source.path is not a directory: ${spec.source.path}`);
    }
  }

  if (spec.reference_patch) {
    const target = resolveInsideRoot(spec.reference_patch, "reference_patch", file);
    const stat = await statOrNull(target);
    if (!stat?.isFile()) {
      throw new Error(`${file}: reference_patch is not a file: ${spec.reference_patch}`);
    }
  }
}

export function resolveInsideRoot(path: string, field: string, subject: string): string {
  if (path.startsWith("/") || path.startsWith("~")) {
    throw new Error(`${subject}: ${field} must be relative to the repository root, got "${path}"`);
  }
  const absolute = resolve(REPO_ROOT, path);
  const rel = relative(REPO_ROOT, absolute);
  if (rel.startsWith("..") || rel === "" || rel.split(sep).includes("..")) {
    throw new Error(`${subject}: ${field} escapes the repository root: "${path}"`);
  }
  return absolute;
}

/** Where a task's source material is copied from, for `source.kind: path`. */
export function localSourcePath(spec: TaskSpec): string {
  if (spec.source.kind !== "path") {
    throw new Error(`task ${spec.id} is not a path source`);
  }
  return resolveInsideRoot(spec.source.path, "source.path", spec.id);
}
