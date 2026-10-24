import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";
import {
  formatIssues,
  TrialRecordSchema,
  ValidationRecordSchema,
  type TrialRecord,
  type ValidationRecord,
} from "./schema.ts";

/**
 * The ledger is append-only JSONL and it is committed to the repository. Reports
 * are derived views of it; a report can always be rebuilt, a record can never be
 * quietly edited. Lines are only ever added.
 */

export async function appendJsonLine(path: string, record: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

export async function readJsonLines<T>(path: string, schema: z.ZodType<T>, label: string): Promise<T[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];

  const lines = (await file.text())
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const records: T[] = [];
  for (const [index, line] of lines.entries()) {
    let parsed: T;
    try {
      const decoded = schema.safeParse(JSON.parse(line));
      if (!decoded.success) {
        throw new Error(formatIssues(decoded.error, `${label} line ${index + 1}`));
      }
      parsed = decoded.data;
    } catch (error) {
      // A crash mid-write can leave one truncated final line; anything else is corruption.
      if (index === lines.length - 1) break;
      throw error;
    }
    records.push(parsed);
  }
  return records;
}

export function appendTrial(path: string, record: TrialRecord): Promise<void> {
  return appendJsonLine(path, record);
}

export function readTrials(path: string): Promise<TrialRecord[]> {
  return readJsonLines(path, TrialRecordSchema, path);
}

export function appendValidation(path: string, record: ValidationRecord): Promise<void> {
  return appendJsonLine(path, record);
}

export function readValidations(path: string): Promise<ValidationRecord[]> {
  return readJsonLines(path, ValidationRecordSchema, path);
}

export function latestValidations(records: ValidationRecord[]): Map<string, ValidationRecord> {
  const latest = new Map<string, ValidationRecord>();
  for (const record of records) {
    latest.set(record.task_id, record);
  }
  return latest;
}
