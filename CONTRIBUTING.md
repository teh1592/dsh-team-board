# 参与开发

先在 issue 中说明想解决的具体问题，再提交范围集中的修改。问题报告请包含 DSH、Node.js、插件版本、复现步骤、预期结果和实际结果；运行日志只保留与问题相关的片段，先移除账号、项目内容和凭据。

## 本地验证

```bash
npm ci --ignore-scripts
npm test
npm run typecheck
node tools/build-client.mjs --check
npm run validate-package
```

Client 源码位于 `client/review-panel.mjs` 与 `src/review/view-model.mjs`。修改后运行 `npm run build:client`，将生成的 `client.js` 和 locale 更新一并提交。

纯协议和状态测试使用 Node 内置测试运行器。需要真实宿主的探针另行执行，不会由普通 CI 启动模型或修改 DSH profile：

```text
node tools/probe-host-contracts.mjs <DSH_INSTALLATION_DIRECTORY>
node tools/probe-review-page.mjs <DSH_INSTALLATION_DIRECTORY>
```

宿主接口以当前 Service Inspect 和已安装 DSH 的公开合约为准。改变阶段输出时同步检查 schema、输入材料、恢复逻辑和版本适用性。新增检查 parser 时覆盖零测试、失败、超时与缺少输出的行为。

## 提交要求

- 修改附带能说明行为的测试，或给出明确验证步骤。
- 保留旧运行兼容性，迁移必须有版本和样例。
- 不提交 `node_modules`、`.review/runs`、个人路径、账号信息和原始任务材料。
- 本项目按 MIT 许可发布，贡献内容应与该许可兼容。

## 发布

维护者核对测试与更新记录后，创建 `v<package.json version>` 标签。Release 工作流在测试通过后生成 npm 安装包和 SHA256 校验文件，上传 GitHub Release，不发布到 npm。
