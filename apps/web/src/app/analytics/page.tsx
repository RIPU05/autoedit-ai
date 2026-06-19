'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { analytics } from '@/lib/api';

const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-panel border border-edge rounded-lg p-4">
      <p className="font-mono text-[11px] uppercase tracking-wider text-white/40">{label}</p>
      <p className={`mt-1 text-2xl font-display ${accent ? 'text-accent' : ''}`}>{value}</p>
    </div>
  );
}

export default function AnalyticsPage() {
  const router = useRouter();
  const [data, setData] = useState<{ tracked: any; key: any } | null>(null);

  useEffect(() => {
    analytics.mine().then(setData).catch(() => router.push('/login'));
  }, []);

  if (!data) return <main className="p-8 text-white/50">Loading analytics…</main>;
  const { tracked, key } = data;

  return (
    <main className="max-w-5xl mx-auto px-6 py-8">
      <a href="/dashboard" className="text-sm text-white/40 hover:text-white">← Dashboard</a>
      <h1 className="font-display text-2xl mt-2 mb-6">Analytics</h1>

      <h2 className="font-display text-sm uppercase tracking-wider text-white/40 mb-3">North-star metrics</h2>
      <div className="grid sm:grid-cols-4 gap-3 mb-8">
        <Stat label="Time to first edit" value={ms(key.timeToFirstEditMs)} accent />
        <Stat label="Time to render" value={ms(key.timeToRenderMs)} accent />
        <Stat label="Render success rate" value={`${key.renderSuccessRate}%`} accent />
        <Stat label="Weekly active creators" value={String(key.weeklyActiveCreators)} accent />
      </div>

      <h2 className="font-display text-sm uppercase tracking-wider text-white/40 mb-3">Activity</h2>
      <div className="grid sm:grid-cols-4 gap-3">
        <Stat label="Uploads" value={String(tracked.uploadCount)} />
        <Stat label="Projects" value={String(tracked.projectsCreated)} />
        <Stat label="Successful renders" value={String(tracked.successfulRenders)} />
        <Stat label="Failed renders" value={String(tracked.failedRenders)} />
        <Stat label="Avg analysis time" value={ms(tracked.avgAnalysisTimeMs)} />
        <Stat label="Avg render time" value={ms(tracked.avgRenderTimeMs)} />
        <Stat label="Avg project length" value={`${tracked.avgProjectDurationSec}s`} />
        <Stat label="Prompt edits / project" value={String(tracked.promptEditsPerProject)} />
      </div>
    </main>
  );
}
