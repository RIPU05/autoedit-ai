import { prisma } from '../lib/prisma.js';
import type { TimelineOp, TimelineEffects, EditChange } from './claude.service.js';

export interface TimelineSnapshot {
  operations: TimelineOp[];
  effects: TimelineEffects;
}

/** The most recent version for a project (current head of history). */
export async function getHeadVersion(projectId: string) {
  return prisma.editVersion.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Append an immutable version. Existing versions are never mutated.
 * If parentVersionId is omitted we attach to the current head, forming a
 * linear history by default (the schema still supports arbitrary branching).
 */
export async function createVersion(input: {
  projectId: string;
  name: string;
  timeline: TimelineSnapshot;
  userPrompt?: string | null;
  aiExplanation?: string | null;
  changes?: EditChange[];
  parentVersionId?: string | null;
}) {
  const parentId =
    input.parentVersionId !== undefined
      ? input.parentVersionId
      : (await getHeadVersion(input.projectId))?.id ?? null;

  return prisma.editVersion.create({
    data: {
      projectId: input.projectId,
      name: input.name,
      userPrompt: input.userPrompt ?? null,
      aiExplanation: input.aiExplanation ?? null,
      changes: (input.changes ?? []) as object,
      timelineJson: input.timeline as object,
      parentVersionId: parentId,
    },
  });
}

const keptKeys = (ops: TimelineOp[]) =>
  ops
    .filter((o) => o.keep !== false)
    .map((o) => `${o.start.toFixed(1)}-${o.end.toFixed(1)}`);

const totalDuration = (ops: TimelineOp[]) =>
  ops.filter((o) => o.keep !== false).reduce((s, o) => s + Math.max(0, o.end - o.start), 0);

export interface VersionDiff {
  clipsAdded: string[]; // segment keys present in B but not A
  clipsRemoved: string[]; // present in A but not B
  durationChangeSec: number; // B - A (negative = shorter)
  effectChanges: { field: string; from: unknown; to: unknown }[];
  from: { id: string; name: string; durationSec: number };
  to: { id: string; name: string; durationSec: number };
}

/** Structured diff between two versions for the Compare view. */
export async function diffVersions(projectId: string, aId: string, bId: string): Promise<VersionDiff> {
  const [a, b] = await Promise.all([
    prisma.editVersion.findFirst({ where: { id: aId, projectId } }),
    prisma.editVersion.findFirst({ where: { id: bId, projectId } }),
  ]);
  if (!a || !b) throw new Error('version not found');

  const aSnap = a.timelineJson as unknown as TimelineSnapshot;
  const bSnap = b.timelineJson as unknown as TimelineSnapshot;
  const aKeys = new Set(keptKeys(aSnap.operations ?? []));
  const bKeys = new Set(keptKeys(bSnap.operations ?? []));

  const clipsAdded = [...bKeys].filter((k) => !aKeys.has(k));
  const clipsRemoved = [...aKeys].filter((k) => !bKeys.has(k));

  const effectChanges: VersionDiff['effectChanges'] = [];
  const ae = (aSnap.effects ?? {}) as unknown as Record<string, unknown>;
  const be = (bSnap.effects ?? {}) as unknown as Record<string, unknown>;
  for (const field of new Set([...Object.keys(ae), ...Object.keys(be)])) {
    if (ae[field] !== be[field]) effectChanges.push({ field, from: ae[field], to: be[field] });
  }

  const aDur = totalDuration(aSnap.operations ?? []);
  const bDur = totalDuration(bSnap.operations ?? []);

  return {
    clipsAdded,
    clipsRemoved,
    durationChangeSec: +(bDur - aDur).toFixed(1),
    effectChanges,
    from: { id: a.id, name: a.name, durationSec: +aDur.toFixed(1) },
    to: { id: b.id, name: b.name, durationSec: +bDur.toFixed(1) },
  };
}

/**
 * Restore an older version. This does NOT overwrite anything: it copies the old
 * snapshot into the working timeline AND appends a new version recording the
 * restore (parent = current head), so history stays append-only.
 */
export async function restoreVersion(projectId: string, versionId: string) {
  const target = await prisma.editVersion.findFirst({ where: { id: versionId, projectId } });
  if (!target) throw new Error('version not found');
  const snap = target.timelineJson as unknown as TimelineSnapshot;

  await prisma.editTimeline.update({
    where: { projectId },
    data: { operations: snap.operations as object, effects: snap.effects as object, approved: false },
  });

  return createVersion({
    projectId,
    name: `Restored: ${target.name}`,
    timeline: snap,
    aiExplanation: `Restored the timeline from version "${target.name}".`,
    changes: [{ action: 'kept', target: `version "${target.name}"`, reasons: ['User restored this version'] }],
  });
}
