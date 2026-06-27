import { validateDirectoryContract } from "../fs/contract";
import type { InputConfig } from "../config/schema";
import { UsageError } from "../util/errors";
import type { ParsedWorkItemFilename } from "./filename";

export type QueueWarningCode = "unmatched-file";

export interface QueueWarning {
  code: QueueWarningCode;
  message: string;
  path: string;
}

export interface ParsedQueueFile {
  path: string;
  relativePath: string;
  parsedFilename: ParsedWorkItemFilename;
}

export interface QueueValidationOptions {
  input: InputConfig;
}

export function validateQueueDirectoryContract(
  paths: Iterable<string>,
  options: QueueValidationOptions
): void {
  validateDirectoryContract(paths, {
    inputDir: options.input.dir,
    workItemPattern: options.input.pattern
  });
}

export function handleUnmatchedFile(path: string, options: QueueValidationOptions): QueueWarning | null {
  const message = `Unmatched file "${path}" does not match work item pattern ${options.input.pattern}.`;

  if (options.input.onUnmatchedFile === "error") {
    throw new UsageError(message);
  }

  return {
    code: "unmatched-file",
    message,
    path
  };
}

export function validateDuplicatePrefixes(
  files: Iterable<ParsedQueueFile>,
  options: QueueValidationOptions
): void {
  const byTimestamp = new Map<string, ParsedQueueFile[]>();

  for (const file of files) {
    const matches = byTimestamp.get(file.parsedFilename.timestamp);
    if (matches === undefined) {
      byTimestamp.set(file.parsedFilename.timestamp, [file]);
      continue;
    }
    matches.push(file);
  }

  for (const [timestamp, matches] of byTimestamp) {
    if (matches.length < 2) {
      continue;
    }

    if (options.input.onDuplicatePrefix === "error") {
      throw new UsageError(
        `Duplicate work item timestamp prefix "${timestamp}" found in: ${matches
          .map((file) => file.relativePath)
          .join(", ")}.`
      );
    }
  }
}
