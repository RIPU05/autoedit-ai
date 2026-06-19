# AI Edit History & Versioning

One source video → many edit strategies, each saved immutably with the AI's reasoning.

## Model

`EditVersion` is an append-only snapshot of a timeline:

| field | meaning |
|-------|---------|
| `name` | short label ("Original AI cut", "Tighter viral cut") |
| `userPrompt` | the instruction that produced it (null for the root) |
| `aiExplanation` | Claude's overall rationale |
| `changes` | `[{ action, target, reasons[] }]` — the *why* for each decision |
| `timelineJson` | `{ operations, effects }` snapshot |
| `parentVersionId` | parent pointer → supports future **branching** (A→B, A→C) |

Existing versions are **never mutated**. The working `EditTimeline` is the current
head; restoring copies an old snapshot back into it **and appends a new version**,
so history stays append-only.

## Lifecycle

1. Analysis completes → a root version **"Original AI cut"** is created (`parentVersionId = null`).
2. Each prompt/goal edit calls Claude, which returns `{ operations, effects, changes, reasoning, versionName }` via tool-use, then appends a version.
3. Restore appends a `Restored: <name>` version and resets the working timeline.

## API (all under `/api/projects/:id`)

| method | path | purpose |
|--------|------|---------|
| POST | `/edit` | prompt/goal edit → new version (returns changes + reasoning) |
| GET | `/versions` | list (newest first) + current `headId` |
| GET | `/versions/compare?a=&b=` | structured diff |
| GET | `/versions/:versionId` | full snapshot |
| POST | `/versions/:versionId/restore` | restore (append-only) |
| PATCH | `/versions/:versionId` | rename |

## UI

- **Version sidebar** (right of the editor): name, prompt, timestamp, AI explanation,
  expandable per-decision "why", rename, restore, and tick-two-to-compare.
- **Compare modal**: clips added / removed, duration delta, and effect/strategy changes.
- **AI Director panel**: goal chips (Go viral, YouTube Shorts, Educational, Podcast,
  Documentary, Sales, LinkedIn) + free-text prompt. Each edit explains itself and
  becomes a new version.

## Migration

Run `npx prisma migrate dev --name edit_versioning` (canonical). A hand-apply
reference is in `prisma/migrations_reference/edit_versioning.sql`.
