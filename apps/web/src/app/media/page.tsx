'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { auth, projects as projectsApi } from '@/lib/api';
import { Uploader } from '@/components/Uploader';
import { UniversalMediaWorkspace } from '@/components/UniversalMediaWorkspace';

export default function MediaWorkspacePage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [list, setList] = useState<any[]>([]);
  const uploaderRef = useRef<HTMLDivElement>(null);

  async function load() {
    try {
      const p = await projectsApi.list();
      setList(p.projects ?? []);
      setReady(true);
    } catch {
      const nextPath =
        typeof window !== 'undefined'
          ? `${window.location.pathname}${window.location.search}`
          : '/media';
      router.push(`/login?next=${encodeURIComponent(nextPath)}`);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (!ready) {
    return (
      <main className="min-h-screen max-w-5xl mx-auto px-4 sm:px-6 py-16 text-center text-white/50">
        <div className="inline-block animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full mb-3" />
        <p className="font-mono text-sm">Loading Media Hub…</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <a href="/dashboard" className="font-display text-lg">
            AutoEdit<span className="text-accent">.AI</span>
          </a>
          <span className="text-white/25">/</span>
          <span className="text-sm text-white/75">Media Hub</span>
        </div>
        <nav className="flex flex-wrap items-center gap-4 text-sm">
          <a href="/dashboard" className="text-white/50 hover:text-white">Dashboard</a>
          <a href="/settings" className="text-white/50 hover:text-white">Preferences</a>
          <button
            onClick={async () => {
              await auth.logout();
              router.push('/login');
            }}
            className="text-white/50 hover:text-white"
          >
            Sign out
          </button>
        </nav>
      </header>

      <UniversalMediaWorkspace
        uploadedProjects={list}
        onRequestNewUpload={() => {
          uploaderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }}
      />

      <section ref={uploaderRef} className="space-y-2">
        <h2 className="font-display text-sm uppercase tracking-wider text-white/40">
          Direct Video Upload
        </h2>
        <Uploader onDone={(id) => router.push(`/projects/${id}`)} />
      </section>
    </main>
  );
}
