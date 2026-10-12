import { CheckCircle2, CircleDashed, ExternalLink, KeyRound, Loader2, RefreshCw, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { deleteCredential, saveApiKey } from "../ai/credentials/credentialStore";
import { AIError } from "../ai/errors";
import { mergeModels } from "../ai/models/modelConfig";
import { PROVIDER_LABELS, PROVIDERS } from "../ai/providers/registry";
import { aiService } from "../ai/service";
import { PROVIDER_IDS, type ProviderId } from "../ai/types";
import { ProviderSelect } from "../components/ProviderSelect";
import { closeSettings, useUI, type SettingsTab } from "../components/uiStore";
import { detectCompilers, type DetectedTool } from "../latex/compiler/compileApi";
import { errorMessage, openExternal } from "../lib/backend";
import { refreshAllConnections, refreshConnection, setConnection, useConnections } from "./connectionStore";
import { useSettings, type CompilerSetting, type ThemeSetting } from "./settingsStore";

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="grid grid-cols-[150px_1fr] items-start gap-3 py-1.5">
      <div className="pt-1 text-[12.5px] text-slate-600 dark:text-slate-300">{label}</div>
      <div>
        {children}
        {hint && <div className="mt-1 text-[11.5px] text-slate-400">{hint}</div>}
      </div>
    </div>
  );
}

async function testConnection(provider: ProviderId) {
  setConnection(provider, { loading: true, testError: undefined });
  try {
    const models = await aiService.listModels(provider);
    const ai = useSettings.getState().ai;
    useSettings.getState().updateAI({ fetchedModels: { ...ai.fetchedModels, [provider]: models } });
    setConnection(provider, { loading: false, verified: true });
  } catch (err) {
    const message = err instanceof AIError ? err.message : errorMessage(err);
    setConnection(provider, { loading: false, verified: false, testError: message });
  }
}

function ProviderCard({ provider }: { provider: ProviderId }) {
  const connection = useConnections((s) => s[provider]);
  const selectedModel = useSettings((s) => s.ai.models[provider]);
  const fetched = useSettings((s) => s.ai.fetchedModels[provider]);
  const custom = useSettings((s) => s.ai.customModels[provider]);
  const [key, setKey] = useState("");
  const [customId, setCustomId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const adapter = PROVIDERS[provider];
  const method = adapter.authMethods[0];
  const status = connection.status;
  const connected = Boolean(status?.stored);
  const models = mergeModels(provider, fetched, custom);

  const connect = async () => {
    const secret = key.trim();
    if (!secret) return;
    setBusy(true);
    setError(null);
    setKey(""); // do not keep the secret in UI state
    try {
      await saveApiKey(provider, secret);
      await refreshConnection(provider);
      await testConnection(provider);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteCredential(provider);
      setConnection(provider, { verified: undefined, testError: undefined });
      await refreshConnection(provider);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const addCustom = () => {
    const id = customId.trim();
    if (!id) return;
    const ai = useSettings.getState().ai;
    useSettings.getState().updateAI({
      customModels: { ...ai.customModels, [provider]: [...new Set([...ai.customModels[provider], id])] },
      models: { ...ai.models, [provider]: id },
    });
    setCustomId("");
  };

  let badge: React.ReactNode;
  if (connection.loading || busy) badge = <span className="flex items-center gap-1 text-slate-500"><Loader2 size={13} className="animate-spin" /> Checking…</span>;
  else if (status && !status.storeAvailable) badge = <span className="flex items-center gap-1 text-red-600"><XCircle size={13} /> Secure storage unavailable</span>;
  else if (connected && connection.verified === false) badge = <span className="flex items-center gap-1 text-red-600"><XCircle size={13} /> Connection failed</span>;
  else if (connected) badge = <span className="flex items-center gap-1 text-emerald-600" data-testid={`status-${provider}`}><CheckCircle2 size={13} /> Connected</span>;
  else badge = <span className="flex items-center gap-1 text-slate-500" data-testid={`status-${provider}`}><CircleDashed size={13} /> Not connected</span>;

  return (
    <section className="rounded-lg border border-slate-200 p-3 dark:border-slate-700" data-testid={`provider-${provider}`}>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-[13.5px] font-semibold">{provider === "anthropic" ? "Claude / Anthropic" : "OpenAI"}</h3>
        <div className="ml-auto text-[12px]">{badge}</div>
      </div>
      <Row label="Authentication">
        <div className="flex items-center gap-2 text-[12.5px]">
          <KeyRound size={13} className="text-slate-400" />
          <span>● {method.label}</span>
          <button className="ml-1 inline-flex items-center gap-0.5 text-sky-600 hover:underline" onClick={() => void openExternal(method.helpUrl)}>
            Get a key <ExternalLink size={11} />
          </button>
        </div>
        {connected ? (
          <div className="mt-2 flex items-center gap-2">
            <span className="font-mono text-[12px] text-slate-500">Stored key {status?.hint}</span>
            <button className="btn" onClick={() => void testConnection(provider)} disabled={busy || connection.loading}>
              Test connection
            </button>
            <button className="btn-danger" onClick={() => void disconnect()} disabled={busy} data-testid={`disconnect-${provider}`}>
              Disconnect
            </button>
          </div>
        ) : (
          <form
            className="mt-2 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void connect();
            }}
          >
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="input flex-1 font-mono"
              placeholder={method.placeholder}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              data-testid={`key-${provider}`}
            />
            <button type="submit" className="btn-primary" disabled={!key.trim() || busy} data-testid={`connect-${provider}`}>
              Connect
            </button>
          </form>
        )}
        {connection.testError && <div className="mt-1.5 text-[12px] text-red-600">{connection.testError}</div>}
        {status?.error && <div className="mt-1.5 text-[12px] text-red-600">{status.error}</div>}
        {error && <div className="mt-1.5 text-[12px] text-red-600">{error}</div>}
        <div className="mt-1.5 text-[11.5px] text-slate-400">
          The key is stored in your OS credential store (Keychain, Credential Manager or Secret Service) and is never written to disk by LOGICA.
        </div>
      </Row>
      <Row label="Model">
        <div className="flex items-center gap-2">
          <select
            className="select max-w-[300px] flex-1"
            value={selectedModel}
            onChange={(e) => {
              const ai = useSettings.getState().ai;
              useSettings.getState().updateAI({ models: { ...ai.models, [provider]: e.target.value } });
            }}
            data-testid={`model-${provider}`}
          >
            {!models.some((m) => m.id === selectedModel) && <option value={selectedModel}>{selectedModel}</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
                {m.displayName !== m.id ? ` (${m.id})` : ""}
              </option>
            ))}
          </select>
          <button className="btn" title="Load the models available to your account" disabled={!connected || connection.loading} onClick={() => void testConnection(provider)}>
            <RefreshCw size={12} /> Refresh list
          </button>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input className="input max-w-[300px] flex-1 font-mono" placeholder="Other model id" value={customId} onChange={(e) => setCustomId(e.target.value)} />
          <button className="btn" onClick={addCustom} disabled={!customId.trim()}>
            Add
          </button>
        </div>
      </Row>
    </section>
  );
}

function AISettings() {
  const defaultProvider = useSettings((s) => s.ai.defaultProvider);
  useEffect(() => {
    void refreshAllConnections();
  }, []);
  return (
    <div className="space-y-3">
      <Row label="Default provider" hint="Used for inline edits and chat unless you switch it for a request.">
        <ProviderSelect value={defaultProvider} onChange={(p) => useSettings.getState().updateAI({ defaultProvider: p })} />
      </Row>
      {PROVIDER_IDS.map((p) => (
        <ProviderCard key={p} provider={p} />
      ))}
      <p className="text-[11.5px] text-slate-400">
        LOGICA connects only through the official {PROVIDER_LABELS.openai} and Anthropic APIs. Browser sessions or cookies from ChatGPT or Claude.ai are never used.
      </p>
    </div>
  );
}

function EditorSettingsPanel() {
  const editor = useSettings((s) => s.editor);
  const update = useSettings.getState().updateEditor;
  return (
    <div>
      <Row label="Theme">
        <select className="select" value={editor.theme} onChange={(e) => update({ theme: e.target.value as ThemeSetting })}>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </Row>
      <Row label="Font">
        <input className="input w-full font-mono" value={editor.fontFamily} onChange={(e) => update({ fontFamily: e.target.value })} />
      </Row>
      <Row label="Font size">
        <input
          type="number"
          min={10}
          max={28}
          className="input w-20"
          value={editor.fontSize}
          onChange={(e) => update({ fontSize: Math.max(10, Math.min(28, Number(e.target.value) || 14)) })}
        />
      </Row>
      <Row label="Tab size">
        <select className="select" value={editor.tabSize} onChange={(e) => update({ tabSize: Number(e.target.value) })}>
          {[2, 4, 8].map((n) => (
            <option key={n} value={n}>
              {n} spaces
            </option>
          ))}
        </select>
      </Row>
      <Row label="Word wrap">
        <label className="flex items-center gap-2 pt-1 text-[12.5px]">
          <input type="checkbox" checked={editor.wordWrap} onChange={(e) => update({ wordWrap: e.target.checked })} />
          Wrap long lines
        </label>
      </Row>
    </div>
  );
}

function LatexSettingsPanel() {
  const latex = useSettings((s) => s.latex);
  const update = useSettings.getState().updateLatex;
  const [tools, setTools] = useState<DetectedTool[] | null>(null);
  useEffect(() => {
    detectCompilers()
      .then(setTools)
      .catch(() => setTools([]));
  }, []);
  return (
    <div>
      <Row label="Compiler" hint="Auto uses the first available of latexmk, pdflatex, xelatex.">
        <select className="select" value={latex.compiler} onChange={(e) => update({ compiler: e.target.value as CompilerSetting })}>
          <option value="auto">Auto</option>
          <option value="latexmk">latexmk</option>
          <option value="pdflatex">pdflatex</option>
          <option value="xelatex">xelatex</option>
          <option value="custom">Custom command</option>
        </select>
        <div className="mt-1.5 text-[11.5px] text-slate-500">
          {tools === null
            ? "Detecting installed tools…"
            : tools.length === 0
              ? "No LaTeX tools found on PATH. Install TeX Live, MacTeX or MiKTeX."
              : `Found: ${tools.map((t) => t.name).join(", ")}`}
        </div>
      </Row>
      {latex.compiler !== "custom" && latex.compiler !== "auto" && (
        <Row label="Compiler path" hint="Leave empty to find it on PATH.">
          <input className="input w-full font-mono" placeholder={`/path/to/${latex.compiler}`} value={latex.compilerPath} onChange={(e) => update({ compilerPath: e.target.value })} />
        </Row>
      )}
      {latex.compiler === "custom" && (
        <Row label="Compile command" hint="Runs in the main file's folder. {main} = main file name, {name} = name without .tex. The PDF must be {name}.pdf.">
          <input className="input w-full font-mono" value={latex.customCommand} onChange={(e) => update({ customCommand: e.target.value })} />
        </Row>
      )}
      <Row label="Auto compile">
        <label className="flex items-center gap-2 pt-1 text-[12.5px]">
          <input type="checkbox" checked={latex.autoCompile} onChange={(e) => update({ autoCompile: e.target.checked })} />
          Compile after saving
        </label>
      </Row>
      <Row label="Timeout">
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={10}
            max={1800}
            className="input w-24"
            value={latex.timeoutSecs}
            onChange={(e) => update({ timeoutSecs: Math.max(10, Math.min(1800, Number(e.target.value) || 120)) })}
          />
          <span className="text-[12px] text-slate-500">seconds</span>
        </div>
      </Row>
    </div>
  );
}

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "ai", label: "AI" },
  { id: "editor", label: "Editor" },
  { id: "latex", label: "LaTeX" },
];

export function SettingsDialog() {
  const open = useUI((s) => s.settingsOpen);
  const tab = useUI((s) => s.settingsTab);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeSettings();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-6" onMouseDown={(e) => e.target === e.currentTarget && closeSettings()}>
      <div className="flex max-h-full w-[760px] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-[#151c26]" data-testid="settings-dialog">
        <div className="flex items-center border-b border-slate-200 px-4 py-2.5 dark:border-slate-700">
          <h2 className="text-[14px] font-semibold">Settings</h2>
          <div className="ml-6 flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`rounded-md px-2.5 py-1 text-[12.5px] ${tab === t.id ? "bg-slate-100 font-medium dark:bg-slate-700" : "text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800"}`}
                onClick={() => useUI.setState({ settingsTab: t.id })}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button className="icon-btn ml-auto" onClick={closeSettings} title="Close (Esc)">
            <X size={15} />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto p-4">
          {tab === "ai" && <AISettings />}
          {tab === "editor" && <EditorSettingsPanel />}
          {tab === "latex" && <LatexSettingsPanel />}
        </div>
      </div>
    </div>
  );
}
