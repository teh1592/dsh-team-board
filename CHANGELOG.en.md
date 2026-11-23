# Changelog

[English README](README.en.md) | [Chinese original](CHANGELOG.md)

## 0.5.1-rc.2 — Candidate

- Keep only review and development runs in the page; remove Agent Teams views and legacy team-task import.
- Read the plugin switch without querying team tasks, members, or role records, including when enabled.
- Shorten the Chinese and English dependency guides to minimum requirements and three setup steps.

## 0.5.1-rc.1 — Candidate

- Replace the stacked panels with one Overview, Discussion, Tasks, and Results interface and on-demand details.
- Use one navigation for runs and the current session team while preserving their actual data sources and existing actions.
- Connect findings, decisions, and tasks through recorded IDs and preserve each check execution's identity.
- Isolate drafts, requests, and late responses by context; retry writes with their original operation identities.
- Correct impact revisions that reused superseded decisions, retaining previous questions, answers, and reports.

This candidate is for review and trial. Publication is a separate step.

## 0.5.0 — 2026-11-22

First GitHub source release, including the previously completed review and development workflows.

### Features

- Persistent intake, independent review, decide, build, check, verify, and report workflow.
- quick@2 and standard@2, with review and develop task modes.
- Per-project write control, check results bound to code digests, and targeted rework by finding ID.
- Pause, resume, cancellation, archiving of late results, and requirement revisions based on impact lists.
- Team Board run page, authenticated interfaces, structured commands, historical imports, and paginated logs.
- Child-session usage provenance and propagation of unknown values.

### Fixes

- Read-only resolution of status and details does not trigger run recovery.
- Imported historical stage tasks retain their associated meeting and preset.
- Tool reads propagate the caller's cancellation signal and promptly release session observation resources.
- Clarified the different purposes of finding IDs pending re-verification and initial review feedback.

### Validation

Before the source was made public, 1591/1591 product tests passed, and acceptance checks against real DSH interfaces passed. Of 15 real-task trials, 14 passed and 1 stopped because a structured-result field was omitted. See [Trial Results](docs/en/practice-results.md) for detailed conditions and usage limitations.

The GitHub source release adds the MIT license, public documentation, repository metadata, and CI. The runtime implementation remains the validated 0.5.0 implementation. GitHub Release assets are repackaged from this repository's source, with checksums provided alongside the Release.
