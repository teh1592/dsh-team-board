# 依赖与启用检查

**简体中文** | [English](en/dependencies.md)

Team Board 是 DSH 插件，需要在已有 DSH 运行环境中安装。本仓库发布插件自身的源码和安装包；DSH 官方服务、模型设置和可选 Agent Teams 组件由宿主管理。

## 按功能检查

| 使用的功能 | 需要的能力 | 缺少时的表现 |
|---|---|---|
| 新评审 `review` | `tools`、`fs`、`agents`、`workingDirectory`、`subagents` 和至少一个全新上下文 provider | 服务未就绪时评审入口等待挂载；没有合适 provider 时返回 `FRESH_PROVIDER_UNAVAILABLE` |
| 实施与机器检查 `develop` | 上述能力，加 `subprocess` 和项目检查配置 | 命令或检查条件缺失会保留诊断并暂停 |
| 崩溃后的子会话结果回收、token 来源 | `sessionQuery`、持久化会话与运行文件 | 已保存的项目结果仍可读取；缺少会话查询时恢复标记 interrupted，用量为 unknown |
| 运行页面 | DSH Web Client、`commands`、已认证 Host Fetch 连接，以及 manifest 声明的 Client 模块 | 普通 Node.js 执行插件目录不会启动这套页面 |
| 旧团队任务板、任务成员及会议工作流 | 官方 Agent Teams 的 `agentTeams` 服务及所需团队工具 | 只有 subagents 时团队板降级为委派名册，完整团队任务与会议能力缺失 |
| 从旧团队任务导入 | `agentTeams` 和可读取的旧任务 | 历史入口报告 `agentTeams unavailable`，新评审运行不受此条件限制 |

## Agent Teams 和 subagents 的区别

**新 `review/develop` 流程直接调用 subagents，不以 Agent Teams 为必需依赖。** 运行器用独立阶段会话执行评审、决定、实施和验证。可以只启用 subagents；需要完整旧任务板或旧任务导入时，再启用 Agent Teams。

全新上下文 provider 是必要条件。推荐 DSH 官方 `spawn`：

- `@deepseek-ai/dsh-subagent` 提供 provider 注册和执行服务。
- `@deepseek-ai/dsh-subagent-spawn-in-process` 注册 `spawn`，每个子任务使用全新对话。

只有 `fork` 时，即便界面显示“子智能体可用”，它会继承父对话，仍不满足此流程的独立上下文要求。其他 provider 需要声明 `inheritsParentContext: false`；支持 `prepareContinuable` 的 provider 会优先选用。

DSH 0.2.2-rc.1 的官方组合包为 `@deepseek-ai/dsh-experimental-agent-team-profile`，管理器中显示 Agent Teams／智能体团队。它包含以下组件：

- `@deepseek-ai/dsh-experimental-agent-team`：成员名册、共享任务板及消息服务。
- `@deepseek-ai/dsh-experimental-tool-agent-team`：模型侧团队工具。
- `@deepseek-ai/dsh-experimental-client-ui-agent-team`：官方团队界面，按需要启用。

Agent Teams 还需要持久化会话存储。常规 DSH 配置通常已提供；自建最小 profile 应逐项检查。

## 在 DSH 中准备环境

1. 通过 DSH 的插件管理页或 `plugin_manager` 查看当前 profile 的已安装组件与启用状态。
2. 新评审至少确认 subagents 与 `spawn` 已启用；开发任务还要确认 subprocess、文件读写与命令工具可用。
3. 若使用旧团队板、会议或历史导入，启用官方 Agent Teams（智能体团队）功能。组件缺失时使用 DSH 官方插件管理流程安装与宿主相匹配的版本。
4. 安装 Team Board 后，单独检查 Team Board 自己的开关。它与官方 Agent Teams 的开关是两项设置。
5. 先在范围小、已有测试的项目中启动任务；`develop` 方式需要项目的 `.review/config.json` 检查配置。

可以向 DSH 提出以下请求：

```text
请检查当前 profile 是否有 subagents、全新上下文的 spawn provider、fs、agents、workingDirectory、subprocess 和 sessionQuery。
如果我要使用 Team Board 的旧团队任务板和历史导入，也检查官方 Agent Teams 是否已安装启用。
请通过插件管理器处理缺少的官方组件，保持版本与当前 DSH 匹配，再安装 Team Board。
```

启用插件应由宿主确认实际状态。本插件的 `cordis.patch.yml` 只注册 Team Board 自身，不会自动修改其他官方组件的开关，也不复制官方组件源码。

## npm 依赖

`package.json` 声明 Ajv 8.20.0、Zod 4.4.3；插件管理器安装包或执行 `npm ci` 时会解析并安装它们。源码仓库和 Release 安装包都不打入 `node_modules`。锁文件固定依赖版本及完整性校验。

TypeScript 和 `@types/node` 仅用于源码开发及类型检查。DSH 的宿主服务通过公开运行接口取得，和 npm 的普通运行依赖分开管理。

## 最小依赖验证

仓库的 [依赖生命周期测试](../test/integration/review-dependency-lifecycle.test.mjs) 在没有 `agentTeams` 的上下文中挂载五个评审工具，并检查依赖撤回、恢复和资源释放。[AgentRunner 测试](../test/integration/review-adapters.test.mjs) 验证 fresh provider 选择，并确认继承父上下文的 provider 会被排除。

```bash
node --test test/integration/review-dependency-lifecycle.test.mjs test/integration/review-adapters.test.mjs
```

这些是接口适配测试；真实宿主状态仍需在 DSH 中查询。操作与恢复说明见[操作指南](operations.md)，已验证范围见[兼容性说明](compatibility.md)。
