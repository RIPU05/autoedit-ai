'use client';

import { useState } from 'react';
import { feedback } from '@/lib/api';

const QUESTIONS = [
  { key: 'savedTime', q: 'What saved the most time?' },
  { key: 'confusing', q: 'What was confusing?' },
  { key: 'wouldPay', q: 'What would make you pay?' },
  { key: 'magical', q: 'What feature felt magical?' },
] as const;

export function FeedbackModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [rating, setRating] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit() {
    if (rating === 0) return;
    setBusy(true);
    try {
      await feedback.submit({ projectId, rating, answers, category: 'post_export' });
      setDone(true);
      setTimeout(onClose, 1200);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-ink border border-edge rounded-xl p-6" onClick={(e) => e.stopPropagation()}>
        {done ? (
          <p className="text-center text-signal py-8">Thanks — your feedback shapes what we build next.</p>
        ) : (
          <>
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-display text-lg">Your export is ready 🎬</h3>
              <button onClick={onClose} className="text-white/40 hover:text-white text-xl leading-none">×</button>
            </div>
            <p className="text-sm text-white/50 mb-4">A few quick questions (optional) — takes 20 seconds.</p>

            <div className="flex items-center gap-1 mb-4">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} onClick={() => setRating(n)} className={`text-2xl ${n <= rating ? 'text-accent' : 'text-edge'}`}>
                  ★
                </button>
              ))}
            </div>

            <div className="space-y-3">
              {QUESTIONS.map(({ key, q }) => (
                <div key={key}>
                  <label className="text-xs text-white/50">{q}</label>
                  <input
                    value={answers[key] ?? ''}
                    onChange={(e) => setAnswers({ ...answers, [key]: e.target.value })}
                    className="w-full mt-1 bg-panel border border-edge rounded-md px-3 py-2 text-sm outline-none focus:border-accent"
                  />
                </div>
              ))}
            </div>

            <div className="mt-5 flex gap-2">
              <button onClick={onClose} className="text-sm px-4 py-2 rounded-md border border-edge">Skip</button>
              <button
                onClick={submit}
                disabled={busy || rating === 0}
                className="text-sm px-4 py-2 rounded-md bg-accent text-ink font-medium disabled:opacity-50"
              >
                {busy ? 'Sending…' : 'Send feedback'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
