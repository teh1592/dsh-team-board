# Sources and Reuse Notes

[English README](../../README.en.md) | [Chinese original](../reuse-notes.md)

This page records only sources supported by the current source code and confirmed development facts. The plugin implementation was written independently, using design patterns such as stage dependencies, independent reviews, linked decisions, a single writer, check fingerprints, and bounded rework. References to design patterns and copied source code are recorded separately.

## Verified Sources

| Source | How this project uses it | Where to check |
|---|---|---|
| This project's existing team task board and meeting implementation | Retains historical reads, legacy presets, and related tests. New reviews use independent execution, operationId, and ReviewService. | [meeting.mjs](../../src/meeting.mjs), [preset.mjs](../../src/preset.mjs), [artifact.mjs](../../src/artifact.mjs), [host/meeting.js](../../host/meeting.js) |
| DSH public host interfaces | Adapters were independently implemented against public service contracts. The validated host version is 0.2.2-rc.1; no host implementation source code was copied. | [host/dsh](../../host/dsh/), [review-plugin.mjs](../../host/review-plugin.mjs), [Compatibility and Validation Scope](compatibility.md) |
| npm dependencies | Uses Ajv 8.20.0 and Zod 4.4.3. Development tools are TypeScript 5.9.3 and @types/node 24.19.2. Transitive dependencies are recorded in the lockfile. | [package.json](../../package.json), [package-lock.json](../../package-lock.json) |

External projects mentioned during early research are not listed as source-code origins for this version if there are no verifiable source files, pinned commits, or records of actual adoption. Their licenses are not inferred. The current public documentation does not require research notes or internal plans that are absent from the repository.

## License and Dependencies

The project has selected the MIT license. npm dependencies and development tools retain the licenses and notices distributed with their respective packages; the project's license does not replace dependency licenses. The lockfile is authoritative for specific dependency versions, and the files distributed with each npm package are authoritative for its license text.

If external source code is introduced later, add its source, pinned version or commit, adopted files, scope of modifications, and actually verified license information here. Implementations that only reference design patterns should continue to be clearly labeled as independently implemented.
