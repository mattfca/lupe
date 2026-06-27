import type { PhaseState } from "../state/schema";
import { UsageError } from "../util/errors";

export interface SelectReadyOptions {
  phases: readonly PhaseState[];
  maxParallelPhases: number;
  runningPhaseIds?: ReadonlySet<string>;
}

export interface RunPhaseSchedulerOptions<T> {
  phases: () => readonly PhaseState[];
  maxParallelPhases: number;
  runPhase: (phase: PhaseState) => Promise<T>;
}

export interface ScheduledPhaseResult<T> {
  phaseId: string;
  result: T;
}

export function selectReadyPhases(options: SelectReadyOptions): PhaseState[] {
  validateMaxParallel(options.maxParallelPhases);

  const running = options.runningPhaseIds ?? new Set<string>();
  const phases = options.phases;
  const verified = new Set(phases.filter((phase) => phase.status === "verified").map((phase) => phase.id));
  const alreadyRunning = new Set([
    ...phases.filter((phase) => phase.status === "running").map((phase) => phase.id),
    ...running
  ]).size;
  const slots = Math.max(0, options.maxParallelPhases - alreadyRunning);

  if (slots === 0) {
    return [];
  }

  return phases
    .filter((phase) => phase.status === "ready" && !running.has(phase.id))
    .filter((phase) => phase.deps.every((dep) => verified.has(dep)))
    .slice(0, slots)
    .map((phase) => ({
      ...phase,
      deps: [...phase.deps]
    }));
}

export async function runPhaseScheduler<T>(
  options: RunPhaseSchedulerOptions<T>
): Promise<ScheduledPhaseResult<T>[]> {
  validateMaxParallel(options.maxParallelPhases);

  const results: ScheduledPhaseResult<T>[] = [];
  const running = new Map<string, Promise<ScheduledPhaseResult<T>>>();

  while (true) {
    for (const phase of selectReadyPhases({
      phases: options.phases(),
      maxParallelPhases: options.maxParallelPhases,
      runningPhaseIds: new Set(running.keys())
    })) {
      running.set(
        phase.id,
        options.runPhase(phase).then((result) => ({
          phaseId: phase.id,
          result
        }))
      );
    }

    if (running.size === 0) {
      return results;
    }

    const completed = await Promise.race(running.values());
    running.delete(completed.phaseId);
    results.push(completed);
  }
}

function validateMaxParallel(maxParallelPhases: number): void {
  if (!Number.isInteger(maxParallelPhases) || maxParallelPhases < 1) {
    throw new UsageError("maxParallelPhases must be a positive integer.");
  }
}
