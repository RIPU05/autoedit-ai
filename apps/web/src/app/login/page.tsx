'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { auth } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await auth.login(email, password);
      else await auth.register(email, password, name);
      router.push('/dashboard');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen grid lg:grid-cols-2">
      {/* signature panel: a "timeline" motif built from the brand */}
      <aside className="hidden lg:flex flex-col justify-between p-12 bg-panel border-r border-edge">
        <span className="font-display text-lg tracking-tight">AutoEdit<span className="text-accent">.AI</span></span>
        <div>
          <h1 className="font-display text-4xl leading-tight">
            Upload once.<br />Ship a week of clips.
          </h1>
          <p className="mt-4 text-sm text-white/60 max-w-sm">
            Claude finds the highlights, cuts the dead air, writes the captions and the copy.
            FFmpeg renders the reels. n8n publishes them.
          </p>
          {/* faux timeline strip — the page's one memorable device */}
          <div className="mt-10 flex gap-[3px] h-12">
            {Array.from({ length: 48 }).map((_, i) => (
              <div
                key={i}
                className="flex-1 rounded-sm"
                style={{
                  background: [9, 10, 11, 27, 28].includes(i % 16) ? '#262a35' : '#5b8cff',
                  opacity: [9, 10, 11, 27, 28].includes(i % 16) ? 0.4 : 0.85,
                }}
                title={[9, 10, 11, 27, 28].includes(i % 16) ? 'silence — trimmed' : 'kept'}
              />
            ))}
          </div>
          <p className="mt-2 font-mono text-[11px] text-white/40">blue = kept · grey = silence auto-trimmed</p>
        </div>
        <p className="font-mono text-[11px] text-white/30">v0.1 · scaffold</p>
      </aside>

      <section className="flex items-center justify-center p-8">
        <div className="w-full max-w-sm">
          <h2 className="font-display text-2xl">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
          <p className="text-sm text-white/50 mt-1">
            {mode === 'login' ? 'Sign in to your projects.' : 'Start editing in minutes.'}
          </p>

          <div className="mt-6 space-y-3">
            {mode === 'register' && (
              <input
                className="w-full bg-panel border border-edge rounded-md px-3 py-2 text-sm outline-none focus:border-accent"
                placeholder="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
            <input
              className="w-full bg-panel border border-edge rounded-md px-3 py-2 text-sm outline-none focus:border-accent"
              placeholder="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <input
              className="w-full bg-panel border border-edge rounded-md px-3 py-2 text-sm outline-none focus:border-accent"
              placeholder="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <p className="text-sm text-warn">{error}</p>}
            <button
              onClick={submit}
              disabled={busy}
              className="w-full bg-accent text-ink font-medium rounded-md py-2 text-sm disabled:opacity-50"
            >
              {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </div>

          <div className="my-4 flex items-center gap-3 text-white/30 text-xs">
            <span className="h-px flex-1 bg-edge" /> or <span className="h-px flex-1 bg-edge" />
          </div>

          <a
            href={auth.googleUrl()}
            className="block text-center w-full border border-edge rounded-md py-2 text-sm hover:border-accent"
          >
            Continue with Google
          </a>

          <button
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
            className="mt-6 text-sm text-white/50 hover:text-white"
          >
            {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in'}
          </button>
        </div>
      </section>
    </main>
  );
}
