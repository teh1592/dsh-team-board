# 评审与开发操作指南

在 Team Board 的开关打开、DSH 运行依赖就绪后，模型可使用以下五个公开工具。新流程要求 subagents 和全新上下文 provider；旧团队任务板、会议与历史导入还需官方 Agent Teams。两个功能开关分别设置，安装前先阅读[依赖与启用检查](dependencies.md)。运行结构见[架构说明](architecture.md)，宿主环境与验证范围见[兼容性说明](compatibility.md)。

| 工具 | 用途 |
|---|---|
| `review_start` | 启动评审或开发，立即返回运行标识 |
| `review_status` | 查询阶段、待处理事项和后续动作 |
| `review_control` | pause、resume、stop、retry、cancel |
| `review_read` | 分页读取运行、意见、决定、任务、检查、报告和诊断 |
| `review_revise` | 修订需求，按影响范围重做或全量重做 |

模型工具没有 `decide`。用户通过页面或 `/review decide` 回答待选问题，阶段子会话中的 `review_submit` 仅负责提交当前执行结果。

## 启动与读取

模型调用：

```json
{"requestId":"需求的稳定请求ID","requirement":"需求正文","preset":"standard@2","mode":"review","materials":[{"name":"接口约定","content":"实际正文","source":"原始文档位置"}]}
```

入口为 review_start。相同 requestId 与内容重复提交返回同一个 run。返回包含 runId、projectRoot、步骤和 nextActions。默认 standard@2，quick@2 省略双角色独立 review 步骤。mode=review 在形成决定和实施要求后生成报告，不执行 build、verify；mode=develop 则继续实施、机器检查和独立验证。quick@2 的 develop 模式仍有独立 verify。

用户命令（`/review start` 简写启动 review 模式；指定 preset 或 develop 模式可使用页面或下文的结构化 request）：

```text
/review start <需求正文>
/review status <runId>
/review read <runId> report
/review read <runId> findings
/review read <runId> decisions
/review read <runId> tasks
/review read <runId> checks
```

review_read 支持 section、id 和 cursor。列表每次 20 项，报告与文件正文每次 16000 字符，返回 nextCursor 后继续读取。artifact 的 id 使用结果中的 resultRef 或 logRef。

## 控制与选择

```text
/review pause <runId>
/review resume <runId>
/review stop <runId>
/review retry <runId>
/review cancel <runId>
/review decide <runId> <questionId> <optionId>
```

问题与选项 ID 使用命令 slug：以英文字母或数字开头，其余只含英文字母、数字、下划线、连字符，例如 timeout-behavior 和 retry-once。模型阶段在保存前校验这条规则，nextActions 中的命令可直接执行。

pause 等当前已启动阶段结束后暂停。stop 立即释放当前执行并保存 interrupted，retry 等旧任务释放后创建新的 execution。cancel 结束该运行。用户选择由命令记录为 user 来源，随后 decide 新会话根据回答生成实施要求与检查条件。

同一 execution 经 review_submit 和 activation 返回两份结果时，首个有效完成结果保持生效，后续不同内容仅归档为 stale。没有有效完成结果的输入版本错误会暂停运行，等待检查。

单评审失败保留错误与有效意见，其余工作继续。两位评审都失败时等待用户选择重试或继续形成降级决定。评审超时先暂停，避免自动反复启动。

模型使用 review_revise 提供新的 requirement、reason 和 operationId。新需求生成 requirementRevision。省略 impact 时全量重做；指定 impact 时按决定、任务、检查或路径影响清单处理：

```json
{"runId":"运行ID","operationId":"revision-2","requirement":"完整的新需求","reason":"变化原因","impact":{"decisionIds":[],"taskIds":["task-1-1"],"checkIds":["node-tests"],"paths":["src/clamp.mjs"],"review":"reuse"}}
```

review 为 reuse 时保留有效 intake、评审与决定，只重做受影响实现、检查和独立验证；依赖该任务的任务也重做。review 为 rerun 时重新评审与形成决定。程序检查引用是否存在。旧输出保留，报告标明复用来源版本。

## 开发与机器检查

review_start 的 mode 设为 develop。start、revise、resume 和 retry 在同一项目队列中检查开发写入权，另一未结束的 develop 运行存在时返回 PROJECT_WRITER_BUSY 并保留原状态。决定生成有验收条件和 writeScopes 的实施任务后，运行只派一个 build 写入者。实现者读取真实代码，提交 changed 和 completedTaskIds；机器检查由 runner 持有进程句柄执行，独立 verifier 读取代码、实际修改与机器结果。

build 子会话可读写文件及执行命令，review、verify 等非 build 子会话按角色限制为只读。工具限制作用于子会话 scope，根会话与祖先 preset 保持原样；角色传输工具保留，非角色自有工具由 guard 限制。任务的 writeScopes 保存允许实施的范围，机器检查按独立的 checks 配置执行。

在项目 `.review/config.json` 配置检查。review_start 也可传 checks 数组覆盖项目检查配置；其余引用与返工次数仍由项目配置取得。

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

kind 支持 test、command；parser 支持 node-test、exit-code，测试检查使用 node-test。phase 为 plan、implementation 或 delivery。Node 输出需有 tests/fail 计数；零测试为 failed，缺摘要、工具缺失和超时为 unknown。普通命令依据实际退出码判断。实施后的 required 失败形成问题并定向返工；unknown 保留原因并局部暂停。此前的 machine finding 继续保留，仅当前 failed 结果触发新的机器返工，failed 后变为 unknown 不额外消耗返工轮数。首次 plan 预检失败时尚未创建实施任务，先暂停等待，resume/retry 会重跑预检。optional 的结果保留在报告。检查移除、改名或转 optional 后，其旧 machine finding 标为 stale 保留历史；仍 required 的同 ID 检查按当前配置与结果判断，持续失败继续阻塞。

inputs 为空时摘要覆盖项目内容，包括新增、未提交文件。可用路径或 glob 限定相关输入；项目配置、各目录包清单和 package-lock.json、npm-shrinkwrap.json、pnpm-lock.yaml、yarn.lock、bun.lock、bun.lockb 仍计入，二进制内容使用宿主 readBytes 计算摘要。整个 `.review/runs/`、`.git/`、node_modules 与常见缓存默认排除。项目基线排除全部检查声明的生成目录；每条检查仅排自己的 outputs，其他步骤的生成物可进入本条 inputs，例如生成 schema 后再验证 generated/**。项目源码符号链接会给出 PROJECT_SYMLINK 诊断，依赖目录不扫描。单文件读取上限64 MiB、总输入256 MiB、文件数20000，超过后明确停止该检查快照。

每条结果保存 configDigest、inputFingerprint、代码摘要、实际退出码、日志引用和结果引用。独立验证与交付前重新核对所有必需检查，包括plan阶段；输入变化使旧结果stale并重跑，缺少当前通过结果则局部等待。输出超出内存缓冲后使用宿主 spill 引用，保留截断标志；宿主收集上限仍适用。onlyNewFailures 为 Node 检查保存实施前基线，有稳定失败名时比较新增失败。workspace.checkBaselines 按检查 ID 保存 collecting/ready/waiting、配置摘要、需求版本和结果引用；工作区已保存但基线缺失时，尚未 build 可补采。基线 unknown、零测试或缺少稳定失败标识时先暂停，修复后 resume 重试。已经 build 却没有同配置可信原始基线时保持暂停，避免将修改后的代码补作原始基线。onlyNewFailures=false 的旧运行不增加这项门槛。

references 支持本地路径、可选 symbol 文本定位、Node 内置模块、workspace 和已安装包。planned 接口允许留待实施。缺失本地引用记 failed；新增外部包使用项目 npm registry 查询并缓存查询结果，网络或解析异常为 unknown。registry 查询使用运行持有的 AbortSignal；stop/cancel/dispose 会取消并等待当前查询，不继续派发余下包查询。

独立验证发现的问题沿用 finding ID 进入定向任务，返工后重新执行相关检查并再次验证。默认自动两轮，达到上限等待用户继续或保留当前成果。完整需求修订与 impact 修订都会重置当期返工计数，旧问题、执行和操作历史继续保留。stop、取消和卸载等待进程与子任务释放；重载与 retry 前会重新读取实际文件并保存差异。

## 技术探针

```text
/review probe <runId>
```

这个命令使用公开 subprocess 执行固定 Node argv，输出 reviewProbe 和 Node 版本，保存 CheckResult 与日志引用。它用于确认命令 adapter 接入；项目检查使用 develop 的 CheckSpec 配置。

## 工作区记录与恢复

运行状态、阶段结果信封和项目配置均使用 `schemaVersion: 1`，定义见 [schemas.mjs](../src/review/schemas.mjs)。结果信封携带 executionId、requirementRevision、decisionRevision、inputFingerprint、kind 和角色 result，恢复时按执行身份及输入版本检查适用性。

运行文件在创建时的 projectRoot 下。会话切目录后通过原结果中的 runId 继续查询。重启时先读取原目录运行，再查子会话中匹配 executionId 与输入版本的已提交结果。只有目录记录而没有结果时显示 interrupted。检查已有输出后用 retry，程序先 drain 旧执行。

坏运行文件逐条保留原文件和诊断，健康运行继续加载。status 中显示 storageDiagnostics 摘要，使用 `/review read <runId> diagnostics` 或 review_read 的 diagnostics 分区查看项目读取错误；id 可筛选具体坏运行。修复原文件后再次查询会重新检查。develop 恢复时的配置 JSON、项目快照或既有输入读取错误只暂停该运行，diagnostic 保存 DEVELOP_RECOVERY_INPUT_ERROR 和原错误；同项目健康运行的 status/read/control 保持可用。修复后 resume 重新检查实际文件。诊断状态或产物的磁盘写入失败仍向调用方上报。

默认每阶段超时 20 分钟，Host Config 的 reviewStageTimeoutMs 可调整。完成、等待用户和异常通过根 Agent followup 通知，通知失败保存 pending，原会话恢复后重试。通知只提供 status/read 动作，执行控制前读取最新状态。

## 无屏幕启用入口

原有公开 HTTP 路由保持：

```http
POST /api/team-board/state
Content-Type: application/json

{"enabled":true,"sessionId":"当前根会话ID"}
```

enabled 在生成快照前保存。sessionId 用于读取该会话数据，单独修改开关只需 enabled。验证前先用同路由读取原值，验证完成恢复原值。请求应使用当前 GUI 的正常已认证 transport；若宿主返回访问错误，按其访问方式处理。

此路由来自原有用户开关，review 沿用同一设置。新运行无需写 profile 文件。

## 运行页面与结构化接口

团队台账页签保留原任务板和设置，上方增加评审与开发运行区。用户可启动 review/develop、选择 quick@2/standard@2、暂停或继续、修订需求、回答待选问题，并分页读取角色执行、意见、决定、任务、检查、报告和日志。页面以当前会话列出运行，切目录后也查询日志索引中记录的原项目。刷新按钮重新读取状态，读失败显示具体错误并保留输入。

页面操作使用同一 ReviewService。已认证 owner 请求提交到：

```http
POST /api/team-board/review
Content-Type: application/json

{"sessionId":"当前精确根会话ID","request":{"action":"start","requestId":"稳定请求ID","requirement":"需求正文","preset":"quick@2","mode":"review"}}
```

Host 用 connection.admit 和 exact live root Agent 确定身份，再执行 commands.execute(agent, `/review request ${JSON.stringify(request)}`, [], signal)。请求体只接收 sessionId、request，projectRoot、kind、rootSessionId 均不充当身份。原 `/review start/status/read/decide/...` 语法继续可用。

| action | request 字段（action 以外） |
|---|---|
| start | requestId、requirement；可选 preset、mode、materials、checks |
| list | 可选 cursor |
| status | runId |
| read | runId、section；可选 cursor、id |
| pause / stop / resume / retry / cancel | runId、operationId；可选 expectedRevision |
| revise | runId、operationId、requirement、reason；可选 expectedRevision、impact |
| decide | runId、questionId、optionId、operationId；可选 expectedRevision |
| history | 可选 historyId、cursor |
| import | historyId、requestId；可选 requirement、preset、mode |

路由返回 `{ok:true,value:{commandId,result:{kind,text}}}`，text 为业务结果 JSON。调用方同时检查 ok 和 result.kind。业务失败保留 kind=error 与具体文本，认证或路由错误返回 `{ok:false,error:{code,message}}`。command/run 与 command/done 均由宿主记录，顶层 runId/projectRoot 结果供原 session-index 定位。重复投递保留原 requestId 或 operationId，已接受的重复操作先去重，再检查 revision。新操作遇到旧 expectedRevision 时显示 REVISION_CONFLICT，刷新状态后保留草稿。

read section 保留原分区，新增 checkSpecs（定义）、checkResults（结果）、usage（可追溯统计）。列表每页 20 项，正文每页 16000 字符，nextCursor 为下一页起点。页面按页替换并提供上一页，内存不会因连续读日志而无限累积。details 的 view-model 为 src/review/view-model.mjs 中 reviewViewModel(runDetail, section, page)，其中 runDetail 来自 read/run，page 来自选定分区。页面源码为 client/review-panel.mjs，npm run build:client 将它与 view-model 内联进分发 client.js，validate-package 校验产物和 locale 一致性。

历史任务默认只读，读取不会 recover/kick。显式 import 创建新 run，保存来源 session/task/revision/meeting/preset、内容 digest、导入时间和操作者。旧证据标记 imported/unknown，新执行补齐当前结果，原任务保持原样。用户选择继续由页面或命令提交，模型工具没有 decide。

usage 从子会话已提交 assistant/message.data.usage 读取，保存 eventSeqs 来源，observation 用完即释放。时间来自 execution.startedAt/endedAt 和 run.createdAt/updatedAt，返工来自已保存 rework.count。缺失 token、人工处理时间和旧返工值用 null/unknown。读取支持请求取消，卸载取消并等待 observation 释放。读取 usage 时应同时检查完整性，缺失项不能当作零。产品默认值为 standard@2、20 分钟阶段超时及两轮返工；公开试用汇总见[试用结果](practice-results.md)。

build/verify 的 resolvedFindingIds 仅填输入 pendingVerificationFindingIds 中已修复的 verification 问题 ID。初始 review 意见通过 decisions/tasks 验收，待复验列表为空时填 []。未知 ID 仍返回 FINDING_NOT_FOUND。

## 宿主探针与版本切换

以下命令在本仓库根目录执行。`<DSH_HOME>` 指包含 `node_modules/@deepseek-ai/` 的已安装 DSH 目录，执行前替换为实际路径；路径含空格时保留引号。

```text
node tools/probe-host-contracts.mjs "<DSH_HOME>"
node tools/probe-review-page.mjs "<DSH_HOME>"
```

这两个探针检查公开宿主服务合约，以及认证 Fetch 路由、CommandRuntime、日志索引、重复操作、版本冲突和资源释放。探针结果与真实模型试用、页面视觉检查分别记录，验证范围见[兼容性说明](compatibility.md)。

版本切换前先暂停运行并备份项目 `.review/` 数据，等待子任务和检查进程释放。当前 schemaVersion=1 支持旧运行恢复，历史导入增加可选 provenance 字段。恢复兼容不等于可以任意降级：保留完整数据副本，并确认目标版本能读取所需字段后再切换。不要为绕过校验手动删除版本、执行身份或来源信息。
