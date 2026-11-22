# E_* 码清单：gates.mjs 与 delivery.mjs

这份清单一共 **33 个码**（gates.mjs 18 个 + delivery.mjs 23 个，其中 8 个两边同名重复），
locale 已译的有 **1 个**：`E_INDEPENDENCE_UNENFORCED`。

关于 locale：`plugin/locale/zh.json` 里只有两条 `gates.code.*` 键，分别是
`gates.code.E_INDEPENDENCE_UNENFORCED`（第 49 行）和 `gates.code.E_DECLARATION_MISSING`（第 50 行）。
后者在这两个文件里**没有任何发射点**（整个 `plugin/` 源码里也搜不到，只有 locale 和测试在引用它），
所以它不计入这 33 个码，见文末「存疑」。

出处列是**真正发射它的那一行**（构造 `{code: 'E_...'}` 或 `push/add('E_...', ...)`），不是常量注册表那一行。
同一个码有多处发射就分行列出。表按「文件 → 行号」排序。

## 清单

| 码 | 出处 | 一句话人话解释 | severity |
|---|---|---|---|
| `E_ILLEGAL_TRANSITION` | `plugin/src/gates.mjs:312` | 请求的状态转移连「从哪到哪」都没说清（缺 from 或 to），门禁只能拒绝。 | 未标注 |
| `E_ILLEGAL_TRANSITION` | `plugin/src/gates.mjs:323` | 想要的这条状态跳转不在允许表里（例如 pending 直接跳到 completed），一律拒绝。 | 未标注 |
| `E_ILLEGAL_TRANSITION` | `plugin/src/gates.mjs:331` | 跳转本身合法，但发起人角色不对：该干活的人发起的，被领导发起了（或反过来）。 | 未标注 |
| `E_INPUT_INVALID` | `plugin/src/gates.mjs:439` | 插件层传来的「这是第几轮」不是正整数（写了 `'2'`、2.5、0 之类），不许当成第 1 轮混过去。 | 未标注 |
| `E_INPUT_INVALID` | `plugin/src/gates.mjs:449` | 任务记录上的轮次数字同样非法（`{n,id}` 里的 n 坏了），也不许静默降级成「不判新旧」。 | 未标注 |
| `E_INPUT_INVALID` | `plugin/src/gates.mjs:458` | 插件层说这是第 N 轮、任务记录说第 M 轮且 N≠M：两边对不上，门禁不替你挑一个。 | 未标注 |
| `E_INPUT_INVALID` | `plugin/src/gates.mjs:778` | 评审结论写了个白名单外的值（多半是拼错），当成坏输入，而不是「某种未通过」。 | 未标注 |
| `E_INPUT_INVALID` | `plugin/src/gates.mjs:799` | 某条问题记录没写严重度，判不了它要不要拦住通过，所以直接报错。 | 未标注 |
| `E_INPUT_INVALID` | `plugin/src/gates.mjs:804` | 某条问题记录的严重度拼错（不在 7 个合法档位里），不许因为不认识就当低危放过。 | 未标注 |
| `E_STALE_ATTEMPT` | `plugin/src/gates.mjs:587` | 已经到第 2 轮以上了，还有回执没标「第几轮」，无法证明是这一轮跑的，不计入验收覆盖。 | 未标注 |
| `E_STALE_ATTEMPT` | `plugin/src/gates.mjs:596` | 回执上标的轮次不是正整数，看不懂就按「不属于本轮」处理，不计入覆盖。 | 未标注 |
| `E_STALE_ATTEMPT` | `plugin/src/gates.mjs:604` | 回执标的是别的轮次（典型：把上一轮的回执原样拿来这轮用），不计入本轮覆盖。 | 未标注 |
| `E_VERDICT_REQUIRED` | `plugin/src/gates.mjs:775` | 评审任务压根没给结论，而「通过」是唯一能算完成的值。 | 未标注 |
| `E_VERDICT_REQUIRED` | `plugin/src/gates.mjs:784` | 结论是「要改」或「打回」：裁决本身合法，但它表示评审没过，任务不能算完成。 | 未标注 |
| `E_FINDINGS_REQUIRED` | `plugin/src/gates.mjs:788` | 给了「要改」或「打回」却一条具体问题都没写，等于没说该改什么。 | 未标注 |
| `E_OPEN_FINDINGS` | `plugin/src/gates.mjs:815` | 结论说「通过」，但还挂着没解决的严重问题，自相矛盾。 | 未标注 |
| `E_CONTRACT_AMBIGUOUS` | `plugin/src/gates.mjs:930` | 同一个契约字段在 `task.contract` 里和任务顶层各写了一份且值不同，拒绝替调用方选一个。 | 未标注 |
| `E_CONTRACT_INCOMPLETE` | `plugin/src/gates.mjs:950` | 质量类任务缺「验收项」或缺「验证命令」——少写一个字段就能把门禁关掉，所以直接拒。 | 未标注 |
| `E_VERIFY_FAILED_BY_RUNTIME` | `plugin/src/gates.mjs:977` | 某条验证命令的回执退出码不是 0，也就是这条验证实际没通过。 | 未标注 |
| `E_VERIFY_MISSING` | `plugin/src/gates.mjs:996` | 契约要求的某条验证命令一条对应回执都没有，无法证明它被跑过。 | 未标注 |
| `E_ACCEPTANCE_MISMATCH` | `plugin/src/gates.mjs:1019` | 契约里的某条验收项在验收结果里没有对应记录，验收没有逐条对账。 | 未标注 |
| `E_ACCEPTANCE_MISMATCH` | `plugin/src/gates.mjs:1031` | 某条验收项的状态不是「通过」（没通过、或没填）。 | 未标注 |
| `E_EVIDENCE_UNBACKED` | `plugin/src/gates.mjs:1040` | 验收项的证据没写成 `receipt:<id>` 形式（写文件路径不算：文件存在 ≠ 跑过）。 | 未标注 |
| `E_EVIDENCE_UNBACKED` | `plugin/src/gates.mjs:1056` | 验收项引用的那条回执根本不存在（不是过期，是压根没有）。 | 未标注 |
| `E_EVIDENCE_UNBACKED` | `plugin/src/gates.mjs:1062` | 验收项引用的回执退出码不是 0，不是一次成功的运行，不能当证据。 | 未标注 |
| `E_UNREPORTED_CHANGES` | `plugin/src/gates.mjs:1080` | 实际 diff 里改了某个文件，但申报的改动清单里没有它（偷偷改）。 | 未标注 |
| `E_PHANTOM_CHANGES` | `plugin/src/gates.mjs:1086` | 申报说改了这个文件，实际 diff 里根本不存在（虚报）。 | 未标注 |
| `E_PATH_UNSAFE` | `plugin/src/gates.mjs:1109` | 申报或 diff 里出现了工作区外的路径（绝对路径、`..` 穿越、`~` 开头、盘符等），拒绝。 | 未标注 |
| `E_PATH_UNSAFE` | `plugin/src/gates.mjs:1123` | 范围声明（inScope/outOfScope）本身就写了非法路径：要改的是这条声明，不是别的路径归属。 | 未标注 |
| `E_SCOPE_UNDECLARED` | `plugin/src/gates.mjs:1137` | 申报了改动，却完全没声明范围，没有范围就没有审计依据，一律拒绝。 | 未标注 |
| `E_OUT_OF_SCOPE` | `plugin/src/gates.mjs:1148` | 申报的路径不在声明的 inScope 之内（或命中了 outOfScope），越界了。 | 未标注 |
| `E_CHANGED_PATHS_REQUIRED` | `plugin/src/gates.mjs:1160` | 实现类任务一条改动路径都没申报：没有改动就没有可交付的东西。 | 未标注 |
| `E_NEEDS_HUMAN_APPROVAL` | `plugin/src/delivery.mjs:724` | 团队还停在「等人批准」阶段，不是停了，而是还没资格宣布交付。 | blocker |
| `E_NOT_RUNNING` | `plugin/src/delivery.mjs:731` | 团队已经停了（暂停或归档），只有运行中的团队才能宣布交付。 | blocker |
| `E_NOT_RUNNING` | `plugin/src/delivery.mjs:737` | 团队阶段缺失或拼错（`RUNNING`、`runing` 这类），不认这种状态，按不能交付处理。 | blocker |
| `E_CONTRACT_AMBIGUOUS` | `plugin/src/delivery.mjs:777` | 同上那条歧义判定：交付这最后一道门也不替调用方在两种写法里挑一个值。 | blocker |
| `E_INPUT_INVALID` | `plugin/src/delivery.mjs:787` | 任务的类型字段拼错/不在白名单，这条记录会从所有判定里凭空消失（幽灵任务）。 | blocker |
| `E_INPUT_INVALID` | `plugin/src/delivery.mjs:794` | 任务的状态字段拼错/不在白名单，同样等于让这条记录消失，所以是坏输入。 | blocker |
| `E_INPUT_INVALID` | `plugin/src/delivery.mjs:802` | 任务的轮次不是正整数，不许拿非法写法当「跳过轮次对齐」的开关。 | blocker |
| `E_INPUT_INVALID` | `plugin/src/delivery.mjs:1079` | 评审记录里的轮次不是正整数（只认单个数字，`{n:2}` 也不行）——那是「上一轮评审给这一轮背书」的入口。 | blocker |
| `E_INDEPENDENCE_UNENFORCED` | `plugin/src/delivery.mjs:830` | 全团队一个负责人都没有：「是不是自己审自己」「评审是不是停滞」两条判据整体失效，只提醒不拦。 | warning（无字段，实际进 warnings） |
| `E_CONTRACT_INCOMPLETE` | `plugin/src/delivery.mjs:863` | 交付时读不到验收项或验证命令，就无法说明这份交付被验证过（纯执行类任务豁免）。 | blocker |
| `E_TASK_INCOMPLETE` | `plugin/src/delivery.mjs:877` | 还有任务卡在「待认领 / 已认领 / 进行中」，没有结论。 | blocker |
| `E_FAILED_NO_FOLLOWUP` | `plugin/src/delivery.mjs:892` | 有任务失败了，却没有任何后续任务接着它——失败被无声吞掉。 | blocker |
| `E_VERDICT_REQUIRED` | `plugin/src/delivery.mjs:904` | 评审任务已经完成，但结论不是「通过」（或者没写结论）。 | blocker |
| `E_NO_PASSING_REVIEW` | `plugin/src/delivery.mjs:916` | 有实现任务已完成，但整队找不到一条「已完成且通过」的评审。 | blocker |
| `E_PATH_UNSAFE` | `plugin/src/delivery.mjs:928` | 任务的范围声明里有非法路径；声明坏了就只报这一条，不再叠加「越界」以免指错修法。 | blocker |
| `E_PATH_UNSAFE` | `plugin/src/delivery.mjs:962` | 被审计的改动路径（任务申报的、以及实际 diff）里有非法路径。 | blocker |
| `E_OUT_OF_SCOPE` | `plugin/src/delivery.mjs:980` | 实现类任务申报的路径不在声明的范围内，或命中了排除范围。 | blocker |
| `E_WORK_DECLARED_CHANGES` | `plugin/src/delivery.mjs:990` | 「只读调研」类任务却申报改了文件：它本来就不该产生代码变更，这等于伪造。 | blocker |
| `E_BINDING_STALE` | `plugin/src/delivery.mjs:1021` | 评审记录说这个产物当时不存在，它现在却有了——审完之后又被动了。 | blocker |
| `E_BINDING_STALE` | `plugin/src/delivery.mjs:1028` | 评审记录里的产物现在没了。 | blocker |
| `E_BINDING_STALE` | `plugin/src/delivery.mjs:1046` | 产物现在的指纹与评审记录里的不一致：审完之后文件被改了。 | blocker |
| `E_BINDING_UNVERIFIABLE` | `plugin/src/delivery.mjs:1036` | 评审记录里的产物没写指纹，没指纹就证明不了审后没被篡改，不能靠省略字段跳过比对。 | blocker |
| `E_NEEDS_HUMAN_DELIVERY` | `plugin/src/delivery.mjs:1057` | 团队还没有一条合格的交付登记（缺签发方、缺调用号、缺证据指纹，或不是宿主签发）。 | blocker |
| `E_CANCELLED_NO_REASON` | `plugin/src/delivery.mjs:1067` | 任务被取消了，却没写取消原因。 | blocker |
| `E_STALE_ATTEMPT` | `plugin/src/delivery.mjs:1100` | 评审记录的是被审任务上一轮的轮次，不能为当前这一轮背书。 | blocker |
| `E_UNREPORTED_CHANGES` | `plugin/src/delivery.mjs:1126` | 工作区里有文件被改了，但没有任何「已完成」的代码变更任务申报过它。 | blocker |
| `E_UNBOUND_ARTIFACT` | `plugin/src/delivery.mjs:1191` | 某任务申报的路径，没有任何一条「针对它自己」的通过评审绑定过（别的任务的评审不算背书）。 | blocker |
| `E_SELF_REVIEW` | `plugin/src/delivery.mjs:1281` | 评审人和被审任务的负责人是同一个人，自己审自己，独立性不成立。 | blocker |
| `E_NO_ASSIGNEE` | `plugin/src/delivery.mjs:1298` | 队里别的任务都有负责人，这个质量任务却没有——只填一部分，独立性判定就只覆盖一部分。 | blocker |
| `E_REVIEW_STAGNATION` | `plugin/src/delivery.mjs:1364` | 同一个人对同一个文件连续 3 次以上都判「通过」，提醒注意力可能衰减；只是提醒，不阻断交付。 | warning |

## severity 是怎么来的

- `gates.mjs` 的错误对象里**没有任何 severity 字段**，全是 `{code, message}` 塞进 `errors[]`，
  只要有一条就 `ok: false`。所以该列写「未标注」，不臆测成 blocker。
- `delivery.mjs` 只有三处带 `severity` 字段：`E_SELF_REVIEW`（`plugin/src/delivery.mjs:1283`
  `severity: 'blocker'`）、`E_NO_ASSIGNEE`（`plugin/src/delivery.mjs:1300` `severity: 'blocker'`）、
  `E_REVIEW_STAGNATION`（`plugin/src/delivery.mjs:1366` `severity: 'warning'`）。
- 其余 delivery 码没有该字段，标成 blocker 的依据是**代码实际行为**：它们经 `add()`
  （`plugin/src/delivery.mjs:764`）进入 `blockers`，而 `ok = blockers.length === 0`
  （`plugin/src/delivery.mjs:1201`）。
- `E_INDEPENDENCE_UNENFORCED` 也没有字段，但它进的是 `warnings`
  （`plugin/src/delivery.mjs:829-830`），`warnings` 不影响 `ok`，所以按行为是 warning。

## 附：登记了但从不发射的码（仅供参考）

这些码出现在 `delivery.mjs` 的登记表里，但没有任何 `add()`/`push()` 发射它们，
所以不在上表的 33 个里：

- `E_ASSIGNEE_PROJECTION` — `plugin/src/delivery.mjs:1431`，属插件层职责的记账条目。
- `E_BINDING_OWNER_MISMATCH`、`E_SCOPE_UNDECLARED`（指 delivery 侧）、`E_BINDING_OWNER_UNTESTED`、
  `E_NO_ARTIFACT_BINDING` — `plugin/src/delivery.mjs:1453-1482` 的 `coveredElsewhere`，
  说明「这个码由别的码代表」，本身不发。

## 存疑（未确认）

- **`E_DECLARATION_MISSING`**：`plugin/locale/zh.json:50` 与 `plugin/locale/en.json:50` 都有它的文案，
  `plugin/test/client.test.mjs:172-173` 还断言「它必须有文案」，但在 `plugin/src/gates.mjs`、
  `plugin/src/delivery.mjs` 以及整个 `plugin/` 源码里都**找不到发射它的地方**。
  因此谈不上「出处行号」和「severity」，这里只记录它存在，不猜。
