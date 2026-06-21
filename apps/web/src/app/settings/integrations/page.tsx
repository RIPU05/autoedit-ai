'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { integrations } from '@/lib/api';

type StatusState = {
  status: string;
  metadata?: Record<string, unknown>;
  lastTestedAt?: string | null;
};

function Badge({ status }: { status: string }) {
  const label = status === 'CONNECTED' ? 'Connected' : status === 'ERROR' ? 'Error' : 'Disconnected';
  const cls =
    status === 'CONNECTED'
      ? 'border-signal/40 bg-signal/10 text-signal'
      : status === 'ERROR'
        ? 'border-warn/40 bg-warn/10 text-warn'
        : 'border-edge bg-white/5 text-white/60';
  return <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${cls}`}>{label}</span>;
}

function Field({
  label,
  type = 'text',
  value,
  onChange,
  placeholder,
}: {
  label: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-white/60">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-edge bg-black/20 px-3 py-2 text-sm text-white outline-none transition focus:border-accent"
      />
    </label>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
  tone = 'default',
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'danger';
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border px-3 py-2 text-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${
        tone === 'danger'
          ? 'border-warn/40 text-warn hover:bg-warn/10'
          : 'border-edge text-white/80 hover:border-accent/50 hover:bg-white/5'
      }`}
    >
      {children}
    </button>
  );
}

export default function IntegrationsPage() {
  const router = useRouter();
  const [claude, setClaude] = useState<StatusState>({ status: 'DISCONNECTED' });
  const [n8n, setN8n] = useState<StatusState>({ status: 'DISCONNECTED' });
  const [claudeKey, setClaudeKey] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [workflowName, setWorkflowName] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [claudeMessage, setClaudeMessage] = useState('');
  const [n8nMessage, setN8nMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const n8nMetadata = useMemo(() => n8n.metadata ?? {}, [n8n.metadata]);

  async function load() {
    try {
      const [claudeStatus, n8nStatus] = await Promise.all([integrations.claude.status(), integrations.n8n.status()]);
      setClaude(claudeStatus);
      setN8n(n8nStatus);
      setWebhookUrl(typeof n8nStatus.metadata?.webhookUrl === 'string' ? n8nStatus.metadata.webhookUrl : '');
      setWorkflowName(typeof n8nStatus.metadata?.workflowName === 'string' ? n8nStatus.metadata.workflowName : '');
      setSigningSecret('');
      setClaudeKey('');
    } catch {
      router.push('/login');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function run(action: string, fn: () => Promise<void>) {
    setBusy(action);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  async function connectClaude() {
    setClaudeMessage('');
    await run('claude-connect', async () => {
      try {
        const next = await integrations.claude.connect(claudeKey);
        setClaude(next);
        setClaudeKey('');
        setClaudeMessage('Claude connected.');
      } catch (err) {
        setClaudeMessage(err instanceof Error ? err.message : 'Claude connection failed.');
      }
    });
  }

  async function testClaude() {
    setClaudeMessage('');
    await run('claude-test', async () => {
      try {
        const next = await integrations.claude.test();
        setClaude(next);
        setClaudeMessage('Claude test passed.');
      } catch (err) {
        setClaudeMessage(err instanceof Error ? err.message : 'Claude test failed.');
      }
    });
  }

  async function disconnectClaude() {
    setClaudeMessage('');
    await run('claude-disconnect', async () => {
      await integrations.claude.disconnect();
      setClaude({ status: 'DISCONNECTED' });
      setClaudeKey('');
      setClaudeMessage('Claude disconnected.');
    });
  }

  async function connectN8n() {
    setN8nMessage('');
    await run('n8n-connect', async () => {
      try {
        const next = await integrations.n8n.connect({
          webhookUrl,
          workflowName: workflowName || undefined,
          signingSecret: signingSecret || undefined,
        });
        setN8n(next);
        setSigningSecret('');
        setN8nMessage('n8n connected.');
      } catch (err) {
        setN8nMessage(err instanceof Error ? err.message : 'n8n connection failed.');
      }
    });
  }

  async function testN8n() {
    setN8nMessage('');
    await run('n8n-test', async () => {
      try {
        const next = await integrations.n8n.test();
        setN8n(next);
        setN8nMessage('n8n test event sent.');
      } catch (err) {
        setN8nMessage(err instanceof Error ? err.message : 'n8n test failed.');
      }
    });
  }

  async function disconnectN8n() {
    setN8nMessage('');
    await run('n8n-disconnect', async () => {
      await integrations.n8n.disconnect();
      setN8n({ status: 'DISCONNECTED' });
      setSigningSecret('');
      setN8nMessage('n8n disconnected.');
    });
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <a href="/settings" className="text-sm text-white/40 hover:text-white">Preferences</a>
          <h1 className="mt-2 font-display text-2xl">Integrations</h1>
        </div>
        <a href="/dashboard" className="text-sm text-white/40 hover:text-white">Dashboard</a>
      </header>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-lg border border-edge bg-panel p-5">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-lg">Claude Connector</h2>
              <p className="mt-1 text-sm text-white/45">Optional cloud analysis key for this account.</p>
            </div>
            <Badge status={claude.status} />
          </div>

          <div className="space-y-4">
            <Field label="Anthropic API key" type="password" value={claudeKey} onChange={setClaudeKey} placeholder="Paste key to connect or replace" />
            <div className="flex flex-wrap gap-2">
              <ActionButton onClick={connectClaude} disabled={busy !== null || !claudeKey.trim()}>Connect</ActionButton>
              <ActionButton onClick={testClaude} disabled={busy !== null || claude.status !== 'CONNECTED'}>Test</ActionButton>
              <ActionButton onClick={disconnectClaude} disabled={busy !== null} tone="danger">Disconnect</ActionButton>
            </div>
            {claudeMessage && <p className="text-sm text-white/60">{claudeMessage}</p>}
          </div>
        </section>

        <section className="rounded-lg border border-edge bg-panel p-5">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-lg">n8n Connector</h2>
              <p className="mt-1 text-sm text-white/45">Send processing events to an n8n webhook.</p>
            </div>
            <Badge status={n8n.status} />
          </div>

          <div className="space-y-4">
            <Field label="Webhook URL" value={webhookUrl} onChange={setWebhookUrl} placeholder="http://localhost:5678/webhook/autoedit-events" />
            <Field label="Workflow name" value={workflowName} onChange={setWorkflowName} placeholder="AutoEdit events" />
            <Field
              label="Signing secret"
              type="password"
              value={signingSecret}
              onChange={setSigningSecret}
              placeholder={n8nMetadata.hasSigningSecret ? 'Secret saved. Enter a new value to replace.' : 'Optional'}
            />
            <div className="flex flex-wrap gap-2">
              <ActionButton onClick={connectN8n} disabled={busy !== null || !webhookUrl.trim()}>Connect</ActionButton>
              <ActionButton onClick={testN8n} disabled={busy !== null || n8n.status !== 'CONNECTED'}>Test</ActionButton>
              <ActionButton onClick={disconnectN8n} disabled={busy !== null} tone="danger">Disconnect</ActionButton>
            </div>
            {n8nMessage && <p className="text-sm text-white/60">{n8nMessage}</p>}
            {n8n.lastTestedAt && <p className="text-xs text-white/35">Last tested {new Date(n8n.lastTestedAt).toLocaleString()}</p>}
          </div>
        </section>
      </div>
    </main>
  );
}
