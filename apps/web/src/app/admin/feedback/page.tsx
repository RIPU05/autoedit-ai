'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { feedback } from '@/lib/api';

export default function AdminFeedbackPage() {
  const router = useRouter();
  const [data, setData] = useState<{ items: any[]; count: number; avgRating: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    feedback.admin().then(setData).catch((e) => setError(e.message));
  }, []);

  if (error) return <main className="p-8 text-warn text-sm">Access denied — admin only. ({error})</main>;
  if (!data) return <main className="p-8 text-white/50">Loading feedback…</main>;

  return (
    <main className="max-w-4xl mx-auto px-6 py-8">
      <a href="/dashboard" className="text-sm text-white/40 hover:text-white">← Dashboard</a>
      <h1 className="font-display text-2xl mt-2">Feedback review</h1>
      <p className="text-sm text-white/50 mt-1 mb-6">
        {data.count} responses · avg rating {data.avgRating.toFixed(2)} / 5
      </p>

      <div className="space-y-3">
        {data.items.map((f) => (
          <div key={f.id} className="bg-panel border border-edge rounded-lg p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm">{f.user?.name ?? f.user?.email ?? 'creator'}</span>
              <span className="text-accent font-mono text-sm">{'★'.repeat(f.rating)}{'☆'.repeat(5 - f.rating)}</span>
            </div>
            {f.comment && <p className="text-sm text-white/80 mt-2">{f.comment}</p>}
            {f.answers && (
              <dl className="mt-2 grid sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
                {f.answers.savedTime && (<div><dt className="text-white/40">Saved most time</dt><dd className="text-white/80">{f.answers.savedTime}</dd></div>)}
                {f.answers.confusing && (<div><dt className="text-white/40">Confusing</dt><dd className="text-white/80">{f.answers.confusing}</dd></div>)}
                {f.answers.wouldPay && (<div><dt className="text-white/40">Would pay for</dt><dd className="text-white/80">{f.answers.wouldPay}</dd></div>)}
                {f.answers.magical && (<div><dt className="text-white/40">Felt magical</dt><dd className="text-white/80">{f.answers.magical}</dd></div>)}
              </dl>
            )}
            <p className="font-mono text-[11px] text-white/30 mt-2">{new Date(f.createdAt).toLocaleString()}</p>
          </div>
        ))}
        {data.items.length === 0 && <p className="text-sm text-white/40">No feedback yet.</p>}
      </div>
    </main>
  );
}
