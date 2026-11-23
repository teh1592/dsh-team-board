# 兼容性与验证范围

**简体中文** | [English](en/compatibility.md)

本文记录 DSH Team Board 0.5 的已确认环境与验证结果。结果来自发布前的产品验证汇总；本文整理时未重新执行全量测试、打包或安装。模型试用另见[试用结果](practice-results.md)，操作方法见[操作指南](operations.md)。

当前 0.5.1-rc.2 的安装要求见[依赖与启用](dependencies.md)：评审与开发使用 subagents 和全新上下文 provider。下文保留 0.5.0 的历史验证记录。

## 已验证环境

| 项目 | 已确认信息 |
|---|---|
| DSH | 0.2.2-rc.1，真实本机宿主 |
| Node.js | 24.22.3 |
| 产品版本 | 0.5 |
| 产品自动化测试 | 1591/1591 通过，0 失败 |
| 实时宿主验收 | 21 条实时命令完成验收 |
| Client Slot | active |
| 视觉检查 | 未执行屏幕或浏览器检查 |

上述结果限定于已验证环境。Node 22、其他 Node 24 小版本、其他 DSH 版本和其他操作系统的支持范围需分别验证。

运行依赖为 Ajv 8.20.0、Zod 4.4.3，开发依赖为 TypeScript 5.9.3、@types/node 24.19.2。具体依赖与锁定结果见 [package.json](../package.json)、[package-lock.json](../package-lock.json)，来源与许可证说明见[复用说明](reuse-notes.md)。

## 产品验证覆盖

既有产品验证记录包括全量 1591 项测试、类型检查、分发文件校验，以及公开宿主服务探针。测试覆盖：

- 独立角色输入、正常完成、否定意见、用户选择、双评审失败和超时。
- 重复请求、operationId 去重、revision 冲突、迟到或冲突结果归档。
- 单 build 写入者、项目写入权、机器检查、独立验证、有界返工和 impact 局部修订。
- 必需检查的输入指纹、onlyNewFailures 基线、检查移除或转 optional 后的问题归档、registry 查询取消。
- 暂停、停止、取消、资源释放、逐运行恢复隔离、固定项目目录及通知重试。
- 认证页面路由、命令结果与索引、历史导入、分页读取和 Client 模块注册。

1591 项是插件产品套件；试用项目合计 160 项测试属于另一组数据，不能合并计算产品通过率。

## 公开宿主接口与工具 scope

现有适配使用公开的 subagents、fs、subprocess、agents、sessionQuery、commands、tools、workingDirectory、sessionProjections，以及相关 Agent 生命周期事件。子任务使用 ContentBlock[]、options.signal、activation.result 和 dispose；读取 sessionQuery 后释放 observation。

角色工具策略读取 `definitions(agent)`，包含该 Agent 可见的祖先 preset 工具。无 Agent 的 definitions 仅返回全局定义。restrict 筛选全局和继承工具，自有工具再由 guard 限制。build 保留读写、编辑、命令能力，review、verify 等非 build 角色使用只读工具，`structured_output`、`review_submit`、`run_code` 传输入口保留。限制在子会话 scope 内生效，不整体改写 root 或 preset。

真实服务探针覆盖 FileRunStore 的原子 create/commit/load、subprocess Node 检查、工具 JSON schema 与返回值、依赖就绪后的挂载及撤回后的释放。页面路由探针使用真实 HostConnectionService、CommandRuntime 和 fs，检查 owner 认证、CommandResult、command/run/done 索引、重复操作、旧 revision 和卸载释放。

索引读取 `command/done.data.text` 与 `tool/result.data.message.content`。页面请求由宿主确认精确 live root Agent 和 owner，request 中的 projectRoot、kind 或 rootSessionId 不作为身份依据。用户回答待选问题仅通过页面或命令提交，五个模型工具不提供 decide。

探针命令在仓库根目录执行，`<DSH_HOME>` 替换为包含宿主 node_modules 的安装目录：

```text
node tools/probe-host-contracts.mjs "<DSH_HOME>"
node tools/probe-review-page.mjs "<DSH_HOME>"
```

## schema 1 与旧数据恢复

状态和结果使用 `schemaVersion: 1`。旧 `@1` preset 与历史会议工具继续使用原逻辑，`quick@2`、`standard@2` 通过 ReviewService 执行。历史默认只读，显式导入时创建新 run 并记录可选 provenance，原任务保持不变。

恢复先读取已保存结果，再核对执行身份和实际项目文件。无有效结果的执行标记 interrupted，用户检查后 retry。坏运行或开发输入的读取异常按运行隔离，保留诊断和重试入口。用户主动暂停的运行不会因只读查询自动继续。

旧的 `onlyNewFailures=false` 运行不增加基线门槛。既有验证通过结果缺代码摘要时，已有恢复测试覆盖 reconcile 补齐并直接生成报告的路径，无需新增模型调用。该路径依赖具体运行状态，其他恢复场景仍按身份、输入和检查条件处理。

0.5 的 build、verify schema 将 `resolvedFindingIds` 作为可选字段，提示明确要求仅填写待复验 verification 问题，列表为空时填 `[]`。未知 ID 仍报 FINDING_NOT_FOUND。旧版试用的漏字段停滞记录保留在[试用结果](practice-results.md)，0.5 未在同条件下重跑整组模型试用。

升级或回退前先暂停并备份 `.review/` 数据。schema 版本相同也不能据此假定任意降级安全，目标版本需能读取实际使用的可选字段与来源数据。

## 0.5.0 界面验收记录

0.5.0 的 client.js 模块加载和 `conversation.view/team-board/order40` 注册已有验证，当时 Client Slot 状态为 active。0.5.1-rc.2 使用总览、讨论、任务、结果四个页签。源码使用主题 tokens，中英文 locale 同步。

本次验证没有屏幕或浏览器操作。浅色与深色主题的实际观感、布局、溢出和交互视觉表现仍需人工检查；Client Slot active 和模块注册成功只确认接入状态。
