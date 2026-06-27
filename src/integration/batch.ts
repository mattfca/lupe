import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { INTERNAL_DIR } from "../fs/contract";
import type { State, WorkItemState } from "../state/schema";
import { FINAL_REVIEW_DIR, type FinalReviewPaths } from "./review";

export const BATCH_WORK_ITEM_ID = "batch";

export interface BatchReviewItem {
  id: string;
  status: WorkItemState["status"];
  finalReview?: string;
  integrationBranch?: string;
}

export interface BatchReviewPackage {
  paths: FinalReviewPaths;
  itemCount: number;
}

export interface GenerateBatchReviewPackageOptions {
  cwd?: string;
  internalDir?: string;
  generatedAt?: Date;
  items: readonly BatchReviewItem[];
}

export function selectBatchReviewItems(state: State): BatchReviewItem[] {
  return state.workItems
    .filter((item) => item.status === "verified" || item.status === "in_review")
    .map((item) => ({
      id: item.id,
      status: item.status,
      ...(item.finalReview === undefined ? {} : { finalReview: item.finalReview }),
      ...(state.current.workItem === item.id && state.current.integrationBranch !== undefined
        ? { integrationBranch: state.current.integrationBranch }
        : {})
    }));
}

export function resolveBatchReviewPaths(
  options: { cwd?: string; internalDir?: string } = {}
): FinalReviewPaths {
  const cwd = resolve(options.cwd ?? process.cwd());
  const relativeDir = join(options.internalDir ?? INTERNAL_DIR, "work-items", BATCH_WORK_ITEM_ID, FINAL_REVIEW_DIR);
  const dir = join(cwd, relativeDir);

  return {
    dir,
    relativeDir,
    summaryPath: join(dir, "summary.md"),
    phaseSummaryPath: join(dir, "phase-summary.md"),
    diffSummaryPath: join(dir, "diff-summary.md"),
    verificationPath: join(dir, "verification.md"),
    risksPath: join(dir, "risks.md"),
    unresolvedItemsPath: join(dir, "unresolved-items.md")
  };
}

export async function generateBatchReviewPackage(
  options: GenerateBatchReviewPackageOptions
): Promise<BatchReviewPackage> {
  const generatedAt = options.generatedAt ?? new Date();
  const paths = resolveBatchReviewPaths({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.internalDir === undefined ? {} : { internalDir: options.internalDir })
  });
  const items = [...options.items].sort((a, b) => a.id.localeCompare(b.id));

  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.summaryPath, renderBatchSummary(generatedAt, items), "utf8");
  await writeFile(paths.phaseSummaryPath, renderBatchPhaseSummary(items), "utf8");
  await writeFile(paths.diffSummaryPath, renderBatchDiffSummary(items), "utf8");
  await writeFile(paths.verificationPath, renderBatchVerification(items), "utf8");
  await writeFile(paths.risksPath, renderBatchRisks(items), "utf8");
  await writeFile(paths.unresolvedItemsPath, renderBatchUnresolvedItems(items), "utf8");

  return {
    paths,
    itemCount: items.length
  };
}

export function recordBatchReviewDecision(options: {
  state: State;
  reviewPath: string;
  generatedAt?: Date;
  itemCount: number;
}): State {
  const generatedAt = options.generatedAt ?? new Date();
  return {
    ...options.state,
    decisions: [
      ...options.state.decisions,
      {
        date: generatedAt.toISOString(),
        note: `Generated batch review for ${options.itemCount} item(s): ${options.reviewPath}`
      }
    ]
  };
}

function renderBatchSummary(generatedAt: Date, items: readonly BatchReviewItem[]): string {
  return `${[
    "# Batch Final Review",
    "",
    `- Generated: ${generatedAt.toISOString()}`,
    `- Items: ${items.length}`,
    "- Mode: batch",
    "",
    "## Items",
    "",
    ...renderItemLines(items),
    "",
    "Batch review is advanced/non-default behavior. Inspect each per-item review package before accepting."
  ].join("\n")}\n`;
}

function renderBatchPhaseSummary(items: readonly BatchReviewItem[]): string {
  return `${[
    "# Batch Phase Summary",
    "",
    ...items.map((item) => `- ${item.id}: ${item.status}`)
  ].join("\n")}\n`;
}

function renderBatchDiffSummary(items: readonly BatchReviewItem[]): string {
  return `${[
    "# Batch Diff Summary",
    "",
    "Batch diff aggregation points to each per-item final review package.",
    "",
    ...items.map((item) => `- ${item.id}: ${item.finalReview ?? "missing per-item review"}`)
  ].join("\n")}\n`;
}

function renderBatchVerification(items: readonly BatchReviewItem[]): string {
  return `${[
    "# Batch Verification",
    "",
    "Batch verification aggregates per-item review readiness.",
    "",
    ...items.map((item) => `- ${item.id}: ${item.finalReview === undefined ? "missing review package" : "review package present"}`)
  ].join("\n")}\n`;
}

function renderBatchRisks(items: readonly BatchReviewItem[]): string {
  const missing = items.filter((item) => item.finalReview === undefined);
  const lines = ["# Batch Risks", ""];
  if (missing.length === 0) {
    lines.push("- Every batched item has a per-item review package.");
  } else {
    lines.push(`- ${missing.length} item(s) are missing per-item review packages.`);
  }
  lines.push("- Batch mode does not change PR or accept lifecycle behavior.");
  return `${lines.join("\n")}\n`;
}

function renderBatchUnresolvedItems(items: readonly BatchReviewItem[]): string {
  const missing = items.filter((item) => item.finalReview === undefined);
  if (missing.length === 0) {
    return "# Batch Unresolved Items\n\nNo unresolved batch items recorded.\n";
  }

  return `${[
    "# Batch Unresolved Items",
    "",
    ...missing.map((item) => `- ${item.id}: missing per-item review package`)
  ].join("\n")}\n`;
}

function renderItemLines(items: readonly BatchReviewItem[]): string[] {
  if (items.length === 0) {
    return ["- none"];
  }

  return items.map((item) => {
    const details = [
      `status ${item.status}`,
      item.finalReview === undefined ? "review missing" : `review ${item.finalReview}`
    ];
    if (item.integrationBranch !== undefined) {
      details.push(`branch ${item.integrationBranch}`);
    }
    return `- ${item.id} (${details.join(", ")})`;
  });
}
