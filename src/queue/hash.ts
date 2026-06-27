import { createHash } from "node:crypto";

export function hashContents(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}
