'use client';

import { useEffect, useMemo, useState } from 'react';
import { projects as api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { VisualTimeline } from '@/components/VisualTimeline';
import { VideoPreview } from '@/components/VideoPreview';

interface Op {
  index: number;
  start: number;
  end: number;
  label?: string;
  score?: number;
  keep?: boolean;
  zoom?: number;
}
interface Effects {
  subtitles: boolean;
  zooms: boolean;
  transitions: 'fade' | 'none';
  music: boolean;
}
type Format = 'reel' | 'short' | 'landscape';

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

export function TimelineEditor({
  projectId,
  duration,
  initialOps,
  initialEffects,
  silences,
  onRender,
  onVersionCreated,
}: {
  projectId: string;
  duration: number;
  initialOps: Op[];
  initialEffects: Effects;
  silences: { start: number; end: number }[];
  onRender: (renderId: string) => void;
  onVersionCreated?: () => void;
}) {
  const [ops, setOps] = useState<Op[]>(
    [...initialOps].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((o, i) => ({ ...o, index: i, keep: o.keep ?? true })),
  );
  const [effects, setEffects] = useState<Effects>(initialEffects);
  const [format, setFormat] = useState<Format>('reel');
  const [saving, setSaving] = useState<null | 'draft' | 'render'>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // prompt-based editing
  const [prompt, setPrompt] = useState('');
  const [thinking, setThinking] = useState(false);
  const [editNotes, setEditNotes] = useState<string | null>(null);
  const [editChanges, setEditChanges] = useState<{ action: string; target: string; reasons: string[] }[]>([]);

  // preview + visual timeline
  const [playhead, setPlayhead] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    api.sourceUrl(projectId).then((r) => setPreviewUrl(r.url)).catch(() => setPreviewUrl(null));
  }, [projectId]);

  // explainable AI: why is a clip kept/removed?
  const [explain, setExplain] = useState<{ index: number; loading: boolean; explanation?: string; reasons?: string[] } | null>(null);
  async function explainOp(o: Op) {
    setExplain({ index: o.index, loading: true });
    try {
      const r = await api.explainClip(projectId, o.start, o.end, o.keep !== false);
      setExplain({ index: o.index, loading: false, explanation: r.explanation, reasons: r.reasons });
    } catch (e: any) {
      setExplain({ index: o.index, loading: false, explanation: e.message, reasons: [] });
    }
  }

  async function runPromptEdit(instruction?: string) {
    const text = (instruction ?? prompt).trim();
    if (!text) return;
    setThinking(true);
    setEditNotes(null);
    setEditChanges([]);
    setMsg(null);
    try {
      const { timeline, reasoning, changes } = await api.promptEdit(projectId, text);
      const next: Op[] = (timeline.operations ?? [])
        .sort((a: Op, b: Op) => a.index - b.index)
        .map((o: Op, i: number) => ({ ...o, index: i, keep: o.keep ?? true }));
      setOps(next);
      if (timeline.effects) setEffects(timeline.effects);
      setEditNotes(reasoning);
      setEditChanges(changes ?? []);
      setPrompt('');
      onVersionCreated?.(); // refresh the version sidebar
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setThinking(false);
    }
  }

  // goal-based editing: the user picks an OUTCOME, Claude figures out the edit
  const GOALS: { label: string; instruction: string }[] = [
    { label: 'Go viral (TikTok)', instruction: 'Recut for maximum TikTok virality: keep only the strongest hook and punchiest moments, ruthless pacing, subtitles on, subtle zoom, under 30 seconds.' },
    { label: 'YouTube Shorts', instruction: 'Make a vertical YouTube Short under 60s: lead with the best hook, tight pacing, captions on.' },
    { label: 'Educational', instruction: 'Recut in an educational style: keep explanations intact and in logical order, trim only filler and long pauses, calm pacing, subtitles on, no music.' },
    { label: 'Podcast clip', instruction: 'Make a shareable podcast clip: keep the most quotable exchange, minimal trimming, speaker context preserved, subtitles on.' },
    { label: 'Documentary', instruction: 'Recut in a documentary style: preserve narrative flow and atmosphere, slower deliberate pacing, gentle zooms, light background music.' },
    { label: 'Sales video', instruction: 'Recut as a sales video: hook, problem, solution, call-to-action; cut tangents, energetic pacing, subtitles on.' },
    { label: 'LinkedIn pro', instruction: 'Recut for a professional LinkedIn audience: concise and credible, no gimmicks, one clear insight, subtitles on, no music.' },
  ];

  const keptOps = ops.filter((o) => o.keep);
  const outputDuration = useMemo(
    () => keptOps.reduce((sum, o) => sum + Math.max(0, o.end - o.start), 0),
    [keptOps],
  );

  function patchOp(index: number, patch: Partial<Op>) {
    setOps((prev) => prev.map((o) => (o.index === index ? { ...o, ...patch } : o)));
  }
  function move(index: number, dir: -1 | 1) {
    setOps((prev) => {
      const sorted = [...prev].sort((a, b) => a.index - b.index);
      const pos = sorted.findIndex((o) => o.index === index);
      const swap = pos + dir;
      if (swap < 0 || swap >= sorted.length) return prev;
      [sorted[pos], sorted[swap]] = [sorted[swap], sorted[pos]];
      return sorted.map((o, i) => ({ ...o, index: i }));
    });
  }
  function addSegment() {
    setOps((prev) => [
      ...prev,
      { index: prev.length, start: 0, end: Math.min(10, duration), label: 'New clip', keep: true, zoom: 1 },
    ]);
  }
  function removeSegment(index: number) {
    setOps((prev) => prev.filter((o) => o.index !== index).map((o, i) => ({ ...o, index: i })));
  }

  async function save(approve: boolean, thenRender: boolean) {
    setSaving(thenRender ? 'render' : 'draft');
    setMsg(null);
    try {
      await api.approveTimeline(projectId, { operations: ops, effects, approved: approve });
      if (thenRender) {
        const { renderId } = await api.render(projectId, format);
        onRender(renderId);
      } else {
        setMsg('Draft saved.');
      }
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* ── goal-based + prompt editing ──────────────────────────────────── */}
      <div className="rounded-lg border border-accent/30 bg-accent/5 p-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="font-display text-sm">Direct the edit</span>
          <span className="font-mono text-[10px] text-accent">AI DIRECTOR</span>
        </div>

        {/* pick an OUTCOME — Claude figures out the editing */}
        <p className="text-xs text-white/50 mb-1.5">What outcome do you want?</p>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {GOALS.map((g) => (
            <button
              key={g.label}
              onClick={() => runPromptEdit(g.instruction)}
              disabled={thinking}
              className="text-xs border border-edge rounded-full px-3 py-1 hover:border-accent hover:text-accent disabled:opacity-50"
            >
              {g.label}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') runPromptEdit();
            }}
            rows={2}
            placeholder='…or describe it: "Keep only the 3 funniest moments, cut the dead air, no music."'
            className="flex-1 resize-none bg-ink border border-edge rounded-md px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            onClick={() => runPromptEdit()}
            disabled={thinking || !prompt.trim()}
            className="self-stretch px-4 rounded-md bg-accent text-ink font-medium text-sm disabled:opacity-50"
          >
            {thinking ? 'Directing…' : 'Apply'}
          </button>
        </div>
        <p className="mt-1 font-mono text-[11px] text-white/30">
          Each edit is saved as a new version. ⌘/Ctrl + Enter to apply.
        </p>

        {editNotes && (
          <div className="mt-3 border-t border-accent/20 pt-3">
            <p className="text-sm text-signal">✓ {editNotes}</p>
            {editChanges.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {editChanges.map((c, i) => (
                  <li key={i} className="text-xs">
                    <span className="font-mono uppercase text-white/40">{c.action}</span>{' '}
                    <span className="text-white/80">{c.target}</span>
                    {c.reasons?.length > 0 && (
                      <ul className="list-disc list-inside text-white/50 ml-1">
                        {c.reasons.map((r, j) => (
                          <li key={j}>{r}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* ── preview + visual timeline ─────────────────────────────────────── */}
      <VideoPreview
        url={previewUrl}
        playhead={playhead}
        onTime={setPlayhead}
        segments={ops.map((o) => ({ start: o.start, end: o.end, keep: o.keep }))}
      />
      <div>
        <div className="flex justify-between text-xs text-white/40 font-mono mb-1">
          <span>playhead {fmtTime(playhead)}</span>
          <span>output ≈ {fmtTime(outputDuration)} · source {fmtTime(duration)}</span>
        </div>
        <VisualTimeline
          ops={ops}
          duration={duration}
          silences={silences}
          playhead={playhead}
          selectedIndex={selectedIndex}
          onChange={setOps}
          onSeek={setPlayhead}
          onSelect={setSelectedIndex}
        />
      </div>

      {/* ── segment list ──────────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-display text-sm uppercase tracking-wider text-white/40">Clips</h3>
          <button onClick={addSegment} className="text-xs text-accent hover:underline">
            + Add clip
          </button>
        </div>
        <div className="space-y-2">
          {ops
            .slice()
            .sort((a, b) => a.index - b.index)
            .map((o) => (
              <div key={o.index}>
              <div
                className={cn(
                  'grid grid-cols-[auto_1fr_auto] gap-3 items-center bg-panel border rounded-lg px-3 py-2',
                  o.keep ? 'border-edge' : 'border-edge/40 opacity-50',
                )}
              >
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={o.keep}
                    onChange={(e) => patchOp(o.index, { keep: e.target.checked })}
                    className="accent-accent"
                  />
                  <span className="font-mono text-xs text-white/50 w-5">{o.index + 1}</span>
                </label>

                <div className="min-w-0">
                  <p className="text-sm truncate">{o.label ?? 'Clip'}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <input
                      type="number"
                      step={0.1}
                      value={o.start}
                      onChange={(e) => patchOp(o.index, { start: Math.max(0, +e.target.value) })}
                      className="w-20 bg-ink border border-edge rounded px-2 py-1 text-xs font-mono"
                    />
                    <span className="text-white/30 text-xs">→</span>
                    <input
                      type="number"
                      step={0.1}
                      value={o.end}
                      onChange={(e) => patchOp(o.index, { end: Math.min(duration, +e.target.value) })}
                      className="w-20 bg-ink border border-edge rounded px-2 py-1 text-xs font-mono"
                    />
                    <span className="font-mono text-[11px] text-white/40">{fmtTime(Math.max(0, o.end - o.start))}</span>
                    <label className="flex items-center gap-1 text-[11px] text-white/50 ml-2">
                      <input
                        type="checkbox"
                        checked={(o.zoom ?? 1) > 1}
                        onChange={(e) => patchOp(o.index, { zoom: e.target.checked ? 1.08 : 1 })}
                        className="accent-accent"
                      />
                      zoom
                    </label>
                  </div>
                </div>

                <div className="flex flex-col gap-1 items-end">
                  <button onClick={() => move(o.index, -1)} className="text-white/40 hover:text-white text-xs">▲</button>
                  <button onClick={() => move(o.index, 1)} className="text-white/40 hover:text-white text-xs">▼</button>
                  <button onClick={() => removeSegment(o.index)} className="text-warn/70 hover:text-warn text-xs">✕</button>
                  <button onClick={() => explainOp(o)} className="text-accent/80 hover:text-accent text-[11px] mt-1">Why?</button>
                </div>
              </div>
              {explain?.index === o.index && (
                <div className="mt-1 ml-8 mr-2 text-xs bg-ink border border-accent/30 rounded-md p-2">
                  {explain.loading ? (
                    <span className="text-white/50">
                      Asking Claude why this is {o.keep === false ? 'removed' : 'kept'}…
                    </span>
                  ) : (
                    <>
                      <p className="text-white/80">{explain.explanation}</p>
                      {explain.reasons && explain.reasons.length > 0 && (
                        <ul className="list-disc list-inside text-white/50 mt-1">
                          {explain.reasons.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              )}
              </div>
            ))}
        </div>
      </div>

      {/* ── effects + output ──────────────────────────────────────────────── */}
      <div className="grid sm:grid-cols-2 gap-6">
        <div>
          <h3 className="font-display text-sm uppercase tracking-wider text-white/40 mb-2">Effects</h3>
          <div className="space-y-2 text-sm">
            <Toggle label="Burn-in subtitles" checked={effects.subtitles} onChange={(v) => setEffects({ ...effects, subtitles: v })} />
            <Toggle label="Ken-Burns zoom" checked={effects.zooms} onChange={(v) => setEffects({ ...effects, zooms: v })} />
            <Toggle
              label="Crossfade transitions"
              checked={effects.transitions === 'fade'}
              onChange={(v) => setEffects({ ...effects, transitions: v ? 'fade' : 'none' })}
            />
            <Toggle label="Background music" checked={effects.music} onChange={(v) => setEffects({ ...effects, music: v })} />
          </div>
        </div>

        <div>
          <h3 className="font-display text-sm uppercase tracking-wider text-white/40 mb-2">Output format</h3>
          <div className="flex gap-2">
            {(['reel', 'short', 'landscape'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFormat(f)}
                className={cn(
                  'flex-1 rounded-md py-2 text-sm capitalize border',
                  format === f ? 'bg-accent text-ink border-accent' : 'border-edge text-white/70 hover:border-accent/50',
                )}
              >
                {f}
                <span className="block font-mono text-[10px] opacity-70">
                  {f === 'landscape' ? '16:9' : '9:16'}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── actions ───────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 pt-2 border-t border-edge">
        <button
          onClick={() => save(false, false)}
          disabled={saving !== null}
          className="text-sm px-4 py-2 rounded-md border border-edge hover:border-accent/50 disabled:opacity-50"
        >
          {saving === 'draft' ? 'Saving…' : 'Save draft'}
        </button>
        <button
          onClick={() => save(true, true)}
          disabled={saving !== null || keptOps.length === 0}
          className="text-sm px-4 py-2 rounded-md bg-accent text-ink font-medium disabled:opacity-50"
        >
          {saving === 'render' ? 'Starting…' : `Approve & render ${format}`}
        </button>
        {keptOps.length === 0 && <span className="text-xs text-warn">Keep at least one clip.</span>}
        {msg && <span className="text-xs text-white/60">{msg}</span>}
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between bg-panel border border-edge rounded-md px-3 py-2 cursor-pointer">
      <span className="text-white/80">{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-accent" />
    </label>
  );
}
