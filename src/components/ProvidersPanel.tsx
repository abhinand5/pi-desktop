import { useState } from "react";
import type { ReactNode } from "react";
import { Plus, Trash2, X, Zap } from "lucide-react";
import type { ProviderConfig, ProviderTestResult } from "../lib/bridge";
import { useAppStore } from "../lib/agent-store";

const API_TYPES = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "azure-openai-responses",
  "bedrock-converse-stream",
] as const;

/**
 * Provider onboarding: CRUD over the harness's NATIVE endpoint config
 * (pi `models.json`, omp `models.yml`). Secrets are written in the harness's
 * own value syntax (`$ENV`, `!command`, literal) and never leave the backend.
 */
export default function ProvidersPanel() {
  const open = useAppStore((s) => s.openPanel === "providers");
  const harness = useAppStore((s) => s.harness);
  const providers = useAppStore((s) => s.providers);
  const setPanel = useAppStore((s) => s.setPanel);
  const saveProvider = useAppStore((s) => s.saveProvider);
  const deleteProvider = useAppStore((s) => s.deleteProvider);
  const testProviderConnection = useAppStore((s) => s.testProviderConnection);

  const [editing, setEditing] = useState<string | null>(null); // null = list, id = edit, "" = new
  const [testResult, setTestResult] = useState<Record<string, ProviderTestResult | "testing">>({});

  if (!open) return null;

  const runTest = async (id: string, baseUrl: string) => {
    setTestResult((r) => ({ ...r, [id]: "testing" }));
    const result = await testProviderConnection(baseUrl, null);
    setTestResult((r) => ({ ...r, [id]: result }));
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={() => setPanel(null)}>
      <div
        className="flex h-full w-[420px] flex-col border-l border-line bg-ink-1"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className="eyebrow flex-1 font-mono text-[11px] tracking-wider text-ink-dim uppercase">
            endpoints · {harness}
          </span>
          <button
            onClick={() => setEditing("")}
            className="flex h-7 items-center gap-1 rounded-[7px] border border-line bg-ink-2 px-2 font-mono text-[11px] text-ink-dim hover:text-ink-text"
          >
            <Plus size={12} /> add
          </button>
          <button onClick={() => setPanel(null)} className="text-ink-faint hover:text-ink-text" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {editing === null ? (
            providers.length === 0 ? (
              <EmptyProviders onAdd={() => setEditing("")} />
            ) : (
              <div className="space-y-2">
                {providers.map((p) => {
                  const t = testResult[p.id];
                  return (
                    <div key={p.id} className="rounded-[8px] border border-line bg-ink-2 px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-text">
                          {p.name === p.id ? p.id : `${p.name} · ${p.id}`}
                        </span>
                        <button
                          onClick={() => setEditing(p.id)}
                          className="font-mono text-[10.5px] text-ink-faint hover:text-ink-text"
                        >
                          edit
                        </button>
                        <button
                          onClick={() => void deleteProvider(p.id)}
                          className="text-ink-faint hover:text-red"
                          aria-label={`Delete ${p.id}`}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[10.5px] text-ink-faint">{p.baseUrl}</div>
                      <div className="mt-1 flex items-center gap-2 font-mono text-[10px]">
                        <span className="rounded-full border border-line px-1.5 py-0.5 text-ink-dim">{p.api}</span>
                        <span className="text-ink-faint">{p.modelCount} models</span>
                        <span className={p.keyConfigured ? "text-green" : "text-ink-faint"}>
                          {p.keyConfigured ? "key set" : "no key"}
                        </span>
                        <button
                          onClick={() => void runTest(p.id, p.baseUrl)}
                          className="ml-auto flex items-center gap-1 text-teal hover:underline"
                        >
                          <Zap size={9} /> test
                        </button>
                      </div>
                      {t === "testing" ? (
                        <div className="mt-1 font-mono text-[10.5px] text-teal">testing…</div>
                      ) : t ? (
                        <div className={`mt-1 font-mono text-[10.5px] ${t.ok ? "text-green" : "text-red"}`}>
                          {t.ok ? `${t.modelCount ?? "?"} models reachable` : t.error}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                <p className="px-1 pt-2 text-[11px] leading-relaxed text-ink-faint">
                  Written to {harness === "pi" ? "~/.pi/agent/models.json" : "~/.omp/agent/models.yml"} — the
                  harness's own config, readable by the CLI too.
                </p>
              </div>
            )
          ) : (
            <ProviderForm
              harness={harness}
              editId={editing || null}
              existing={providers.find((p) => p.id === editing)}
              onCancel={() => setEditing(null)}
              onSave={async (id, config) => {
                await saveProvider(id, config);
                setEditing(null);
              }}
              onTest={(baseUrl, key) => testProviderConnection(baseUrl, key)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyProviders({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 pt-16 text-center">
      <p className="text-[13px] leading-relaxed text-ink-dim">
        Add a custom OpenAI-compatible endpoint — local llama.cpp, vLLM, a corporate gateway — and its models appear
        in the picker immediately.
      </p>
      <button onClick={onAdd} className="h-8 rounded-[8px] bg-amber px-4 font-mono text-[12px] text-on-accent">
        add endpoint
      </button>
    </div>
  );
}

function ProviderForm({
  harness,
  editId,
  existing,
  onCancel,
  onSave,
  onTest,
}: {
  harness: "pi" | "omp";
  editId: string | null;
  existing?: { name: string; baseUrl: string; api: string; keyConfigured: boolean };
  onCancel: () => void;
  onSave: (id: string, config: ProviderConfig) => Promise<void>;
  onTest: (baseUrl: string, key: string | null) => Promise<ProviderTestResult>;
}) {
  const [id, setId] = useState(editId ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
  const [api, setApi] = useState(existing?.api ?? "openai-completions");
  const [apiKey, setApiKey] = useState("");
  const [modelIds, setModelIds] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<ProviderTestResult | "testing" | null>(null);
  const [saving, setSaving] = useState(false);

  const parseModels = () =>
    modelIds
      .split(/[,\n]/)
      .map((m) => m.trim())
      .filter(Boolean)
      .map((mid) => ({ id: mid }));

  const runTest = async () => {
    if (!baseUrlValid(baseUrl)) {
      setError("Enter a valid http(s) baseUrl first.");
      return;
    }
    setError(null);
    setTest("testing");
    const result = await onTest(baseUrl, apiKey || null);
    setTest(result);
  };

  const submit = async () => {
    if (!idValid(id)) {
      setError("ID: letters, digits, '-' and '_' only.");
      return;
    }
    if (!baseUrlValid(baseUrl)) {
      setError("baseUrl must be an http(s) URL.");
      return;
    }
    const models = parseModels();
    if (models.length === 0) {
      setError("Add at least one model id (comma or newline separated).");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(id, {
        name: name || undefined,
        baseUrl,
        api,
        ...(apiKey ? { apiKey } : {}),
        models,
      });
    } catch (e) {
      setError(String(e));
      setSaving(false);
      return;
    }
    setSaving(false);
  };

  return (
    <div className="space-y-3 px-1">
      <Field label="id">
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          disabled={editId !== null}
          placeholder="my-gateway"
          className="w-full rounded-[7px] border border-line bg-ink-0 px-2.5 py-1.5 font-mono text-[12px] text-ink-text disabled:opacity-50"
        />
      </Field>
      <Field label="name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Display name"
          className="w-full rounded-[7px] border border-line bg-ink-0 px-2.5 py-1.5 text-[12.5px] text-ink-text"
        />
      </Field>
      <Field label="base url">
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://localhost:8000/v1"
          className="w-full rounded-[7px] border border-line bg-ink-0 px-2.5 py-1.5 font-mono text-[12px] text-ink-text"
        />
      </Field>
      <Field label="api">
        <select
          value={api}
          onChange={(e) => setApi(e.target.value)}
          className="w-full rounded-[7px] border border-line bg-ink-0 px-2.5 py-1.5 font-mono text-[12px] text-ink-text"
        >
          {API_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Field>
      <Field label="api key">
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={existing?.keyConfigured ? "configured — leave empty to keep" : "$ENV_VAR, !command or literal"}
          className="w-full rounded-[7px] border border-line bg-ink-0 px-2.5 py-1.5 font-mono text-[12px] text-ink-text"
        />
      </Field>
      <Field label="model ids">
        <textarea
          value={modelIds}
          onChange={(e) => setModelIds(e.target.value)}
          rows={2}
          placeholder={existing ? "leave empty to keep existing models" : "model-a, model-b"}
          className="w-full resize-none rounded-[7px] border border-line bg-ink-0 px-2.5 py-1.5 font-mono text-[12px] text-ink-text"
        />
      </Field>

      {error ? <div className="font-mono text-[11px] text-red">{error}</div> : null}
      {test === "testing" ? <div className="font-mono text-[11px] text-teal">testing endpoint…</div> : null}
      {test && test !== "testing" ? (
        <div className={`font-mono text-[11px] ${test.ok ? "text-green" : "text-red"}`}>
          {test.ok ? `reachable · ${test.modelCount ?? "?"} models` : test.error}
        </div>
      ) : null}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={() => void runTest()}
          className="h-7 rounded-[7px] border border-line bg-ink-2 px-3 font-mono text-[11px] text-teal"
        >
          test connection
        </button>
        <button onClick={onCancel} className="h-7 rounded-[7px] px-3 font-mono text-[11px] text-ink-faint hover:text-ink-dim">
          cancel
        </button>
        <button
          onClick={() => void submit()}
          disabled={saving}
          className="ml-auto h-7 rounded-[7px] bg-amber px-4 font-mono text-[11px] text-on-accent disabled:opacity-40"
        >
          {saving ? "saving…" : "save"}
        </button>
      </div>

      <p className="text-[11px] leading-relaxed text-ink-faint">
        {editId === null
          ? `Writes to ${harness === "pi" ? "~/.pi/agent/models.json" : "~/.omp/agent/models.yml"}. Keys follow the harness's native resolution: $ENV_VAR, !command, or a literal.`
          : "Editing an existing endpoint. Leaving the key empty keeps the stored one."}
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="eyebrow mb-1 block font-mono text-[10px] tracking-wider text-ink-faint uppercase">{label}</span>
      {children}
    </label>
  );
}

function idValid(id: string): boolean {
  return id.length > 0 && [...id].every((c) => /[a-zA-Z0-9\-_]/.test(c));
}

function baseUrlValid(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}
