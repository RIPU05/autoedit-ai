'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { creator } from '@/lib/api';

const FIELDS: { key: string; label: string; options: string[] }[] = [
  { key: 'pacingPreference', label: 'Pacing', options: ['slow', 'balanced', 'fast'] },
  { key: 'captionPreference', label: 'Captions', options: ['on', 'off', 'minimal'] },
  { key: 'musicPreference', label: 'Music', options: ['none', 'subtle', 'prominent'] },
  { key: 'hookPreference', label: 'Hook', options: ['strong', 'gentle'] },
  { key: 'platformPreference', label: 'Platform', options: ['shorts', 'youtube', 'tiktok', 'reels', 'linkedin'] },
  { key: 'editingStyle', label: 'Editing style', options: ['viral', 'educational', 'documentary', 'podcast', 'sales'] },
];

export default function SettingsPage() {
  const router = useRouter();
  const [profile, setProfile] = useState<Record<string, string> | null>(null);
  const [desc, setDesc] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    creator.profile().then((r) => { setProfile(r.profile); setDesc(r.description); }).catch(() => router.push('/login'));
  }, []);

  async function set(key: string, value: string) {
    setProfile((p) => (p ? { ...p, [key]: value } : p));
    const r = await creator.update({ [key]: value });
    setDesc('Updated.');
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
    setProfile(r.profile);
  }

  if (!profile) return <main className="p-8 text-white/50">Loading preferences...</main>;

  return (
    <main className="max-w-2xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between">
        <a href="/dashboard" className="text-sm text-white/40 hover:text-white">Dashboard</a>
        <a href="/settings/integrations" className="text-sm text-white/40 hover:text-white">Integrations</a>
      </div>
      <h1 className="font-display text-2xl mt-2">Creator preferences</h1>
      <p className="text-sm text-white/50 mt-1 mb-6">
        AutoEdit learns these from your edits automatically and applies them to every AI suggestion. You can override them here.
        {saved && <span className="text-signal ml-2">saved</span>}
      </p>

      <div className="space-y-4">
        {FIELDS.map((f) => (
          <div key={f.key}>
            <p className="text-sm text-white/60 mb-1.5">{f.label}</p>
            <div className="flex flex-wrap gap-2">
              {f.options.map((opt) => (
                <button
                  key={opt}
                  onClick={() => set(f.key, opt)}
                  className={`text-sm rounded-full px-3 py-1 border capitalize ${
                    profile[f.key] === opt ? 'border-accent bg-accent/10 text-accent' : 'border-edge text-white/70 hover:border-accent/40'
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
