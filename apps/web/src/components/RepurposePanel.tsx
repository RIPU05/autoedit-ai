'use client';

import { useState } from 'react';
import { projects as api } from '@/lib/api';
import { cn } from '@/lib/utils';

const PLATFORMS = [
  { id: 'youtube', label: 'YouTube', spec: '16:9 · full' },
  { id: 'shorts', label: 'YT Shorts', spec: '9:16 · ≤60s' },
  { id: 'tiktok', label: 'TikTok', spec: '9:16 · ≤60s' },
  { id: 'reels', label: 'IG Reels', spec: '9:16 · ≤90s' },
  { id: 'linkedin', label: 'LinkedIn', spec: '16:9 · pro' },
  { id: 'x', label: 'X / Twitter', spec: '16:9 · clip' },
];

export function RepurposePanel({ projectId, onQueued }: { projectId: string; onQueued: () => void }) {
  const [selected, setSelected] = useState<string[]>(['shorts', 'tiktok', 'reels']);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ platform: string; caption: string }[] | null>(null);

  function toggle(id: string) {
    setSelected((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  async function go() {
    if (selected.length === 0) return;
    setBusy(true);
    try {
      const { renders } = await api.repurpose(projectId, selected);
      setResult(renders.map((r) => ({ platform: r.platform, caption: r.caption })));
      onQueued();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-edge bg-panel p-4">
      <h3 className="font-display text-sm mb-1">One-click repurposing</h3>
      <p className="text-xs text-white/50 mb-3">Render the current cut for every platform at once, each with tailored copy.</p>

      <div className="flex flex-wrap gap-2 mb-3">
        {PLATFORMS.map((p) => (
          <button
            key={p.id}
            onClick={() => toggle(p.id)}
            className={cn(
              'rounded-lg border px-3 py-2 text-left',
              selected.includes(p.id) ? 'border-accent bg-accent/10' : 'border-edge hover:border-accent/40',
            )}
          >
            <span className="block text-sm">{p.label}</span>
            <span className="block font-mono text-[10px] text-white/40">{p.spec}</span>
          </button>
        ))}
      </div>

      <button
        onClick={go}
        disabled={busy || selected.length === 0}
        className="bg-accent text-ink font-medium rounded-md px-4 py-2 text-sm disabled:opacity-50"
      >
        {busy ? 'Queuing…' : `Generate ${selected.length} version${selected.length === 1 ? '' : 's'}`}
      </button>

      {result && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-signal">✓ {result.length} renders queued — they’ll appear under Renders as they finish.</p>
          {result.map((r) => (
            <div key={r.platform} className="text-xs bg-ink border border-edge rounded p-2">
              <span className="font-mono text-[10px] text-accent uppercase">{r.platform}</span>
              {r.caption && <p className="text-white/70 mt-0.5">{r.caption}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
