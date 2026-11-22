# Trial Results and Limitations

[English README](../../README.en.md) | [Chinese original](../practice-results.md)

This document publishes confirmed aggregate results without raw child sessions, run IDs, user paths, or logs. For product automated tests and host validation, see [Compatibility and Validation Scope](compatibility.md). For usage instructions, see the [Operations Guide](operations.md). These trials were intended to observe workflow behavior. Comparisons must account for differences in versions, time budgets, and prompts.

## Versions and Trial Conditions

The trials covered 5 task categories, each attempted with the single, quick, and standard strategies, for a total of 15 trial projects. single was the single-session control; quick and standard used the `quick@2` and `standard@2` workflows.

The original trials used an immutable 0.4 version. The first-round time budget was 240 seconds, followed by a 1200-second continuation, and the prompts also differed. The released product is 0.5, and this set of model trials has not been rerun under the same conditions. The table below therefore describes that particular 0.4 trial record. It cannot be treated as a same-condition performance result for 0.5 or used to establish a rigorous ranking of the strategies.

## Completion and Project Tests

| Strategy | Completed projects | Total projects |
|---|---:|---:|
| single | 5 | 5 |
| quick | 5 | 5 |
| standard | 4 | 5 |

The final standard project stopped at req1 because a stage result omitted `resolvedFindingIds`, and delivery was not completed. This was a structured-output problem in that run; the stopped run must not be counted as completed.

Across the 15 trial projects, 160 project tests were executed: 159 passed and 1 failed. Here, 160 is the total number of tests in the trial projects. It does not mean 160 trial projects, nor does it refer to the plugin's product test suite. The product suite has a separate validation record of 1591/1591 passing tests. These two sets of figures are kept separate.

In 0.5, the schema and prompts clarify the purpose of `resolvedFindingIds`: report only fixed verification findings from the input `pendingVerificationFindingIds`. Initial review feedback is accepted through decisions/tasks. When the pending re-verification list is empty, use `[]`. This implementation detail is not a substitute for rerunning the model trials under the same conditions.

## What Review Comments and Findings Mean

The trials produced 56 review comments in total. Their validity has not been confirmed individually, so they cannot be counted as 56 confirmed defects.

All 3 verification findings concerned logs, line numbers, or command descriptions. The existing records do not support classifying these three findings as discovered defects in product logic. Counts of review comments and verification findings should both be distinguished from the final number of valid defects.

## Usage and Missing Data

Usage statistics cover 74 sessions, of which 6 have incomplete records. The quick and standard figures below sum only sessions with complete records and are lower bounds on recorded tokens. The complete totals for both strategies are unknown.

| Strategy | Input tokens | Output tokens | Completeness |
|---|---:|---:|---|
| single | 169880 | 36273 | Recorded aggregate for the single-session control |
| quick | ≥686368 | ≥171357 | Lower bound from sessions with complete records; total unknown |
| standard | ≥1428937 | ≥370964 | Lower bound from sessions with complete records; total unknown |

Manual handling time is unknown. Missing records are not filled with zeros, and the lower bounds above are not converted into complete costs, savings percentages, or exact ratios between strategies. The 240-second first round, 1200-second continuation, and prompt differences further limit direct comparisons of time and usage.

## What These Results Establish

This trial recorded completion, structured-output stalls, and traceable usage for two multi-stage workflows on a limited sample of tasks. Separate product-level evidence includes 1591/1591 passing automated tests, acceptance with 21 live commands, and confirmation that the Client Slot was active. Each type of evidence has its own scope and cannot replace the others.

Same-condition model trials for 0.5, individual validation of review comments, complete usage data, and manual handling time remain to be supplied. No screen or browser operations were performed during validation, and page appearance was not included in the results.
