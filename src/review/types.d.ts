export type RunStatus = 'queued' | 'running' | 'waiting_user' | 'paused' | 'completed' | 'cancelled' | 'error';
export type WorkStatus = 'pending' | 'running' | 'completed' | 'interrupted' | 'error' | 'cancelled';
export type ReviewDecision = 'accept' | 'needs_revision' | 'reject' | 'abstain';
export type CheckOutcome = 'passed' | 'failed' | 'unknown' | 'skipped';
export type Applicability = 'current' | 'stale';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Material { name: string; content: string; source?: string }
export interface StageExecution {
  executionId: string; stageId: string; role: string; attempt: number;
  inputRevision: number; requirementRevision: number; decisionRevision: number;
  inputFingerprint: string; workStatus: WorkStatus; applicability: Applicability;
  childSessionId?: string; acceptedMessageId?: string; resultRef?: string; rawResultRef?: string; processed?: boolean;
  result?: Record<string, any>; reviewDecision?: ReviewDecision; diagnostic?: string;
  startedAt: string; endedAt?: string; provider?: string; codeFingerprint?: string; reusedForRevision?: number;
}
export interface Finding {
  id: string; sourceExecutionId: string; sourceFindingId: string; severity: string;
  description: string; basis: string; status: string; relatedFindingIds: string[];
  origin?: string; checkId?: string; taskIds?: string[]; requirementRevision?: number; applicability?: Applicability; resolvedByExecutionId?: string;
}
export interface Decision {
  id: string; findingIds: string[]; choice: 'adopt' | 'defer' | 'alternative' | 'dismiss';
  reason: string; owner: string; revision: number; affectedTaskIds: string[];
  requirementRevision: number; sourceExecutionId?: string; checks: string[]; reusedForRevision?: number; applicability?: Applicability;
}
export interface ImplementationTask {
  id: string; decisionIds: string[]; objective: string; acceptance: string[];
  writeScopes: string[]; dependsOn: string[]; workStatus: WorkStatus;
  findingIds?: string[]; origin?: string; requirementRevision?: number; reusedForRevision?: number; applicability?: Applicability;
}
export interface CheckSpec {
  id: string; kind?: 'test' | 'command'; phase?: 'plan' | 'implementation' | 'delivery'; required?: boolean;
  argv: string[]; cwd?: string; timeoutMs?: number; parser?: 'exit-code' | 'node-test'; inputs?: string[]; outputs?: string[]; taskIds?: string[]; onlyNewFailures?: boolean;
}
export interface Run {
  schemaVersion: 1; runId: string; requestId: string; requestDigest: string;
  preset: string; mode: 'review' | 'develop'; rootSessionId: string; projectRoot: string;
  requirement: string; materials: Material[]; requirementRevision: number;
  decisionRevision: number; revision: number; status: RunStatus; phase: string;
  pauseRequested: boolean; resumeWhenRootAvailable?: boolean; activeExecutions: Record<string, string>;
  executions: StageExecution[]; artifacts: any[]; findings: Finding[]; decisions: Decision[];
  tasks: ImplementationTask[]; checks: any[]; checkResults: any[]; operations: any[];
  history: any[]; notifications: any[]; questions: any[]; createdAt: string; updatedAt: string;
  reportRef?: string; summary?: string; diagnostic?: string;
  configuredChecks?: CheckSpec[]; workspace?: Record<string, any>; checkConfig?: Record<string, any>; rework?: Record<string, any>; revisionImpact?: Record<string, any>; provenance?: Record<string, any>;
}
export interface Operation { operationId: string; request: unknown; expectedRevision?: number; apply(run: Run): unknown }
export interface CommitResult { run: Run; result: any; replayed: boolean }
export interface RunStore {
  projectIdentity?(): Promise<{ projectRoot: string; projectKey: string }>;
  load(runId: string): Promise<Run | undefined>;
  create(run: Run): Promise<Run>;
  commit(runId: string, expectedRevision: number | undefined, operation: Operation): Promise<CommitResult>;
  list(): Promise<Run[]>;
  listDiagnostics?(): Promise<Array<{ runId: string; code: string; message: string; recordRef: string; observedAt: string }>>;
  readDiagnostic?(runId: string): Promise<unknown>;
  writeArtifact(runId: string, ref: string, value: unknown): Promise<string>;
  readArtifact(runId: string, ref: string): Promise<string>;
}
export interface AgentHandle { childId: string; messageId?: string; provider?: string; result: Promise<any>; cancel(): Promise<void> }
export interface AgentRunner { start(spec: any): Promise<AgentHandle>; recover?(run: Run, execution: StageExecution): Promise<any>; stopRecovered?(run: Run, execution: StageExecution): Promise<void> }
export interface CommandRunner { run(spec: any, signal?: AbortSignal): Promise<any>; dispose(): Promise<void> }
export interface Notifier { enqueue(rootSessionId: string, notification: any): Promise<string | undefined> }
