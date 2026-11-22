# Dependencies and Enablement Checks

[中文原文](../dependencies.md) | [English README](../../README.en.md)

Team Board is a DSH plugin and must be installed in an existing DSH runtime. This repository publishes the plugin's own source code and installation package; the host manages official DSH services, model settings, and optional Agent Teams components.

## Check Dependencies by Feature

| Feature | Required capabilities | Behavior when unavailable |
|---|---|---|
| New `review` workflow | `tools`, `fs`, `agents`, `workingDirectory`, `subagents`, and at least one fresh-context provider | The review entry points wait to mount until services are ready; if no suitable provider is available, they return `FRESH_PROVIDER_UNAVAILABLE` |
| Implementation and machine checks in `develop` | The capabilities above, plus `subprocess` and project check configuration | Missing commands or check conditions are recorded in diagnostics, and the run pauses |
| Recovery of child-session results after a crash, and token provenance | `sessionQuery`, persisted sessions, and run files | Saved project results remain readable; without session queries, recovery is marked interrupted and usage is unknown |
| Run page | DSH Web Client, `commands`, an authenticated Host Fetch connection, and the Client module declared in the manifest | Running the plugin directory with plain Node.js does not start this page |
| Legacy team task board, task members, and meeting workflows | The official Agent Teams `agentTeams` service and the required team tools | With only subagents, the team board falls back to a delegation roster; full team-task and meeting capabilities are unavailable |
| Importing legacy team tasks | `agentTeams` and readable legacy tasks | The history entry point reports `agentTeams unavailable`; new review runs are not subject to this requirement |

## Agent Teams versus subagents

**The new `review/develop` workflow calls subagents directly and does not require Agent Teams.** The runner uses separate stage sessions for review, decisions, implementation, and verification. You can enable only subagents; enable Agent Teams as well when you need the full legacy task board or legacy task import.

A fresh-context provider is required. The recommended provider is DSH's official `spawn`:

- `@deepseek-ai/dsh-subagent` provides provider registration and execution services.
- `@deepseek-ai/dsh-subagent-spawn-in-process` registers `spawn`, which uses a fresh conversation for each child task.

If only `fork` is available, it inherits the parent conversation and therefore does not meet this workflow's independent-context requirement, even if the interface reports that subagents are available. Other providers must declare `inheritsParentContext: false`; providers that support `prepareContinuable` are preferred.

In DSH 0.2.2-rc.1, the official bundle is `@deepseek-ai/dsh-experimental-agent-team-profile`, shown in the manager as Agent Teams / 智能体团队. It contains the following components:

- `@deepseek-ai/dsh-experimental-agent-team`: member roster, shared task board, and messaging services.
- `@deepseek-ai/dsh-experimental-tool-agent-team`: model-facing team tools.
- `@deepseek-ai/dsh-experimental-client-ui-agent-team`: the official team interface; enable it as needed.

Agent Teams also requires persistent session storage. Standard DSH configurations usually provide this; check each dependency when building a minimal custom profile.

## Preparing the DSH Environment

1. Use DSH's plugin management page or `plugin_manager` to inspect the components installed in the current profile and their enablement status.
2. For new reviews, at minimum confirm that subagents and `spawn` are enabled. For development tasks, also confirm that subprocess, file read/write capabilities, and command tools are available.
3. If you use the legacy team board, meetings, or historical imports, enable the official Agent Teams (智能体团队) feature. If components are missing, use DSH's official plugin management workflow to install versions that match the host.
4. After installing Team Board, check Team Board's own switch separately. It and the official Agent Teams switch are two separate settings.
5. Start with a small-scope project that already has tests. `develop` mode requires check configuration in the project's `.review/config.json`.

You can ask DSH:

```text
Please check whether the current profile has subagents, the fresh-context spawn provider, fs, agents, workingDirectory, subprocess, and sessionQuery.
If I want to use Team Board's legacy team task board and historical import, also check whether the official Agent Teams components are installed and enabled.
Please use the plugin manager to handle missing official components, keeping their versions compatible with the current DSH, and then install Team Board.
```

The host should confirm the actual enablement state. This plugin's `cordis.patch.yml` registers only Team Board itself; it does not automatically change other official components' switches or copy their source code.

## npm Dependencies

`package.json` declares Ajv 8.20.0 and Zod 4.4.3; the plugin manager resolves and installs them when installing the package, as does `npm ci`. Neither the source repository nor the Release installation package bundles `node_modules`. The lockfile pins dependency versions and integrity checks.

TypeScript and `@types/node` are used only for source development and type checking. DSH host services are obtained through public runtime interfaces and managed separately from ordinary npm runtime dependencies.

## Minimal Dependency Verification

The repository's [dependency lifecycle tests](../../test/integration/review-dependency-lifecycle.test.mjs) mount the five review tools in a context without `agentTeams`, and check dependency withdrawal, restoration, and resource release. The [AgentRunner tests](../../test/integration/review-adapters.test.mjs) verify fresh-provider selection and confirm that providers inheriting the parent context are excluded.

```bash
node --test test/integration/review-dependency-lifecycle.test.mjs test/integration/review-adapters.test.mjs
```

These are interface-adapter tests; actual host status must still be queried in DSH. See the [operations guide](operations.md) for operation and recovery instructions, and [compatibility notes](compatibility.md) for the verified scope.
