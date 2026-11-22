# 来源与复用说明

本页只记录当前源码和已确认开发事实能支持的来源。插件实现自行编写，采用阶段依赖、独立评审、决定关联、单写入者、检查指纹和有界返工等设计模式；模式参考与源码复制分别记录。

## 已核实来源

| 来源 | 本项目使用方式 | 可核对位置 |
|---|---|---|
| 本项目既有团队任务板与会议实现 | 保留历史读取、旧 preset 和相关测试，新评审使用独立 execution、operationId 和 ReviewService | [meeting.mjs](../src/meeting.mjs)、[preset.mjs](../src/preset.mjs)、[artifact.mjs](../src/artifact.mjs)、[host/meeting.js](../host/meeting.js) |
| DSH 公开宿主接口 | 按公开服务合约自行实现适配，已验证宿主版本为 0.2.2-rc.1；未复制宿主实现源码 | [host/dsh](../host/dsh/)、[review-plugin.mjs](../host/review-plugin.mjs)、[兼容性说明](compatibility.md) |
| npm 依赖 | 使用 Ajv 8.20.0、Zod 4.4.3；开发工具为 TypeScript 5.9.3、@types/node 24.19.2，传递依赖由锁文件记录 | [package.json](../package.json)、[package-lock.json](../package-lock.json) |

早期研究中提及但缺少可核对来源文件、固定提交或实际采用记录的外部项目，不列为本版本的源码来源，也不推断其许可证。当前公开文档无需依赖未随仓库提供的研究笔记或内部计划。

## 许可证与依赖

项目已选择 MIT 许可证。npm 依赖及开发工具保留各自随包提供的许可证和声明，项目许可证不替代依赖许可证。具体依赖版本以锁文件为准，许可证正文以相应 npm 包所附文件为准。

若后续引入外部源码，应在此补充来源、固定版本或提交、采用文件、修改范围以及实际核对的许可证信息。仅参考设计模式的实现，应继续明确标为自行实现。
