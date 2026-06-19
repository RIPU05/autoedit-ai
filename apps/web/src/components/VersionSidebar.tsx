'use client';

import { useEffect, useState } from 'react';
import { projects as api } from '@/lib/api';
import type { Version } from '@/lib/types';
import { cn } from '@/lib/utils';

export function VersionSidebar({
  projectId,
  refreshKey,
  onRestored,
  onCompare,
}: {
  projectId: string;
  refreshKey: number; // bump to force a reload after a prompt edit
  onRestored: () => void;
  onCompare: (aId: string, bId: string) => void;
}) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [headId, setHeadId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]); // for compare (max 2)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    const { versions, headId } = await api.versions(projectId);
    setVersions(versions);
    setHeadId(headId);
  }
  useEffect(() => {
    load();
  }, [projectId, refreshKey]);

  function toggleCompare(id: string) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      const next = [...prev, id];
      return next.slice(-2); // keep most recent two
    });
  }

  async function restore(id: string) {
    setBusy(true);
    try {
      await api.restoreVersion(projectId, id);
      await load();
      onRestored();
    } finally {
      setBusy(false);
    }
  }

  async function saveName(id: string) {
    if (draftName.trim()) await api.renameVersion(projectId, id, draftName.trim());
    setEditingId(null);
    await load();
  }

  const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <aside className="w-full">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-display text-sm uppercase tracking-wider text-white/40">Versions</h3>
        {selected.length === 2 && (
          <button onClick={() => onCompare(selected[0], selected[1])} className="text-xs text-accent hover:underline">
            Compare selected
          </button>
        )}
      </div>

      <ol className="space-y-2">
        {versions.map((v) => {
          const isHead = v.id === headId;
          const checked = selected.includes(v.id);
          return (
            <li
              key={v.id}
              className={cn(
                'rounded-lg border bg-panel p-3',
                isHead ? 'border-accent/60' : 'border-edge',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  {editingId === v.id ? (
                    <input
                      autoFocus
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      onBlur={() => saveName(v.id)}
                      onKeyDown={(e) => e.key === 'Enter' && saveName(v.id)}
                      className="w-full bg-ink border border-edge rounded px-2 py-1 text-sm"
                    />
                  ) : (
                    <p className="text-sm font-medium truncate flex items-center gap-2">
                      {v.name}
                      {isHead && <span className="font-mono text-[10px] text-accent">CURRENT</span>}
                    </p>
                  )}
                  {v.userPrompt && <p className="text-xs text-white/50 mt-0.5 truncate">“{v.userPrompt}”</p>}
                  <p className="font-mono text-[11px] text-white/30 mt-0.5">{fmt(v.createdAt)}</p>
                </div>
                <label className="shrink-0 flex items-center gap-1 text-[11px] text-white/40">
                  <input type="checkbox" checked={checked} onChange={() => toggleCompare(v.id)} className="accent-accent" />
                </label>
              </div>

              {v.aiExplanation && (
                <p className="mt-2 text-xs text-white/70 border-l-2 border-accent/40 pl-2">{v.aiExplanation}</p>
              )}

              {/* per-decision "why" — the explainable layer */}
              {v.changes?.length > 0 && (
                <details className="mt-2 group">
                  <summary className="text-xs text-accent cursor-pointer list-none">
                    {v.changes.length} decisions · why?
                  </summary>
                  <ul className="mt-1 space-y-1.5">
                    {v.changes.map((c, i) => (
                      <li key={i} className="text-[11px]">
                        <span className="font-mono uppercase text-white/40">{c.action}</span>{' '}
                        <span className="text-white/80">{c.target}</span>
                        <ul className="list-disc list-inside text-white/50 ml-1">
                          {c.reasons.map((r, j) => (
                            <li key={j}>{r}</li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <div className="mt-2 flex gap-3 text-[11px]">
                <button
                  onClick={() => {
                    setEditingId(v.id);
                    setDraftName(v.name);
                  }}
                  className="text-white/40 hover:text-white"
                >
                  Rename
                </button>
                {!isHead && (
                  <button onClick={() => restore(v.id)} disabled={busy} className="text-white/40 hover:text-white disabled:opacity-50">
                    Restore
                  </button>
                )}
              </div>
            </li>
          );
        })}
        {versions.length === 0 && <p className="text-sm text-white/40">No versions yet.</p>}
      </ol>
      <p className="mt-3 font-mono text-[11px] text-white/30">Tick two versions to compare them.</p>
    </aside>
  );
}
