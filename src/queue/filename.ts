import { basename } from "node:path";

import { DEFAULT_WORK_ITEM_PATTERN } from "../fs/contract";

export const WORK_ITEM_FILENAME_PATTERN = /^[0-9]{8}T[0-9]{6}_.+\.md$/;

const WORK_ITEM_FILENAME_CAPTURE = /^([0-9]{8}T[0-9]{6})_(.+)\.md$/;

export interface ParsedWorkItemFilename {
  filename: string;
  id: string;
  timestamp: string;
  description: string;
}

export function isWorkItemFilename(
  filename: string,
  pattern = DEFAULT_WORK_ITEM_PATTERN
): boolean {
  return parseWorkItemFilename(filename, pattern) !== null;
}

export function parseWorkItemFilename(
  filename: string,
  pattern = DEFAULT_WORK_ITEM_PATTERN
): ParsedWorkItemFilename | null {
  const baseFilename = basename(filename);
  const configuredPattern = new RegExp(pattern);

  if (!configuredPattern.test(baseFilename) || !WORK_ITEM_FILENAME_PATTERN.test(baseFilename)) {
    return null;
  }

  const match = WORK_ITEM_FILENAME_CAPTURE.exec(baseFilename);
  const timestamp = match?.[1];
  const description = match?.[2];

  if (timestamp === undefined || description === undefined) {
    return null;
  }

  return {
    filename: baseFilename,
    id: `${timestamp}_${description}`,
    timestamp,
    description
  };
}
