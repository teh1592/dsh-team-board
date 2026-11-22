# Contributing

[English README](README.en.md) | [Chinese original](CONTRIBUTING.md)

Start by describing the specific problem you want to solve in an issue, then submit a focused change. Bug reports should include the DSH, Node.js, and plugin versions, steps to reproduce, expected results, and actual results. Include only relevant excerpts from run logs, and remove account information, project content, and credentials first.

For background, see the [Operations Guide](docs/en/operations.md), [Architecture](docs/en/architecture.md), and [Compatibility and Validation Scope](docs/en/compatibility.md).

## Local Validation

```bash
npm ci --ignore-scripts
npm test
npm run typecheck
node tools/build-client.mjs --check
npm run validate-package
```

Client source files are `client/review-panel.mjs` and `src/review/view-model.mjs`. After changing them, run `npm run build:client` and include the generated `client.js` and locale updates in the same submission.

Protocol-only and state tests use Node's built-in test runner. Probes that require a real host are run separately; ordinary CI does not start models or modify the DSH profile:

```text
node tools/probe-host-contracts.mjs <DSH_INSTALLATION_DIRECTORY>
node tools/probe-review-page.mjs <DSH_INSTALLATION_DIRECTORY>
```

Use the current Service Inspect output and the installed DSH version's public contracts as the authority for host interfaces. When changing stage outputs, also check schemas, input materials, recovery logic, and version applicability. When adding a check parser, cover its behavior for zero tests, failures, timeouts, and missing output.

## Contribution Requirements

- Include tests that demonstrate the changed behavior, or provide clear validation steps.
- Preserve compatibility with older runs. Migrations must include a version and examples.
- Do not commit `node_modules`, `.review/runs`, personal paths, account information, or original task materials.
- This project is released under the MIT license; contributions should be compatible with that license.

## Releases

After reviewing tests and the changelog, maintainers create a `v<package.json version>` tag. Once tests pass, the Release workflow generates an npm installation package and a SHA256 checksum file, then uploads them to GitHub Release. It does not publish to npm.
