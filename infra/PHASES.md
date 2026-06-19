# Phases 2–6

## Phase 2 — Visual Timeline Editor
`components/VisualTimeline.tsx`. Clip blocks are dragged by their edges to trim or
by their body to move; a draggable playhead scrubs. Fully controlled (emits ops +
time). Replaces the old static strip in the editor.

## Phase 3 — Video Preview Sync
`components/VideoPreview.tsx` + `GET /api/projects/:id/source-url` (presigned).
Two-way sync: scrubbing the timeline seeks the video, playback reports time back.
"Preview edit" plays only kept segments back-to-back, jumping across cuts.

## Phase 4 — Explainable AI
`POST /api/projects/:id/explain` → `explainClip()` (fast model). Each clip row has a
**Why?** button that asks Claude why that segment is kept/removed and shows bullet
reasons. Stored per-version `changes` already carry the "why" from each edit.

## Phase 5 — Multi-Agent System
`agents/` — Director → (Editor, Caption, Hook, Social, Thumbnail). `base.ts` runs a
forced-tool Claude call; `orchestrator.ts` runs the Director first, then the
specialists in parallel, returning a combined result + a per-agent log. The analysis
worker now uses the pipeline; the activity feed shows one line per agent. New
`Analysis` columns: `hook`, `thumbnail`, `agentLog`, `strategy`.

## Phase 6 — One-Click Repurposing
`POST /api/projects/:id/repurpose` maps platforms → render formats and fans out one
render per platform with tailored copy. `components/RepurposePanel.tsx` lets the user
pick YouTube / Shorts / TikTok / Reels / LinkedIn / X and generate them all at once.

## Migrations
Phases 5 added columns to `Analysis`; Phase 1 added `EditVersion`. Run:

    npx prisma migrate dev --name phases_1_to_6

Hand-apply reference SQL: `prisma/migrations_reference/edit_versioning.sql`.
