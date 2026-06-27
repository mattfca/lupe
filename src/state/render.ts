import type { State, WorkItemState } from "./schema";

export function renderStateMarkdown(state: State): string {
  const lines: string[] = [
    "# Lupe State",
    "",
    "<!-- Generated from .lupe/state.json. Do not edit by hand. -->",
    "",
    "## Current",
    `- Status: ${state.current.status}`,
    `- Work item: ${state.current.workItem ?? "none"}`,
    `- Run: ${state.current.run ?? "none"}`,
    `- Integration branch: ${state.current.integrationBranch ?? "none"}`,
    "",
    "## Work Items"
  ];

  if (state.workItems.length === 0) {
    lines.push("- none");
  } else {
    for (const item of state.workItems) {
      lines.push(renderWorkItemLine(item));
    }
  }

  if (state.decisions.length > 0) {
    lines.push("", "## Decisions");
    for (const decision of state.decisions) {
      lines.push(`- ${decision.date}: ${decision.note}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function renderWorkItemLine(item: WorkItemState): string {
  const details = detailsFor(item);
  const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  return `- [${item.status}] ${item.id}${suffix}`;
}

function detailsFor(item: WorkItemState): string[] {
  const details: string[] = [];

  if (item.completedAt !== undefined) {
    details.push(`completed ${item.completedAt}`);
  }

  if (item.currentPhase !== undefined) {
    details.push(item.currentPhase);
  }

  if (item.finalReview !== undefined) {
    details.push(`review ${item.finalReview}`);
  }

  if (item.pr !== undefined) {
    details.push(`PR ${item.pr.url}`);
  }

  if (item.rejectionReason !== undefined) {
    details.push(`reason: ${item.rejectionReason}`);
  }

  return details;
}
