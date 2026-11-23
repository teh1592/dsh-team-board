# Compatibility and Validation Scope

[English README](../../README.en.md) | [Chinese original](../compatibility.md)

This document records the confirmed environment and validation results for DSH Team Board 0.5. The results come from the pre-release product validation summary; the full test suite, packaging, and installation were not rerun when this document was prepared. For model trials, see [Trial Results](practice-results.md). For usage instructions, see the [Operations Guide](operations.md).

For the current 0.5.1-rc.2 requirements, see [Dependencies and setup](dependencies.md). Reviews and development use subagents and a fresh-context provider. The sections below retain the historical validation record for 0.5.0.

## Validated Environment

| Item | Confirmed information |
|---|---|
| DSH | 0.2.2-rc.1, actual local host |
| Node.js | 24.22.3 |
| Product version | 0.5 |
| Product automated tests | 1591/1591 passed, 0 failed |
| Live host acceptance | Acceptance completed with 21 live commands |
| Client Slot | active |
| Visual inspection | No screen or browser inspection performed |

These results apply only to the validated environment. Support for Node 22, other Node 24 minor versions, other DSH versions, and other operating systems requires separate validation.

Runtime dependencies are Ajv 8.20.0 and Zod 4.4.3. Development dependencies are TypeScript 5.9.3 and @types/node 24.19.2. See [package.json](../../package.json) and [package-lock.json](../../package-lock.json) for dependency declarations and locked versions, and [Sources and Reuse Notes](reuse-notes.md) for source and license information.

## Product Validation Coverage

Existing product validation records cover the full suite of 1591 tests, type checking, distribution-file validation, and probes of public host services. The tests cover:

- Independent role inputs, normal completion, negative review feedback, user choices, failure of both reviewers, and timeouts.
- Duplicate requests, operationId deduplication, revision conflicts, and archiving of late or conflicting results.
- A single build writer, project write ownership, machine checks, independent verification, bounded rework, and partial revisions through impact.
- Input fingerprints for required checks, onlyNewFailures baselines, archiving of findings after checks are removed or made optional, and registry query cancellation.
- Pausing, stopping, cancellation, resource release, recovery isolation per run, fixed project directories, and notification retries.
- Authenticated page routes, command results and indexes, historical imports, paginated reads, and Client module registration.

The 1591 tests belong to the plugin's product suite. The 160 tests across the trial projects are a separate dataset and must not be combined with them to calculate a product pass rate.

## Public Host Interfaces and Tool Scope

The current adapters use the public subagents, fs, subprocess, agents, sessionQuery, commands, tools, workingDirectory, and sessionProjections services, along with the relevant Agent lifecycle events. Subtasks use ContentBlock[], options.signal, activation.result, and dispose. Observations are released after sessionQuery reads.

Role-specific tool policies read `definitions(agent)`, which includes tools from ancestor presets visible to that Agent. Calling definitions without an Agent returns only global definitions. restrict filters global and inherited tools, while a guard further restricts the role's own tools. build retains read, write, edit, and command capabilities. Non-build roles such as review and verify use read-only tools, while the `structured_output`, `review_submit`, and `run_code` transport entry points remain available. These restrictions apply within the child-session scope; they do not rewrite the root or preset as a whole.

Real-service probes cover atomic create/commit/load operations in FileRunStore, Node checks through subprocess, tool JSON schemas and return values, mounting when dependencies become ready, and resource release when those dependencies are withdrawn. Page-route probes use the actual HostConnectionService, CommandRuntime, and fs to check owner authentication, CommandResult, command/run/done indexes, duplicate operations, stale revisions, and resource release on unload.

Indexes read `command/done.data.text` and `tool/result.data.message.content`. For page requests, the host confirms the exact live root Agent and owner. The request's projectRoot, kind, and rootSessionId are not used as proof of identity. Users can answer pending-choice questions only through the page or commands; the five model tools do not expose decide.

Run the probe commands from the repository root, replacing `<DSH_HOME>` with the installation directory containing the host's node_modules:

```text
node tools/probe-host-contracts.mjs "<DSH_HOME>"
node tools/probe-review-page.mjs "<DSH_HOME>"
```

## Schema 1 and Recovery of Older Data

State and results use `schemaVersion: 1`. Legacy `@1` presets and historical meeting tools retain their original logic. `quick@2` and `standard@2` execute through ReviewService. Historical data is read-only by default. An explicit import creates a new run and records optional provenance, leaving the original task unchanged.

Recovery reads saved results first, then checks execution identity and the actual project files. Executions without valid results are marked interrupted; users can inspect them and retry. Read errors for corrupt runs or development inputs are isolated per run, with diagnostics and a retry entry point retained. Read-only queries do not automatically resume runs that users have paused.

Older runs with `onlyNewFailures=false` do not acquire an additional baseline requirement. When an existing successful verification result lacks a code digest, recovery tests already cover the path where reconcile fills it in and generates the report directly, without an additional model call. This path depends on the specific run state. Other recovery scenarios are still handled according to identity, inputs, and check conditions.

In 0.5, the build and verify schemas make `resolvedFindingIds` optional. Prompts explicitly require it to contain only verification findings pending re-verification, with `[]` used when the list is empty. Unknown IDs still raise FINDING_NOT_FOUND. The older trial's stall caused by an omitted field remains documented in [Trial Results](practice-results.md). The full set of model trials has not been rerun under the same conditions on 0.5.

Before upgrading or rolling back, pause runs and back up the `.review/` data. A shared schema version does not establish that an arbitrary downgrade is safe: the target version must be able to read the optional fields and provenance data actually in use.

## 0.5.0 UI validation record

For 0.5.0, loading of client.js and registration of `conversation.view/team-board/order40` were validated; the Client Slot was active. Version 0.5.1-rc.2 uses Overview, Discussion, Tasks, and Results tabs. The source uses theme tokens, and the Chinese and English locales are kept in sync.

This validation involved no screen or browser operations. The actual appearance, layout, overflow, and visual behavior of interactions in light and dark themes still require manual inspection. An active Client Slot and successful module registration confirm only the integration status.
