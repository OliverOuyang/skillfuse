/** Built-in sample so users can try the pipeline without a file. */
export const SAMPLE_SKILL = `---
name: weekly-report-writer
description: >
  Generate a polished weekly team report in Markdown from raw notes, CSV metrics
  or a project URL. Trigger keywords: 周报, weekly report, status update.
  Use when the user asks for a weekly summary, 写周报 or a status digest.
---

# Weekly Report Writer

Turn scattered notes and metrics into a consistent weekly report.

## Inputs

- Raw meeting notes or bullet fragments (natural language)
- Optional CSV file with weekly metrics
- Optional project board URL for context

## Workflow

1. Collect the user's raw notes, CSV metrics and any linked context.
2. Group work items into the canonical sections below.
3. Quantify progress wherever CSV metrics are available — every claim should cite a number.
4. Write the report in Markdown, then offer a docx export if the user asks.

## Output format

The report must follow this structure:

- Highlights of the week
- Progress by workstream (table with owner, status, delta)
- Metrics snapshot (table from the CSV)
- Risks and blockers
- Plan for next week

## Rules

- Must keep the five output sections in the order above.
- Must write dates in ISO format (YYYY-MM-DD).
- Never invent metrics that are not in the CSV.
- Never use emoji in the report body.
- Do not include attendee lists or raw meeting transcripts.
- Always flag workstreams with no update as "no update provided".

## Quality bar

- The report should be readable in under 3 minutes.
- Highlights should be outcome-oriented, not a task list.
- Tables should be consistent week over week so they can be diffed.

## Example

\`\`\`markdown
## Highlights of the week
- Shipped the new onboarding flow; activation rose 12% WoW (n=4,213).

## Metrics snapshot
| metric | this week | last week | delta |
| --- | --- | --- | --- |
| activation | 38.2% | 34.1% | +4.1pp |
\`\`\`
`;
