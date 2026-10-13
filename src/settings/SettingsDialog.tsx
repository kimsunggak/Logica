import { CheckCircle2, CircleDashed, ExternalLink, KeyRound, Loader2, RefreshCw, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import {
  cancelChatGPTSignIn,
  deleteCredential,
  saveApiKey,
  signInWithChatGPT,
  signOutOfChatGPT,
} from "../ai/credentials/credentialStore";
import { AIError } from "../ai/errors";
import { mergeModels } from "../ai/models/modelConfig";
import { CHATGPT_USAGE_URL } from "../ai/providers/openai/openaiProvider";
import { PROVIDERS } from "../ai/providers/registry";
import { aiService } from "../ai/service";
import { PROVIDER_IDS, type AuthMethodKind, type ProviderId } from "../ai/types";
import { ProviderSelect } from "../components/ProviderSelect";
import { closeSettings, useUI, type SettingsTab } from "../components/uiStore";
import { detectCompilers, type DetectedTool } from "../latex/compiler/compileApi";
import { useT, type MessageKey } from "../i18n";
import { errorKind, errorMessage, openExternal } from "../lib/backend";
import { isConnected, refreshAllConnections, refreshConnection, setConnection, useConnections } from "./connectionStore";
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

function Badge({ tone, children, testId }: { tone: "ok" | "bad" | "idle"; children: React.ReactNode; testId?: string }) {
  const color = tone === "ok" ? "text-emerald-600" : tone === "bad" ? "text-red-600" : "text-slate-500";
  const Icon = tone === "ok" ? CheckCircle2 : tone === "bad" ? XCircle : CircleDashed;
  return (
    <span className={`flex items-center gap-1 ${color}`} data-testid={testId}>
      <Icon size={13} /> {children}
    </span>
  );
}

function ApiKeyAuth({ provider, busy, setBusy }: { provider: ProviderId; busy: boolean; setBusy: (b: boolean) => void }) {
  const t = useT();
  const connection = useConnections((s) => s[provider]);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const method = PROVIDERS[provider].authMethods.find((m) => m.kind === "api_key")!;
  const status = connection.status;
  const connected = Boolean(status?.stored);

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

  return (
    <div>
      <button className="inline-flex items-center gap-0.5 text-[12px] text-sky-600 hover:underline" onClick={() => void openExternal(method.helpUrl)}>
        {t("settings.getKey")} <ExternalLink size={11} />
      </button>
      {connected ? (
        <div className="mt-2 flex items-center gap-2">
          <span className="font-mono text-[12px] text-slate-500">{t("settings.storedKey", { hint: status?.hint ?? "" })}</span>
          <button className="btn" onClick={() => void testConnection(provider)} disabled={busy || connection.loading}>
            {t("settings.testConnection")}
          </button>
          <button className="btn-danger" onClick={() => void disconnect()} disabled={busy} data-testid={`disconnect-${provider}`}>
            {t("settings.disconnect")}
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
            {t("settings.connect")}
          </button>
        </form>
      )}
      {status?.error && <div className="mt-1.5 text-[12px] text-red-600">{status.error}</div>}
      {error && <div className="mt-1.5 text-[12px] text-red-600">{error}</div>}
      <div className="mt-1.5 text-[11.5px] text-slate-400">
        {t("settings.keyStorageNote")}
      </div>
    </div>
  );
}

function ChatGPTAuth({ busy, setBusy }: { busy: boolean; setBusy: (b: boolean) => void }) {
  const t = useT();
  const chatgpt = useConnections((s) => s.openai.chatgpt);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const signIn = async () => {
    setWaiting(true);
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await signInWithChatGPT();
      await refreshConnection("openai");
      await testConnection("openai");
    } catch (err) {
      if (errorKind(err) !== "cancelled") setError(errorMessage(err));
    } finally {
      setWaiting(false);
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    setError(null);
    try {
      const { revoked } = await signOutOfChatGPT();
      setConnection("openai", { verified: undefined, testError: undefined });
      await refreshConnection("openai");
      setNote(revoked ? null : t("settings.signOutNotConfirmed"));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="chatgpt-auth">
      {chatgpt?.connected ? (
        <div className="space-y-2">
          <div className="text-[12.5px]" data-testid="chatgpt-account">
            {t("settings.signedInAs")} <span className="font-medium">{chatgpt.name ?? chatgpt.email ?? "ChatGPT user"}</span>
            {chatgpt.name && chatgpt.email ? <span className="text-slate-500"> ({chatgpt.email})</span> : null}
          </div>
          {!chatgpt.planUsage && (
            <div className="text-[12px] text-amber-700 dark:text-amber-300">
              {t("settings.planUsageMissing")}
            </div>
          )}
          <div className="flex items-center gap-2">
            <button className="btn" onClick={() => void testConnection("openai")} disabled={busy}>
              {t("settings.testConnection")}
            </button>
            <button className="btn" onClick={() => void openExternal(CHATGPT_USAGE_URL)}>
              {t("settings.manageUsage")} <ExternalLink size={11} />
            </button>
            <button className="btn-danger" onClick={() => void signOut()} disabled={busy} data-testid="chatgpt-sign-out">
              {t("settings.signOut")}
            </button>
          </div>
        </div>
      ) : waiting ? (
        <div className="flex items-center gap-2 text-[12.5px] text-slate-600 dark:text-slate-300">
          <Loader2 size={13} className="animate-spin" /> {t("settings.finishInBrowser")}
          <button className="btn" onClick={() => void cancelChatGPTSignIn()} data-testid="chatgpt-cancel">
            {t("settings.cancel")}
          </button>
        </div>
      ) : (
        <button className="btn-primary" onClick={() => void signIn()} disabled={busy} data-testid="chatgpt-sign-in">
          {t("settings.signInChatGPT")}
        </button>
      )}
      {chatgpt?.error && <div className="mt-1.5 text-[12px] text-red-600">{chatgpt.error}</div>}
      {error && <div className="mt-1.5 text-[12px] text-red-600" data-testid="chatgpt-error">{error}</div>}
      {note && <div className="mt-1.5 text-[12px] text-amber-700 dark:text-amber-300">{note}</div>}
      <div className="mt-1.5 text-[11.5px] text-slate-400">
        {t("settings.chatgptNote")}
      </div>
    </div>
  );
}

function ProviderCard({ provider }: { provider: ProviderId }) {
  const t = useT();
  const connection = useConnections((s) => s[provider]);
  const selectedModel = useSettings((s) => s.ai.models[provider]);
  const fetched = useSettings((s) => s.ai.fetchedModels[provider]);
  const custom = useSettings((s) => s.ai.customModels[provider]);
  const openaiAuth = useSettings((s) => s.ai.openaiAuth);
  const [customId, setCustomId] = useState("");
  const [busy, setBusy] = useState(false);
  const methods = PROVIDERS[provider].authMethods;
  const activeMethod = provider === "openai" ? openaiAuth : "api_key";
  const connected = isConnected(provider, connection, openaiAuth);
  const models = mergeModels(provider, fetched, custom);

  const chooseMethod = (method: AuthMethodKind) => {
    if (method === openaiAuth) return;
    // Model catalogs differ between ChatGPT plans and API keys.
    const ai = useSettings.getState().ai;
    useSettings.getState().updateAI({ openaiAuth: method, fetchedModels: { ...ai.fetchedModels, openai: [] } });
    setConnection("openai", { verified: undefined, testError: undefined });
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

  const storeMissing = activeMethod === "chatgpt" ? connection.chatgpt?.storeAvailable === false : connection.status?.storeAvailable === false;
  let badge: React.ReactNode;
  if (connection.loading || busy) badge = <span className="flex items-center gap-1 text-slate-500"><Loader2 size={13} className="animate-spin" /> {t("settings.checking")}</span>;
  else if (storeMissing) badge = <Badge tone="bad">{t("settings.storeUnavailable")}</Badge>;
  else if (connected && connection.verified === false) badge = <Badge tone="bad">{t("settings.connectionFailed")}</Badge>;
  else if (connected) badge = <Badge tone="ok" testId={`status-${provider}`}>{t("settings.connected")}</Badge>;
  else badge = <Badge tone="idle" testId={`status-${provider}`}>{t("settings.notConnected")}</Badge>;

  return (
    <section className="rounded-lg border border-slate-200 p-3 dark:border-slate-700" data-testid={`provider-${provider}`}>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-[13.5px] font-semibold">{provider === "anthropic" ? "Claude / Anthropic" : "OpenAI"}</h3>
        <div className="ml-auto text-[12px]">{badge}</div>
      </div>
      <Row label={t("settings.authentication")}>
        <div className="mb-2 flex flex-wrap items-center gap-3 text-[12.5px]">
          <KeyRound size={13} className="text-slate-400" />
          {methods.map((m) => (
            <label key={m.kind} className="flex items-center gap-1.5">
              <input
                type="radio"
                name={`auth-${provider}`}
                checked={activeMethod === m.kind}
                disabled={methods.length === 1 || busy}
                onChange={() => chooseMethod(m.kind)}
                data-testid={`auth-${provider}-${m.kind}`}
              />
              {t(AUTH_LABELS[m.kind])}
            </label>
          ))}
        </div>
        {activeMethod === "chatgpt" ? (
          <ChatGPTAuth busy={busy} setBusy={setBusy} />
        ) : (
          <ApiKeyAuth provider={provider} busy={busy} setBusy={setBusy} />
        )}
        {connection.testError && <div className="mt-1.5 text-[12px] text-red-600">{connection.testError}</div>}
      </Row>
      <Row label={t("settings.model")}>
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
          <button className="btn" title={t("settings.refreshListTitle")} disabled={!connected || connection.loading} onClick={() => void testConnection(provider)}>
            <RefreshCw size={12} /> {t("settings.refreshList")}
          </button>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input className="input max-w-[300px] flex-1 font-mono" placeholder={t("settings.otherModel")} value={customId} onChange={(e) => setCustomId(e.target.value)} />
          <button className="btn" onClick={addCustom} disabled={!customId.trim()}>
            {t("settings.add")}
          </button>
        </div>
      </Row>
    </section>
  );
}

function AISettings() {
  const t = useT();
  const defaultProvider = useSettings((s) => s.ai.defaultProvider);
  useEffect(() => {
    void refreshAllConnections();
  }, []);
  return (
    <div className="space-y-3">
      <Row label={t("settings.defaultProvider")} hint={t("settings.defaultProviderHint")}>
        <ProviderSelect value={defaultProvider} onChange={(p) => useSettings.getState().updateAI({ defaultProvider: p })} />
      </Row>
      {PROVIDER_IDS.map((p) => (
        <ProviderCard key={p} provider={p} />
      ))}
      <p className="text-[11.5px] text-slate-400">
        {t("settings.officialOnly")}
      </p>
    </div>
  );
}

function EditorSettingsPanel() {
  const t = useT();
  const editor = useSettings((s) => s.editor);
  const update = useSettings.getState().updateEditor;
  return (
    <div>
      <Row label={t("settings.theme")}>
        <select className="select" value={editor.theme} onChange={(e) => update({ theme: e.target.value as ThemeSetting })}>
          <option value="system">{t("settings.themeSystem")}</option>
          <option value="light">{t("settings.themeLight")}</option>
          <option value="dark">{t("settings.themeDark")}</option>
        </select>
      </Row>
      <Row label={t("settings.font")}>
        <input className="input w-full font-mono" value={editor.fontFamily} onChange={(e) => update({ fontFamily: e.target.value })} />
      </Row>
      <Row label={t("settings.fontSize")}>
        <input
          type="number"
          min={10}
          max={28}
          className="input w-20"
          value={editor.fontSize}
          onChange={(e) => update({ fontSize: Math.max(10, Math.min(28, Number(e.target.value) || 14)) })}
        />
      </Row>
      <Row label={t("settings.tabSize")}>
        <select className="select" value={editor.tabSize} onChange={(e) => update({ tabSize: Number(e.target.value) })}>
          {[2, 4, 8].map((n) => (
            <option key={n} value={n}>
              {t("settings.spaces", { count: n })}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t("settings.wordWrap")}>
        <label className="flex items-center gap-2 pt-1 text-[12.5px]">
          <input type="checkbox" checked={editor.wordWrap} onChange={(e) => update({ wordWrap: e.target.checked })} />
          {t("settings.wrapLines")}
        </label>
      </Row>
    </div>
  );
}

function LatexSettingsPanel() {
  const t = useT();
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
      <Row label={t("settings.compiler")} hint={t("settings.compilerHint")}>
        <select className="select" value={latex.compiler} onChange={(e) => update({ compiler: e.target.value as CompilerSetting })}>
          <option value="auto">{t("settings.compilerAuto")}</option>
          <option value="latexmk">latexmk</option>
          <option value="pdflatex">pdflatex</option>
          <option value="xelatex">xelatex</option>
          <option value="custom">{t("settings.compilerCustom")}</option>
        </select>
        <div className="mt-1.5 text-[11.5px] text-slate-500">
          {tools === null
            ? t("settings.detecting")
            : tools.length === 0
              ? t("settings.noTools")
              : t("settings.found", { tools: tools.map((tool) => tool.name).join(", ") })}
        </div>
      </Row>
      {latex.compiler !== "custom" && latex.compiler !== "auto" && (
        <Row label={t("settings.compilerPath")} hint={t("settings.compilerPathHint")}>
          <input className="input w-full font-mono" placeholder={`/path/to/${latex.compiler}`} value={latex.compilerPath} onChange={(e) => update({ compilerPath: e.target.value })} />
        </Row>
      )}
      {latex.compiler === "custom" && (
        <Row label={t("settings.compileCommand")} hint={t("settings.compileCommandHint")}>
          <input className="input w-full font-mono" value={latex.customCommand} onChange={(e) => update({ customCommand: e.target.value })} />
        </Row>
      )}
      <Row label={t("settings.livePreview")}>
        <label className="flex items-center gap-2 pt-1 text-[12.5px]">
          <input
            type="checkbox"
            checked={latex.livePreview}
            onChange={(e) => update({ livePreview: e.target.checked })}
            data-testid="live-preview"
          />
          {t("settings.livePreviewOn")}
        </label>
      </Row>
      <Row label={t("settings.timeout")}>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={10}
            max={1800}
            className="input w-24"
            value={latex.timeoutSecs}
            onChange={(e) => update({ timeoutSecs: Math.max(10, Math.min(1800, Number(e.target.value) || 120)) })}
          />
          <span className="text-[12px] text-slate-500">{t("settings.seconds")}</span>
        </div>
      </Row>
    </div>
  );
}

const TABS: { id: SettingsTab; label: MessageKey }[] = [
  { id: "ai", label: "settings.tabAI" },
  { id: "editor", label: "settings.tabEditor" },
  { id: "latex", label: "settings.tabLatex" },
];

const AUTH_LABELS: Record<AuthMethodKind, MessageKey> = {
  api_key: "settings.apiKey",
  chatgpt: "settings.signInChatGPT",
};

export function SettingsDialog() {
  const t = useT();
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
          <h2 className="text-[14px] font-semibold">{t("settings.title")}</h2>
          <div className="ml-6 flex gap-1">
            {TABS.map((item) => (
              <button
                key={item.id}
                className={`rounded-md px-2.5 py-1 text-[12.5px] ${tab === item.id ? "bg-slate-100 font-medium dark:bg-slate-700" : "text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800"}`}
                onClick={() => useUI.setState({ settingsTab: item.id })}
              >
                {t(item.label)}
              </button>
            ))}
          </div>
          <button className="icon-btn ml-auto" onClick={closeSettings} title={t("settings.closeTitle")}>
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
