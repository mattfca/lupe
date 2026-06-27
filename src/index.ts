export { defineConfig } from "./config/defineConfig";
export {
  CONFIG_FILENAME,
  loadConfig,
  type LoadedConfig,
  type LoadConfigOptions
} from "./config/load";
export {
  DEFAULT_CONFIG,
  DEFAULT_INPUT_CONFIG,
  resolveConfig,
  resolveInputConfig,
  validateConfig,
  validateInputConfig,
  type InputConfig,
  type InputConfigInput,
  type LupeConfig,
  type UserLupeConfig
} from "./config/schema";
export {
  createMockAgentAdapter,
  type AgentAdapter,
  type MockPhaseHandler,
  type MockPlanHandler,
  type MockRepairHandler,
  type PhaseExecutionContext,
  type PhaseExecutionResult,
  type PhaseRepairContext,
  type PlanningContext,
  type PlanningPhaseDraft,
  type PlanningResult
} from "./agent";
export {
  CursorAgentAdapter,
  createCursorAgentAdapter,
  type CursorAgentAdapterOptions
} from "./agent/cursor";
export {
  DEFAULT_WORK_ITEM_PATTERN,
  GENERATED_ARTIFACT_SEGMENTS,
  INPUT_DIR,
  INTERNAL_DIR,
  assertNoGeneratedArtifactsUnderInput,
  assertNoWorkItemsUnderInternal,
  isUnderDirectory,
  normalizePath,
  validateDirectoryContract,
  type DirectoryContractOptions
} from "./fs/contract";
export {
  captureDiffSummary,
  createPhaseWorktree,
  deleteBranch,
  phaseBranchName,
  phaseWorktreePath,
  removeWorktree,
  runGit,
  type GitAdapterOptions,
  type GitCommandResult,
  type PhaseWorktree,
  type PhaseWorktreeOptions
} from "./git";
export {
  GhPullRequestProvider,
  createGhPullRequestProvider,
  type OpenPullRequestOptions,
  type PullRequestInfo,
  type PullRequestProvider
} from "./git/pr";
export {
  IntegrationConflictError,
  integrationBranchName,
  integrationWorktreePath,
  mergeVerifiedPhases,
  temporaryIntegrationBranchName,
  type IntegratedPhase,
  type IntegrationConflictDetails,
  type IntegrationMergeOptions,
  type IntegrationMergeResult,
  type PhaseMergeResult
} from "./integration/merge";
export {
  FINAL_REVIEW_DIR,
  FINAL_REVIEW_FILES,
  generateFinalReviewPackage,
  integrateAndReviewWorkItem,
  readReviewSummary,
  relativeReviewPath,
  renderSummaryMarkdown,
  resolveFinalReviewPaths,
  transitionReviewGenerated,
  type FinalReviewFile,
  type FinalReviewPackage,
  type FinalReviewPaths,
  type GenerateFinalReviewPackageOptions,
  type IntegrateAndReviewOptions,
  type IntegrateAndReviewResult
} from "./integration/review";
export {
  BATCH_WORK_ITEM_ID,
  generateBatchReviewPackage,
  recordBatchReviewDecision,
  resolveBatchReviewPaths,
  selectBatchReviewItems,
  type BatchReviewItem,
  type BatchReviewPackage,
  type GenerateBatchReviewPackageOptions
} from "./integration/batch";
export {
  acceptWorkItem,
  cleanupWorkItemWorktrees,
  recordAccepted,
  recordRejected,
  recordSkipped,
  rejectWorkItem,
  skipWorkItem,
  type AcceptWorkItemOptions,
  type AcceptWorkItemResult,
  type RejectWorkItemOptions,
  type RejectWorkItemResult,
  type SkipWorkItemOptions,
  type SkipWorkItemResult
} from "./lifecycle/accept";
export {
  advanceQueue,
  applyTerminalQueuePolicy,
  haltQueueOnRejected,
  type QueuePolicyOptions
} from "./lifecycle/advance";
export {
  acknowledgeAcceptedFileDrift,
  detectAcceptedFileDrift,
  warnAcceptedFileDrift,
  type AcceptedFileDrift,
  type DetectAcceptedFileDriftOptions
} from "./lifecycle/immutability";
export { loadQueue, type LoadedQueue, type LoadQueueConfig, type LoadQueueOptions } from "./queue/discover";
export {
  WORK_ITEM_FILENAME_PATTERN,
  isWorkItemFilename,
  parseWorkItemFilename,
  type ParsedWorkItemFilename
} from "./queue/filename";
export { hashContents } from "./queue/hash";
export {
  handleUnmatchedFile,
  validateDuplicatePrefixes,
  validateQueueDirectoryContract,
  type ParsedQueueFile,
  type QueueWarning,
  type QueueWarningCode,
  type QueueValidationOptions
} from "./queue/validate";
export { createWorkItem, type CreateWorkItemOptions, type WorkItem } from "./queue/workItem";
export {
  PhaseGraphError,
  buildPhaseGraph,
  phasesToState,
  type InitialPhaseStatus,
  type PhaseDraft,
  type PlannedPhase
} from "./planner/graph";
export {
  PLAN_FILENAME,
  PHASES_DIR,
  WORK_ITEMS_DIR,
  persistPlanArtifacts,
  resolveWorkItemPlanPaths,
  type PersistPlanOptions,
  type PersistPlanResult,
  type PersistedPlan,
  type PersistedPlanPaths,
  type PersistedPlanPhase
} from "./planner/persist";
export {
  planWorkItem,
  selectPlanTargets,
  syncQueueIntoState,
  type PlanWorkItemOptions,
  type PlanWorkItemResult,
  type SelectPlanTargetsOptions
} from "./planner/plan";
export {
  acquireLock,
  DEFAULT_STALE_LOCK_MS,
  inspectLock,
  isStaleLock,
  LOCK_FILENAME,
  LockConflictError,
  LockValidationError,
  releaseLock,
  resolveLockPath,
  withLock,
  type LockHandle,
  type LockInspectResult,
  type LockMetadata,
  type LockOptions
} from "./state/lock";
export {
  IllegalTransitionError,
  LEGAL_TRANSITIONS,
  queueEffectFor,
  syncDiscovered,
  transition,
  type QueueEffect,
  type SyncDiscoveredQueue,
  type TransitionEvent,
  type TransitionRule,
  type TransitionTrigger
} from "./state/machine";
export { renderStateMarkdown } from "./state/render";
export {
  isTerminalWorkItemStatus,
  StateValidationError,
  validateState,
  type CurrentState,
  type CurrentStatus,
  type DecisionState,
  type PhaseState,
  type PhaseStatus,
  type ProjectState,
  type PullRequestState,
  type State,
  type TerminalWorkItemStatus,
  type WorkItemState,
  type WorkItemStatus
} from "./state/schema";
export {
  createInitialState,
  loadState,
  resolveStateStorePaths,
  saveState,
  STATE_FILENAME,
  STATE_MARKDOWN_FILENAME,
  type StateStoreOptions,
  type StateStorePaths
} from "./state/store";
export {
  RUNS_DIR,
  RUN_ID_WIDTH,
  completeRunArtifacts,
  createRunArtifacts,
  listRunIds,
  resolveRunArtifactPaths,
  type CompleteRunArtifactsOptions,
  type CreateRunArtifactsOptions,
  type ResolveRunArtifactsOptions,
  type RunArtifactPaths
} from "./runner/artifacts";
export {
  runEngine,
  type PostPhaseHookContext,
  type RunEngineOptions,
  type RunEngineResult,
  runQueue,
  type RunQueueOptions,
  type RunQueueProcessedItem,
  type RunQueueResult,
  type RunQueueStoppedReason
} from "./runner/engine";
export {
  renderPhasePrompt,
  runPhase,
  type RunPhaseOptions,
  type RunPhaseResult
} from "./runner/phaseRun";
export {
  detectInProgressRun,
  normalizeResumablePhases,
  type ResumeRunInfo
} from "./runner/resume";
export {
  runPhaseScheduler,
  selectReadyPhases,
  type RunPhaseSchedulerOptions,
  type ScheduledPhaseResult,
  type SelectReadyOptions
} from "./runner/scheduler";
export {
  runVerifyCommands,
  type RunVerifyCommandsOptions,
  type VerifyCommandResult,
  type VerifyRunResult
} from "./verify/run";
export {
  renderVerificationReport,
  summarizeVerifyFailure,
  writeVerificationReport,
  type VerificationFinalStatus,
  type VerificationReportAttempt,
  type WriteVerificationReportOptions
} from "./verify/report";
export {
  renderRepairPrompt,
  verifyAndRepairPhase,
  type VerificationRepairStatus,
  type VerifyAndRepairPhaseOptions,
  type VerifyAndRepairPhaseResult
} from "./verify/repair";
export {
  LUPE_PROJECT_SKILLS,
  renderProjectSkill,
  writeProjectSkills,
  type ProjectSkill,
  type WriteProjectSkillsOptions,
  type WriteProjectSkillsResult
} from "./scaffold/skills";
export {
  createNewWorkItem,
  scaffoldInit,
  scaffoldMigrate,
  type CreateNewWorkItemOptions,
  type CreateNewWorkItemResult,
  type ScaffoldInitResult,
  type ScaffoldMigrateResult,
  type ScaffoldProjectOptions
} from "./scaffold/project";
export {
  INITIAL_SCOPE_SLUG,
  formatUtcTimestamp,
  renderConfigTemplate,
  renderInitialWorkItemTemplate,
  renderMigratedScopeWorkItem,
  renderNewWorkItemTemplate,
  renderQuickStartSnippet,
  slugifyTitle,
  workItemFilename
} from "./scaffold/templates";
export {
  CommandNotImplementedError,
  ConfigError,
  ContractError,
  ExitCode,
  LupeError,
  UsageError,
  exitCodeFor,
  formatError,
  isLupeError
} from "./util/errors";
export { createLogger, type LogLevel, type Logger, type LoggerOptions } from "./util/logger";
