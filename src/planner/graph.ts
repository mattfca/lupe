import type { PhaseState } from "../state/schema";
import { ExitCode, LupeError } from "../util/errors";

export type InitialPhaseStatus = "ready" | "blocked";

export interface PhaseDraft {
  id?: string;
  title?: string;
  goal?: string;
  scope?: string | string[];
  deps?: string[];
  acceptanceHints?: string[];
}

export interface PlannedPhase {
  id: string;
  title: string;
  goal: string;
  scope: string[];
  deps: string[];
  acceptanceHints: string[];
  status: InitialPhaseStatus;
}

export class PhaseGraphError extends LupeError {
  constructor(message: string) {
    super(message, {
      code: "LUPE_PHASE_GRAPH_INVALID",
      exitCode: ExitCode.Usage
    });
    this.name = "PhaseGraphError";
  }
}

export function buildPhaseGraph(drafts: readonly PhaseDraft[]): PlannedPhase[] {
  const phases = normalizePhases(drafts);
  validateDependencies(phases);
  validateAcyclic(phases);

  return phases.map((phase) => ({
    ...phase,
    status: phase.deps.length === 0 ? "ready" : "blocked"
  }));
}

export function phasesToState(phases: readonly PlannedPhase[]): PhaseState[] {
  return phases.map((phase) => ({
    id: phase.id,
    status: phase.status,
    deps: [...phase.deps]
  }));
}

function normalizePhases(drafts: readonly PhaseDraft[]): Omit<PlannedPhase, "status">[] {
  if (drafts.length === 0) {
    throw new PhaseGraphError("Planning must produce at least one phase.");
  }

  const seen = new Set<string>();
  return drafts.map((draft, index) => {
    const defaultId = `phase-${String(index + 1).padStart(3, "0")}`;
    const id = normalizeRequiredString(draft.id, defaultId, `phases[${index}].id`);

    if (seen.has(id)) {
      throw new PhaseGraphError(`Duplicate phase id "${id}".`);
    }
    seen.add(id);

    return {
      id,
      title: normalizeRequiredString(draft.title, titleFromId(id), `phases[${index}].title`),
      goal: normalizeRequiredString(draft.goal, "Complete this phase.", `phases[${index}].goal`),
      scope: normalizeStringList(draft.scope, `phases[${index}].scope`),
      deps: uniqueStrings(draft.deps ?? [], `phases[${index}].deps`),
      acceptanceHints: normalizeStringList(draft.acceptanceHints, `phases[${index}].acceptanceHints`)
    };
  });
}

function validateDependencies(phases: readonly Omit<PlannedPhase, "status">[]): void {
  const ids = new Set(phases.map((phase) => phase.id));

  for (const phase of phases) {
    for (const dep of phase.deps) {
      if (!ids.has(dep)) {
        throw new PhaseGraphError(`Phase "${phase.id}" depends on missing phase "${dep}".`);
      }
      if (dep === phase.id) {
        throw new PhaseGraphError(`Phase "${phase.id}" cannot depend on itself.`);
      }
    }
  }
}

function validateAcyclic(phases: readonly Omit<PlannedPhase, "status">[]): void {
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  for (const phase of phases) {
    visit(phase.id, byId, visiting, visited, []);
  }
}

function visit(
  id: string,
  byId: ReadonlyMap<string, Omit<PlannedPhase, "status">>,
  visiting: Set<string>,
  visited: Set<string>,
  stack: string[]
): void {
  if (visited.has(id)) {
    return;
  }

  if (visiting.has(id)) {
    const cycleStart = stack.indexOf(id);
    const cycle = [...stack.slice(cycleStart), id].join(" -> ");
    throw new PhaseGraphError(`Phase dependency cycle detected: ${cycle}.`);
  }

  visiting.add(id);
  const phase = byId.get(id);
  if (phase === undefined) {
    return;
  }

  for (const dep of phase.deps) {
    visit(dep, byId, visiting, visited, [...stack, id]);
  }

  visiting.delete(id);
  visited.add(id);
}

function normalizeRequiredString(value: unknown, fallback: string, field: string): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new PhaseGraphError(`Phase field ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeStringList(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }

  if (typeof value === "string") {
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  if (!Array.isArray(value)) {
    throw new PhaseGraphError(`Phase field ${field} must be a string or string array.`);
  }

  return uniqueStrings(value, field);
}

function uniqueStrings(values: readonly unknown[], field: string): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new PhaseGraphError(`Phase field ${field} must contain only non-empty strings.`);
    }

    const trimmed = value.trim();
    if (!seen.has(trimmed)) {
      normalized.push(trimmed);
      seen.add(trimmed);
    }
  }

  return normalized;
}

function titleFromId(id: string): string {
  return id
    .replaceAll("-", " ")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
