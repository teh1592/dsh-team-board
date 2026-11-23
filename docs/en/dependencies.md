# Dependencies and setup

[中文原文](../dependencies.md) | [English README](../../README.en.md)

Team Board uses DSH's model settings and runs reviews and development through subagents.

## Requirements

| Use | Required capabilities |
|---|---|
| Review and independent discussion | DSH filesystem, Agent, working-directory and subagent services, with a fresh-context provider such as `spawn` |
| Development and machine checks | The capabilities above, plus command execution and project check configuration |
| Page operations | The DSH Web interface and an authenticated command connection |

Recovering child-session results after interruption uses `sessionQuery`. Without it, saved results remain readable and unfinished stages need to run again. A provider that inherits the parent conversation, such as `fork`, does not replace a fresh-context provider.

## Setup

1. Enable subagents and `spawn` in DSH. Enable command execution for development tasks.
2. Install Team Board, open its conversation page, and turn on the Team Board switch.
3. Enter a requirement and start. For development, configure check commands in the project's `.review/config.json`; see the [operations guide](operations.md#development-and-machine-checks).

The plugin manager handles the installation package's npm dependencies. Source development requires Node.js 22 or newer and `npm ci --ignore-scripts`.
