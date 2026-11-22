# Review and Development Operations Guide

[中文原文](../operations.md) | [English README](../../README.en.md)

Once Team Board's switch is on and the DSH runtime dependencies are ready, the model can use the following five public tools. The new workflow requires subagents and a fresh-context provider; the legacy team task board, meetings, and historical imports additionally require the official Agent Teams components. The two feature switches are configured separately. Read [dependencies and enablement checks](dependencies.md) before installation. See [architecture](architecture.md) for the runtime structure and [compatibility notes](compatibility.md) for the host environment and verification scope.

| Tool | Purpose |
|---|---|
| `review_start` | Start a review or development run and immediately return its identifier |
| `review_status` | Query the stage, pending items, and next actions |
| `review_control` | pause, resume, stop, retry, cancel |
| `review_read` | Read runs, findings, decisions, tasks, checks, reports, and diagnostics with pagination |
| `review_revise` | Revise requirements and redo work by impact scope or in full |

The model tools do not include `decide`. Users answer pending questions through the page or `/review decide`; `review_submit` in a stage child session only submits the current execution's result.

## Starting and Reading Runs

Model call:

```json
{"requestId":"stable-request-id-for-the-requirements","requirement":"Requirements text","preset":"standard@2","mode":"review","materials":[{"name":"Interface contract","content":"Actual document text","source":"Original document location"}]}
```

The entry point is review_start. Repeated submissions with the same requestId and content return the same run. The response includes runId, projectRoot, steps, and nextActions. The default is standard@2; quick@2 omits the independent two-role review step. mode=review generates a report after decisions and implementation requirements have been formed, without running build or verify; mode=develop continues with implementation, machine checks, and independent verification. The develop mode of quick@2 still includes independent verify.

User commands (`/review start` is shorthand for starting review mode; use the page or the structured request described below to select a preset or develop mode):

```text
/review start <requirements-text>
/review status <runId>
/review read <runId> report
/review read <runId> findings
/review read <runId> decisions
/review read <runId> tasks
/review read <runId> checks
```

review_read supports section, id, and cursor. Lists return 20 items at a time; reports and file bodies return 16000 characters at a time. Continue reading with the returned nextCursor. For an artifact, use the resultRef or logRef from the result as its id.

## Controls and Choices

```text
/review pause <runId>
/review resume <runId>
/review stop <runId>
/review retry <runId>
/review cancel <runId>
/review decide <runId> <questionId> <optionId>
```

Question and option IDs use command slugs: they must begin with an English letter or digit and otherwise contain only English letters, digits, underscores, or hyphens, for example timeout-behavior and retry-once. Model stages validate this rule before saving, so commands in nextActions can be executed directly.

pause waits for the already-started stage to finish before pausing. stop immediately releases the current execution and saves interrupted; retry waits for the old task to release its resources before creating a new execution. cancel ends the run. Commands record user choices with user as their source; a fresh decide session then uses the answers to generate implementation requirements and check conditions.

If the same execution delivers two results through review_submit and the activation return value, the first valid completion result remains effective; later results with different content are archived only as stale. An input-version error without a valid completion result pauses the run for inspection.

If one reviewer fails, its error and valid findings are retained while the remaining work continues. If both reviewers fail, the run waits for the user to choose between retrying and proceeding to a degraded decision. A review timeout pauses first, preventing repeated automatic restarts.

The model uses review_revise to provide a new requirement, reason, and operationId. The new requirements generate a requirementRevision. Omitting impact triggers a full redo; specifying impact applies an impact list of decisions, tasks, checks, or paths:

```json
{"runId":"run-id","operationId":"revision-2","requirement":"Complete new requirements","reason":"Reason for the change","impact":{"decisionIds":[],"taskIds":["task-1-1"],"checkIds":["node-tests"],"paths":["src/clamp.mjs"],"review":"reuse"}}
```

When review is reuse, valid intake, reviews, and decisions are retained; only affected implementation, checks, and independent verification are redone. Tasks depending on an affected task are also redone. When review is rerun, reviews and decisions are regenerated. The program checks that references exist. Old outputs are retained, and reports identify the source version of reused content.

## Development and Machine Checks

Set review_start's mode to develop. start, revise, resume, and retry check development write ownership within the same project queue. If another unfinished develop run exists, they return PROJECT_WRITER_BUSY and preserve the original state. Once decisions produce implementation tasks with acceptance conditions and writeScopes, the run dispatches only one build writer. The implementer reads the actual code and submits changed and completedTaskIds. The runner executes machine checks while retaining their process handles; an independent verifier reads the code, actual changes, and machine results.

The build child session can read and write files and execute commands. Non-build child sessions such as review and verify are restricted to read-only access according to their roles. Tool restrictions apply to child-session scopes; the root session and ancestor presets remain unchanged. Role transport tools are retained, while a guard restricts tools owned by the session that are outside its role. A task's writeScopes stores the permitted implementation scope; machine checks run according to separate checks configuration.

Configure checks in the project's `.review/config.json`. review_start can also supply a checks array to override the project's check configuration; the remaining references and rework limit still come from project configuration.

```json
{
  "schemaVersion": 1,
  "checks": [{
    "id": "node-tests", "kind": "test", "phase": "implementation", "required": true,
    "argv": ["node", "--test", "--test-reporter", "tap", "test/clamp.test.mjs"],
    "cwd": ".", "timeoutMs": 180000, "parser": "node-test",
    "inputs": [], "outputs": ["generated/"], "taskIds": [], "onlyNewFailures": false
  }],
  "references": [{"kind":"planned","target":"src/clamp.mjs"},{"kind":"existing","target":"node:test"}],
  "maxReworks": 2
}
```

kind supports test and command; parser supports node-test and exit-code, with node-test used for test checks. phase is plan, implementation, or delivery. Node output must include tests/fail counts: zero tests means failed, while a missing summary, missing tool, or timeout means unknown. Ordinary commands are judged by their actual exit code. A required failure after implementation creates a finding and triggers targeted rework; unknown retains the reason and pauses the affected work. Previous machine findings are retained. Only a current failed result triggers new machine rework; a transition from failed to unknown does not consume an additional rework round. If the first plan precheck fails, implementation tasks have not yet been created, so the run pauses to wait; resume/retry reruns the precheck. Optional results remain in the report. When a check is removed, renamed, or made optional, its old machine finding is marked stale and retained as history. A check with the same ID that remains required is judged against its current configuration and result; continued failure remains blocking.

When inputs is empty, the digest covers project contents, including new and uncommitted files. Paths or globs can narrow the relevant inputs; project configuration, package manifests in each directory, and package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml, yarn.lock, bun.lock, and bun.lockb are still included. Binary contents are digested using the host's readBytes. All of `.review/runs/`, `.git/`, node_modules, and common caches are excluded by default. The project baseline excludes generated directories declared by all checks; each individual check excludes only its own outputs, so outputs from other steps can enter its inputs, for example validating generated/** after generating a schema. Symbolic links in project source produce a PROJECT_SYMLINK diagnostic; dependency directories are not scanned. Limits are 64 MiB per file read, 256 MiB total input, and 20000 files. Exceeding a limit explicitly stops that check's snapshot.

Each result saves configDigest, inputFingerprint, the code digest, actual exit code, log reference, and result reference. All required checks, including those in the plan phase, are rechecked before independent verification and delivery. Input changes make old results stale and trigger reruns; affected work waits if a current passing result is missing. Output exceeding the in-memory buffer uses a host spill reference and retains a truncation flag; the host's collection limit still applies. For Node checks, onlyNewFailures saves a pre-implementation baseline and compares new failures when stable failure names are available. workspace.checkBaselines stores collecting/ready/waiting, the configuration digest, requirements version, and result reference by check ID. If the workspace has been saved but the baseline is missing, it can still be collected before build. An unknown baseline, zero tests, or missing stable failure identifiers pauses the run; fix the issue and use resume to retry. If build has already run and no trustworthy original baseline exists for the same configuration, the run stays paused to avoid using modified code as the original baseline. Old runs with onlyNewFailures=false do not gain this additional requirement.

references supports local paths, optional symbol text lookup, Node built-in modules, workspace, and installed packages. planned interfaces may be left for implementation. Missing local references are recorded as failed. Newly added external packages are queried through the project's npm registry, with query results cached; network or parsing errors produce unknown. Registry queries use an AbortSignal owned by the run. stop/cancel/dispose cancels and waits for the current query, without dispatching the remaining package queries.

Findings from independent verification enter targeted tasks with their existing finding IDs. After rework, relevant checks are rerun and verification runs again. The default is two automatic rounds; reaching the limit waits for the user to continue or retain the current results. Both full requirements revisions and impact revisions reset the current rework count; old findings, executions, and operation history are retained. stop, cancellation, and unloading wait for processes and child tasks to release their resources. Before reload and retry, actual files are reread and differences saved.

## Technical Probe

```text
/review probe <runId>
```

This command uses the public subprocess service to execute fixed Node argv, outputs reviewProbe and the Node version, and saves a CheckResult and log reference. It confirms that the command adapter is connected; project checks use develop's CheckSpec configuration.

## Workspace Records and Recovery

Run state, stage-result envelopes, and project configuration all use `schemaVersion: 1`; see [schemas.mjs](../../src/review/schemas.mjs) for their definitions. A result envelope carries executionId, requirementRevision, decisionRevision, inputFingerprint, kind, and the role result. Recovery checks applicability against execution identity and input version.

Run files live under the projectRoot fixed at creation. After a session changes directories, continue querying with the runId from the original result. On restart, the original directory's run is read first, followed by committed child-session results matching executionId and input version. A directory record without a result is shown as interrupted. Inspect existing outputs, then use retry; the program drains the old execution first.

Corrupt run files are preserved individually with their diagnostics, while healthy runs continue loading. status shows a storageDiagnostics summary. Use `/review read <runId> diagnostics` or review_read's diagnostics section to inspect project read errors; id can filter a specific corrupt run. Querying again after fixing the original file rechecks it. During develop recovery, errors reading configuration JSON, project snapshots, or existing inputs pause only the affected run; the diagnostic saves DEVELOP_RECOVERY_INPUT_ERROR and the original error. status/read/control remain available for healthy runs in the same project. After a fix, resume rechecks actual files. Disk-write failures for diagnostic state or artifacts are still reported to the caller.

The default timeout is 20 minutes per stage, adjustable through reviewStageTimeoutMs in Host Config. Completion, waiting for the user, and errors are reported through the root Agent's followup. Failed notifications are saved as pending and retried when the original session returns. Notifications provide only status/read actions; read the latest state before executing controls.

## Enabling without Screen Interaction

The existing public HTTP route remains available:

```http
POST /api/team-board/state
Content-Type: application/json

{"enabled":true,"sessionId":"current-root-session-id"}
```

enabled is saved before the snapshot is generated. sessionId selects the session whose data is read; changing only the switch requires only enabled. Before verification, use the same route to read the original value, and restore it afterward. Requests should use the current GUI's normal authenticated transport. If the host returns an access error, follow its access requirements.

This route comes from the existing user switch, and review reuses the same setting. New runs do not require writing profile files.

## Run Page and Structured Interface

The team ledger tab retains the original task board and settings, adding a review and development run area above them. Users can start review/develop, select quick@2/standard@2, pause or resume, revise requirements, answer pending questions, and read role executions, findings, decisions, tasks, checks, reports, and logs with pagination. The page lists runs for the current session and also queries the original projects recorded in the log index after a directory change. Refresh rereads state; read failures show the specific error and preserve input.

Page operations use the same ReviewService. Authenticated owner requests are submitted to:

```http
POST /api/team-board/review
Content-Type: application/json

{"sessionId":"exact-current-root-session-id","request":{"action":"start","requestId":"stable-request-id","requirement":"Requirements text","preset":"quick@2","mode":"review"}}
```

The Host establishes identity using connection.admit and the exact live root Agent, then executes commands.execute(agent, `/review request ${JSON.stringify(request)}`, [], signal). The request body accepts only sessionId and request; projectRoot, kind, and rootSessionId do not serve as identity. The original `/review start/status/read/decide/...` syntax remains available.

| action | request fields (other than action) |
|---|---|
| start | requestId, requirement; optional preset, mode, materials, checks |
| list | optional cursor |
| status | runId |
| read | runId, section; optional cursor, id |
| pause / stop / resume / retry / cancel | runId, operationId; optional expectedRevision |
| revise | runId, operationId, requirement, reason; optional expectedRevision, impact |
| decide | runId, questionId, optionId, operationId; optional expectedRevision |
| history | optional historyId, cursor |
| import | historyId, requestId; optional requirement, preset, mode |

The route returns `{ok:true,value:{commandId,result:{kind,text}}}`, where text is the business-result JSON. Callers check both ok and result.kind. Business-level failures retain kind=error and the specific text; authentication or routing errors return `{ok:false,error:{code,message}}`. The host records both command/run and command/done; top-level runId/projectRoot results let the existing session-index locate the run. Repeated deliveries retain the original requestId or operationId. Already accepted duplicate operations are deduplicated before revision is checked. A new operation with an outdated expectedRevision shows REVISION_CONFLICT; refreshing state preserves the draft.

read section retains the original sections and adds checkSpecs (definitions), checkResults (results), and usage (traceable statistics). Lists contain 20 items per page; text bodies contain 16000 characters per page, with nextCursor indicating the next page's starting point. The page replaces content per page and provides backward pagination, so memory does not grow without bound during successive log reads. The details view-model is reviewViewModel(runDetail, section, page) in src/review/view-model.mjs, where runDetail comes from read/run and page comes from the selected section. The page source is client/review-panel.mjs; npm run build:client inlines it and the view-model into the distributed client.js, and validate-package checks the generated artifact and locale consistency.

Historical tasks are read-only by default; reading does not recover/kick. Explicit import creates a new run and saves the source session/task/revision/meeting/preset, content digest, import time, and operator. Old evidence is marked imported/unknown, new execution supplies current results, and the original task remains unchanged. User choices are still submitted through the page or commands; model tools do not include decide.

usage reads committed assistant/message.data.usage from child sessions, saves eventSeqs as provenance, and releases the observation immediately after use. Timing comes from execution.startedAt/endedAt and run.createdAt/updatedAt; rework comes from saved rework.count. Missing tokens, human handling time, and historical rework values use null/unknown. Reads support request cancellation; unloading cancels and waits for observations to release their resources. When reading usage, check completeness as well: missing values must not be treated as zero. Product defaults are standard@2, a 20-minute stage timeout, and two rework rounds. See [trial results](practice-results.md) for the public trial summary.

For build/verify, resolvedFindingIds includes only fixed verification finding IDs from the input pendingVerificationFindingIds. Initial review findings are accepted through decisions/tasks; use [] when the pending re-verification list is empty. Unknown IDs still return FINDING_NOT_FOUND.

## Host Probes and Version Switching

Run the following commands from this repository's root. `<DSH_HOME>` means the installed DSH directory containing `node_modules/@deepseek-ai/`; replace it with the actual path before execution, retaining the quotes if the path contains spaces.

```text
node tools/probe-host-contracts.mjs "<DSH_HOME>"
node tools/probe-review-page.mjs "<DSH_HOME>"
```

These two probes check public host service contracts, the authenticated Fetch route, CommandRuntime, the log index, duplicate operations, version conflicts, and resource release. Probe results are recorded separately from real-model trials and visual page checks; see [compatibility notes](compatibility.md) for the verification scope.

Before switching versions, pause runs, back up the project's `.review/` data, and wait for child tasks and check processes to release their resources. The current schemaVersion=1 supports recovery of old runs; historical import adds optional provenance fields. Recovery compatibility does not mean arbitrary downgrades are safe: keep a complete copy of the data and confirm that the target version can read the required fields before switching. Do not manually delete version, execution identity, or provenance information to bypass validation.
