import { writeFile } from "node:fs/promises";

import type { RunArtifactPaths } from "../runner/artifacts";
import type { VerifyRunResult } from "./run";

export type VerificationFinalStatus = "passed" | "repaired" | "failed" | "rejected";

export interface VerificationReportAttempt {
  label: string;
  verification: VerifyRunResult;
  repairAttempt?: number;
  repairOutput?: string;
  repairSubagents?: string;
}

export interface WriteVerificationReportOptions {
  paths: RunArtifactPaths;
  workItemId: string;
  phaseId: string;
  finalStatus: VerificationFinalStatus;
  repairAttempts: number;
  maxRepairAttempts: number;
  attempts: readonly VerificationReportAttempt[];
  failureReason?: string;
}

export async function writeVerificationReport(options: WriteVerificationReportOptions): Promise<void> {
  await writeFile(options.paths.verificationPath, renderVerificationReport(options), "utf8");
}

export function renderVerificationReport(options: WriteVerificationReportOptions): string {
  const latest = options.attempts.at(-1)?.verification;
  const lines = [
    "# Verification",
    "",
    `- Work item: ${options.workItemId}`,
    `- Phase: ${options.phaseId}`,
    `- Run: ${options.paths.runId}`,
    `- Status: ${renderStatus(options.finalStatus)}`,
    `- Repair attempts: ${options.repairAttempts}/${options.maxRepairAttempts}`,
    ""
  ];

  if (latest?.passed === false || options.failureReason !== undefined) {
    lines.push("## Failure Summary", "");
    lines.push(options.failureReason ?? summarizeVerifyFailure(latest));
    lines.push("");
  }

  for (const attempt of options.attempts) {
    lines.push(`## ${attempt.label}`, "");
    if (attempt.repairAttempt !== undefined) {
      lines.push(`Repair attempt: ${attempt.repairAttempt}`, "");
    }
    if (attempt.repairOutput !== undefined) {
      lines.push("### Repair Output", "", fenced(trimOrPlaceholder(attempt.repairOutput)), "");
    }
    if (attempt.repairSubagents !== undefined) {
      lines.push("### Repair Subagents", "", trimOrPlaceholder(attempt.repairSubagents), "");
    }

    lines.push(
      `Result: ${attempt.verification.passed ? "passed" : "failed"}`,
      `Duration: ${attempt.verification.durationMs}ms`,
      ""
    );

    for (const command of attempt.verification.commands) {
      lines.push(
        `### Command: ${command.command}`,
        "",
        `Exit code: ${command.exitCode}`,
        `Duration: ${command.durationMs}ms`,
        "",
        "Stdout:",
        "",
        fenced(trimOrPlaceholder(command.stdout)),
        "",
        "Stderr:",
        "",
        fenced(trimOrPlaceholder(command.stderr)),
        ""
      );
    }

    if (attempt.verification.commands.length === 0) {
      lines.push("No verification commands were configured.", "");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function summarizeVerifyFailure(result: VerifyRunResult | undefined): string {
  if (result === undefined) {
    return "Verification did not produce a result.";
  }

  const failed = result.failedCommand;
  if (failed === undefined) {
    return "Verification did not report a failed command.";
  }

  return [
    `Command failed: ${failed.command}`,
    `Exit code: ${failed.exitCode}`,
    "",
    "Stderr:",
    "",
    fenced(tail(trimOrPlaceholder(failed.stderr))),
    "",
    "Stdout:",
    "",
    fenced(tail(trimOrPlaceholder(failed.stdout)))
  ].join("\n");
}

function renderStatus(status: VerificationFinalStatus): string {
  switch (status) {
    case "passed":
      return "passed";
    case "repaired":
      return "passed after repair";
    case "failed":
      return "failed, repair pending";
    case "rejected":
      return "failed, repair budget exhausted";
  }
}

function trimOrPlaceholder(value: string): string {
  const trimmed = value.trim();
  return trimmed === "" ? "(empty)" : trimmed;
}

function tail(value: string, maxLength = 4000): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `... truncated ...\n${value.slice(value.length - maxLength)}`;
}

function fenced(value: string): string {
  return `\`\`\`\n${value}\n\`\`\``;
}
