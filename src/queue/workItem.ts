import { resolve } from "node:path";

import { hashContents } from "./hash";
import type { ParsedWorkItemFilename } from "./filename";

export interface WorkItem {
  id: string;
  timestamp: string;
  description: string;
  path: string;
  contents: string;
  fileHash: string;
}

export interface CreateWorkItemOptions {
  parsedFilename: ParsedWorkItemFilename;
  path: string;
  contents: string;
}

export function createWorkItem(options: CreateWorkItemOptions): WorkItem {
  return {
    id: options.parsedFilename.id,
    timestamp: options.parsedFilename.timestamp,
    description: options.parsedFilename.description,
    path: resolve(options.path),
    contents: options.contents,
    fileHash: hashContents(options.contents)
  };
}
