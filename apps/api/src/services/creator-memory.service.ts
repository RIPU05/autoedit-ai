import { prisma } from '../lib/prisma.js';
import { log } from '../lib/logger.js';

export async function getOrCreateProfile(userId: string) {
  return prisma.creatorProfile.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
}

type Signals = Record<string, number>;

function bump(signals: Signals, key: string, by = 1): Signals {
  return { ...signals, [key]: (signals[key] ?? 0) + by };
}

/**
 * Learn from a natural-language prompt edit. Keyword rules nudge the profile
 * AND accumulate signals so repeated behaviour hardens a preference over time.
 */
export async function learnFromPromptEdit(userId: string, instruction: string) {
  const text = instruction.toLowerCase();
  const profile = await getOrCreateProfile(userId);
  let signals = (profile.signals as Signals) ?? {};
  const patch: Record<string, string> = {};

  const has = (...words: string[]) => words.some((w) => text.includes(w));

  if (has('remove pause', 'cut dead air', 'tighten', 'faster', 'punchy', 'snappy')) {
    signals = bump(signals, 'pacing_fast');
    patch.pacingPreference = 'fast';
  }
  if (has('slower', 'calm', 'relaxed', 'let it breathe')) {
    signals = bump(signals, 'pacing_slow');
    patch.pacingPreference = 'slow';
  }
  if (has('more zoom', 'add zoom', 'zoom in', 'punch in')) signals = bump(signals, 'zoom_more');
  if (has('less music', 'no music', 'remove music', 'mute music')) {
    signals = bump(signals, 'music_less');
    patch.musicPreference = 'none';
  }
  if (has('more music', 'add music', 'background track')) {
    signals = bump(signals, 'music_more');
    patch.musicPreference = 'prominent';
  }
  if (has('no captions', 'subtitles off', 'remove captions')) {
    signals = bump(signals, 'caption_off');
    patch.captionPreference = 'off';
  }
  if (has('captions', 'subtitles', 'add captions')) {
    signals = bump(signals, 'caption_on');
    patch.captionPreference = 'on';
  }
  for (const [kw, val] of [
    ['tiktok', 'tiktok'],
    ['youtube', 'youtube'],
    ['shorts', 'shorts'],
    ['reel', 'reels'],
    ['linkedin', 'linkedin'],
  ] as const) {
    if (text.includes(kw)) patch.platformPreference = val;
  }
  for (const [kw, val] of [
    ['educational', 'educational'],
    ['documentary', 'documentary'],
    ['podcast', 'podcast'],
    ['sales', 'sales'],
    ['viral', 'viral'],
  ] as const) {
    if (text.includes(kw)) patch.editingStyle = val;
  }

  await prisma.creatorProfile.update({ where: { userId }, data: { ...patch, signals } });
  log.info('creator.learn.prompt', { userId, patch });
}

/**
 * Learn from a completed project: read the final approved timeline/effects and
 * nudge durable preferences toward what the creator actually shipped.
 */
export async function learnFromProject(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { timeline: true, user: true },
  });
  if (!project?.timeline) return;
  const fx = project.timeline.effects as any;
  const patch: Record<string, string> = {};
  if (fx?.music === false) patch.musicPreference = 'none';
  if (fx?.music === true) patch.musicPreference = 'subtle';
  if (fx?.subtitles === false) patch.captionPreference = 'off';
  if (fx?.subtitles === true) patch.captionPreference = 'on';

  const ops = (project.timeline.operations as any[]) ?? [];
  const kept = ops.filter((o) => o.keep !== false);
  const avgLen = kept.length ? kept.reduce((s, o) => s + (o.end - o.start), 0) / kept.length : 0;
  if (avgLen > 0 && avgLen < 6) patch.pacingPreference = 'fast';
  else if (avgLen > 20) patch.pacingPreference = 'slow';

  await prisma.creatorProfile
    .upsert({ where: { userId: project.userId }, create: { userId: project.userId, ...patch }, update: patch })
    .catch(() => {});
  log.info('creator.learn.project', { projectId, patch });
}

/** A compact string injected into AI prompts so edits respect creator taste. */
export async function buildPromptInjection(userId: string): Promise<string> {
  const p = await getOrCreateProfile(userId);
  return [
    'CREATOR PREFERENCES (honor unless the instruction overrides them):',
    `- pacing: ${p.pacingPreference}`,
    `- captions: ${p.captionPreference}`,
    `- music: ${p.musicPreference}`,
    `- hook: ${p.hookPreference}`,
    `- preferred platform: ${p.platformPreference}`,
    `- editing style: ${p.editingStyle}`,
  ].join('\n');
}

export async function summary(userId: string) {
  const p = await getOrCreateProfile(userId);
  return {
    profile: p,
    learnedSignals: p.signals,
    description: `Prefers ${p.pacingPreference} pacing, ${p.captionPreference} captions, ${p.musicPreference} music, ${p.editingStyle} style for ${p.platformPreference}.`,
  };
}
