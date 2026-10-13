import { GitCompare, Send, Square, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PROVIDER_LABELS } from "../ai/providers/registry";
import { ProviderSelect } from "../components/ProviderSelect";
import { reviewProposal } from "../editor/inlineEdit/inlineEditStore";
import { useT, type MessageKey } from "../i18n";
import { useSettings } from "../settings/settingsStore";
import { useWorkspace } from "../storage/workspaceStore";
import {
  chatProvider,
  clearChat,
  sendChatMessage,
  setChatProvider,
  splitBlocks,
  stopChat,
  useChat,
  type ChatMessage,
} from "./chatStore";

const EXAMPLES: MessageKey[] = ["chat.example1", "chat.example2", "chat.example3", "chat.example4"];

function AssistantMessage({ message }: { message: ChatMessage }) {
  const t = useT();
  if (message.status === "error") {
    return <div className="rounded-md bg-red-50 px-2.5 py-2 text-[12.5px] text-red-800 dark:bg-red-950/50 dark:text-red-200">{message.content}</div>;
  }
  const blocks = splitBlocks(message.content);
  return (
    <div className="space-y-2 text-[13px] leading-relaxed">
      {blocks.map((block, i) =>
        block.kind === "text" ? (
          <div key={i} className="whitespace-pre-wrap">
            {block.text.trim()}
          </div>
        ) : (
          <div key={i} className="overflow-hidden rounded-md border border-slate-200 dark:border-slate-700">
            <pre className="max-h-72 overflow-auto bg-slate-50 p-2 font-mono text-[12px] whitespace-pre-wrap dark:bg-slate-900">{block.text}</pre>
            {message.status === "done" && message.anchor && (block.lang === "latex" || block.lang === "tex" || !block.lang) && (
              <div className="flex items-center gap-2 border-t border-slate-200 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-800">
                <button
                  className="btn h-6 shrink-0 text-[11.5px] whitespace-nowrap"
                  data-testid="chat-review"
                  onClick={() => void reviewProposal(message.anchor!, block.text, message.instruction ?? "", message.provider ?? chatProvider())}
                >
                  <GitCompare size={12} /> {t("chat.reviewDiff")}
                </button>
                <span className="truncate text-[11px] text-slate-400">{t("chat.replaces", { count: message.anchor.text.length })}</span>
              </div>
            )}
          </div>
        ),
      )}
      {message.status === "streaming" && <span className="inline-block h-3 w-1.5 animate-pulse bg-slate-400" />}
      {message.status === "cancelled" && <div className="text-[11.5px] text-slate-400">{t("chat.stopped")}</div>}
    </div>
  );
}

export function ChatPanel() {
  const t = useT();
  const messages = useChat((s) => s.messages);
  const running = useChat((s) => s.runningId !== null);
  const providerOverride = useChat((s) => s.provider);
  const defaultProvider = useSettings((s) => s.ai.defaultProvider);
  const models = useSettings((s) => s.ai.models);
  const provider = providerOverride ?? defaultProvider;
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const send = () => {
    if (!draft.trim() || running) return;
    void sendChatMessage(draft);
    setDraft("");
  };

  return (
    <div className="flex h-full flex-col bg-white dark:bg-[#0f141b]" data-testid="chat-panel">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-2 dark:border-slate-800 dark:bg-[#121820]">
        <span className="panel-title whitespace-nowrap">{t("chat.title")}</span>
        <ProviderSelect value={provider} onChange={setChatProvider} className="ml-1 h-6 text-[12px]" />
        <span className="truncate text-[11px] text-slate-400" title={models[provider]}>
          {models[provider]}
        </span>
        <button className="icon-btn ml-auto" title={t("chat.clear")} onClick={clearChat}>
          <Trash2 size={12} />
        </button>
        <button className="icon-btn" title={t("chat.close")} onClick={() => useWorkspace.getState().updateLayout({ showChat: false })}>
          <X size={13} />
        </button>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 && (
          <div className="space-y-2 text-[12.5px] text-slate-500">
            <p>{t("chat.intro")}</p>
            <div className="space-y-1">
              {EXAMPLES.map((key) => t(key)).map((example) => (
                <button
                  key={example}
                  className="block w-full rounded-md border border-slate-200 px-2 py-1 text-left hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                  onClick={() => setDraft(example)}
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message) =>
          message.role === "user" ? (
            <div key={message.id} className="ml-6">
              {message.contextLabel && <div className="mb-0.5 truncate text-right text-[10.5px] text-slate-400">{message.contextLabel}</div>}
              <div className="rounded-lg bg-sky-50 px-2.5 py-1.5 text-[13px] whitespace-pre-wrap text-slate-800 dark:bg-sky-950/50 dark:text-slate-100">
                {message.content}
              </div>
            </div>
          ) : (
            <div key={message.id} data-testid="chat-assistant">
              <div className="mb-0.5 text-[10.5px] text-slate-400">
                {message.provider ? PROVIDER_LABELS[message.provider] : ""} {message.model ? `(${message.model})` : ""}
              </div>
              <AssistantMessage message={message} />
            </div>
          ),
        )}
      </div>
      <div className="shrink-0 border-t border-slate-200 p-2 dark:border-slate-800">
        <textarea
          ref={inputRef}
          data-testid="chat-input"
          className="input h-auto min-h-[60px] w-full resize-none py-1.5 leading-snug"
          placeholder={t("chat.placeholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="mt-1.5 flex items-center">
          <span className="text-[11px] text-slate-400">{t("chat.footer")}</span>
          {running ? (
            <button className="btn ml-auto" onClick={stopChat} data-testid="chat-stop">
              <Square size={11} /> {t("chat.stop")}
            </button>
          ) : (
            <button className="btn-primary ml-auto" onClick={send} disabled={!draft.trim()} data-testid="chat-send">
              <Send size={12} /> {t("chat.send")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
