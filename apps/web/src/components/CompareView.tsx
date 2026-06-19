'use client';

import { useEffect, useState } from 'react';
import { projects as api } from '@/lib/api';
import type { VersionDiff } from '@/lib/types';

export function CompareView({
  projectId,
  aId,
  bId,
  onClose,
}: {
  projectId: string;
  aId: string;
  bId: string;
  onClose: () => void;
}) {
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .compareVersions(projectId, aId, bId)
      .then((r) => setDiff(r.diff))
      .catch((e) => setError(e.message));
  }, [projectId, aId, bId]);

  const delta = diff?.durationChangeSec ?? 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl bg-ink border border-edge rounded-xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-lg">Compare versions</h3>
          <button onClick={onClose} className="text-white/40 hover:text-white text-xl leading-none">×</button>
        </div>

        {error && <p className="text-warn text-sm">{error}</p>}
        {!diff && !error && <p className="text-white/50 text-sm">Computing diff…</p>}

        {diff && (
          <>
            <div className="grid grid-cols-2 gap-3 mb-5">
              <div className="bg-panel border border-edge rounded-lg p-3">
                <p className="font-mono text-[11px] text-white/40">FROM</p>
                <p className="text-sm font-medium">{diff.from.name}</p>
                <p className="text-xs text-white/50">{diff.from.durationSec}s output</p>
              </div>
              <div className="bg-panel border border-accent/40 rounded-lg p-3">
                <p className="font-mono text-[11px] text-accent">TO</p>
                <p className="text-sm font-medium">{diff.to.name}</p>
                <p className="text-xs text-white/50">{diff.to.durationSec}s output</p>
              </div>
            </div>

            <div className="space-y-4 text-sm">
              <Row label="Duration change">
                <span className={delta < 0 ? 'text-signal' : delta > 0 ? 'text-warn' : 'text-white/60'}>
                  {delta > 0 ? '+' : ''}
                  {delta}s {delta < 0 ? '(shorter)' : delta > 0 ? '(longer)' : '(same)'}
                </span>
              </Row>

              <Row label={`Clips added (${diff.clipsAdded.length})`}>
                {diff.clipsAdded.length ? (
                  <div className="flex flex-wrap gap-1">
                    {diff.clipsAdded.map((c) => (
                      <span key={c} className="font-mono text-[11px] bg-signal/15 text-signal rounded px-1.5 py-0.5">
                        + {c}s
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-white/40">none</span>
                )}
              </Row>

              <Row label={`Clips removed (${diff.clipsRemoved.length})`}>
                {diff.clipsRemoved.length ? (
                  <div className="flex flex-wrap gap-1">
                    {diff.clipsRemoved.map((c) => (
                      <span key={c} className="font-mono text-[11px] bg-warn/15 text-warn rounded px-1.5 py-0.5">
                        − {c}s
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-white/40">none</span>
                )}
              </Row>

              <Row label="Strategy / effects">
                {diff.effectChanges.length ? (
                  <ul className="space-y-0.5">
                    {diff.effectChanges.map((e) => (
                      <li key={e.field} className="text-white/70">
                        <span className="font-mono text-[11px] text-white/40">{e.field}</span>{' '}
                        {String(e.from)} → <span className="text-white">{String(e.to)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-white/40">unchanged</span>
                )}
              </Row>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-3 items-start">
      <span className="text-white/40">{label}</span>
      <div>{children}</div>
    </div>
  );
}
