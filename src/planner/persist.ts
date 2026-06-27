import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { INTERNAL_DIR } from "../fs/contract";
import type { WorkItem } from "../queue/workItem";
import type { PlannedPhase } from "./graph";

export const WORK_ITEMS_DIR = "work-items";
export const PLAN_FILENAME = "plan.json";
export const PHASES_DIR = "phases";

export interface PersistPlanOptions {
  cwd?: string;
  internalDir?: string;
  generatedAt?: Date;
}

export interface PersistedPlanPhase {
  id: string;
  title: string;
  goal: string;
  scope: string[];
  deps: string[];
  acceptanceHints: string[];
  status: PlannedPhase["status"];
  briefPath: string;
}

export interface PersistedPlan {
  version: 1;
  generatedAt: string;
  workItem: {
    id: string;
    path: string;
    fileHash: string;
  };
  phases: PersistedPlanPhase[];
}

export interface PersistedPlanPaths {
  workItemDir: string;
  planPath: string;
  phasesDir: string;
  phasePaths: string[];
}

export interface PersistPlanResult {
  plan: PersistedPlan;
  paths: PersistedPlanPaths;
}

export function resolveWorkItemPlanPaths(
  workItemId: string,
  options: PersistPlanOptions = {}
): PersistedPlanPaths {
  const cwd = resolve(options.cwd ?? process.cwd());
  const internalDir = resolve(cwd, options.internalDir ?? INTERNAL_DIR);
  const workItemDir = join(internalDir, WORK_ITEMS_DIR, workItemId);
  const phasesDir = join(workItemDir, PHASES_DIR);

  return {
    workItemDir,
    planPath: join(workItemDir, PLAN_FILENAME),
    phasesDir,
    phasePaths: []
  };
}

export async function persistPlanArtifacts(
  workItem: WorkItem,
  phases: readonly PlannedPhase[],
  options: PersistPlanOptions = {}
): Promise<PersistPlanResult> {
  const paths = resolveWorkItemPlanPaths(workItem.id, options);
  const generatedAt = (options.generatedAt ?? new Date()).toISOString();

  await mkdir(paths.workItemDir, { recursive: true });
  await rm(paths.phasesDir, { recursive: true, force: true });
  await mkdir(paths.phasesDir, { recursive: true });

  const persistedPhases: PersistedPlanPhase[] = phases.map((phase, index) => {
    const filename = phaseFilename(index);
    return {
      id: phase.id,
      title: phase.title,
      goal: phase.goal,
      scope: [...phase.scope],
      deps: [...phase.deps],
      acceptanceHints: [...phase.acceptanceHints],
      status: phase.status,
      briefPath: `${PHASES_DIR}/${filename}`
    };
  });

  const phasePaths: string[] = [];
  for (const [index, phase] of persistedPhases.entries()) {
    const path = join(paths.phasesDir, phaseFilename(index));
    await writeFile(path, renderPhaseBrief(phase), "utf8");
    phasePaths.push(path);
  }

  const plan: PersistedPlan = {
    version: 1,
    generatedAt,
    workItem: {
      id: workItem.id,
      path: workItem.path,
      fileHash: workItem.fileHash
    },
    phases: persistedPhases
  };

  await writeFile(paths.planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  return {
    plan,
    paths: {
      ...paths,
      phasePaths
    }
  };
}

function phaseFilename(index: number): string {
  return `phase-${String(index + 1).padStart(3, "0")}.md`;
}

function renderPhaseBrief(phase: PersistedPlanPhase): string {
  return `${[
    `# ${phase.title}`,
    "",
    `- ID: ${phase.id}`,
    `- Status: ${phase.status}`,
    `- Dependencies: ${phase.deps.length === 0 ? "none" : phase.deps.join(", ")}`,
    "",
    "## Goal",
    "",
    phase.goal,
    "",
    "## Scope",
    "",
    ...renderListOrNone(phase.scope),
    "",
    "## Acceptance Hints",
    "",
    ...renderListOrNone(phase.acceptanceHints)
  ].join("\n")}\n`;
}

function renderListOrNone(items: readonly string[]): string[] {
  if (items.length === 0) {
    return ["- none"];
  }
  return items.map((item) => `- ${item}`);
}
