/**
 * Inline AI edit (Cmd/Ctrl+K): select text, give an instruction, watch the
 * streamed rewrite, review the diff, then Accept / Reject / Regenerate.
 * Nothing is written to the document until the author accepts.
 */
import { create } from "zustand";
import { buildEditContext } from "../../ai/context/contextBuilder";
import { paragraphContext } from "../../ai/context/paragraphs";
import { MAX_OUTPUT_TOKENS } from "../../ai/models/modelConfig";
import { aiService, newRequestId } from "../../ai/service";
import type { AIErrorKind } from "../../ai/errors";
import { AIError } from "../../ai/errors";
import type { FinishReason, ProviderId } from "../../ai/types";
import { normalizeRewrite, validateRewrite, type ValidationIssue } from "../../latex/validation";
import { openFile } from "../../project/projectActions";
import { notify, useProject } from "../../project/projectStore";
import { useSettings } from "../../settings/settingsStore";
import { aiTargetField, setAITarget, type TargetRange } from "../aiTarget";
import { editorSession } from "../editorSession";

export type InlinePhase = "input" | "streaming" | "review" | "error";

interface InlineEditState {
  open: boolean;
  path: string | null;
  original: string;
  phase: InlinePhase;
  instruction: string;
  provider: ProviderId;
  model: string;
  output: string;
  result: string;
  issues: ValidationIssue[];
  error?: string;
  errorKind?: AIErrorKind;
  finishReason?: FinishReason;
  requestId?: string;
  origin: "inline" | "chat";
  note?: string;
}

const closedState = {
  open: false,
  path: null,
  original: "",
  phase: "input" as InlinePhase,
  output: "",
  result: "",
  issues: [],
  error: undefined,
  errorKind: undefined,
  finishReason: undefined,
  requestId: undefined,
  note: undefined,
};

export const useInlineEdit = create<InlineEditState>()(() => ({
  ...closedState,
  instruction: "",
  provider: "openai",
  model: "",
  origin: "inline",
}));

function setTarget(path: string | null, range: TargetRange | null) {
  if (path) editorSession.dispatchEffects(path, [setAITarget.of(range)]);
}

function currentTarget(): TargetRange | null {
  return editorSession.getView()?.state.field(aiTargetField, false) ?? null;
}

function bibKeys(): Set<string> {
  return new Set(useProject.getState().bibEntries.map((e) => e.key));
}

/** Open the command box for the selection (or the paragraph under the cursor). */
export function openInlineEdit(): boolean {
  const view = editorSession.getView();
  const snapshot = editorSession.selection();
  if (!view || !snapshot) return false;
  let { from, to } = snapshot;
  if (from === to) {
    const range = paragraphContext(snapshot.docText, from, to).currentRange;
    if (!range) {
      notify("info", "Select the text you want LOGICA to edit.");
      return true;
    }
    ({ from, to } = range);
    view.dispatch({ selection: { anchor: from, head: to } });
  }
  const state = useInlineEdit.getState();
  if (state.open) rejectInlineEdit();
  setTarget(snapshot.path, { from, to });
  useInlineEdit.setState({
    ...closedState,
    open: true,
    path: snapshot.path,
    original: snapshot.docText.slice(from, to),
    origin: "inline",
    provider: state.open ? state.provider : useSettings.getState().ai.defaultProvider,
    instruction: "",
  });
  return true;
}

/** Send the instruction to the selected provider and stream the result. */
export async function runInlineEdit(instruction: string, provider?: ProviderId): Promise<void> {
  const state = useInlineEdit.getState();
  const target = currentTarget();
  const snapshot = editorSession.selection();
  if (!state.open || !target || !snapshot || snapshot.path !== state.path) return;
  const providerId = provider ?? state.provider;
  const model = useSettings.getState().ai.models[providerId];
  const requestId = newRequestId();
  const context = buildEditContext(useProject.getState().doc, {
    filePath: snapshot.path,
    text: snapshot.docText,
    selectionFrom: target.from,
    selectionTo: target.to,
  });

  useInlineEdit.setState({
    phase: "streaming",
    instruction,
    provider: providerId,
    model,
    output: "",
    result: "",
    issues: [],
    error: undefined,
    errorKind: undefined,
    note: undefined,
    requestId,
  });

  try {
    const response = await aiService.generate(
      providerId,
      {
        id: requestId,
        task: "inline-edit",
        instruction,
        selectedText: state.original,
        context,
        model,
        maxOutputTokens: MAX_OUTPUT_TOKENS["inline-edit"],
      },
      {
        onDelta: (_delta, full) => {
          if (useInlineEdit.getState().requestId === requestId) useInlineEdit.setState({ output: full });
        },
      },
    );
    if (useInlineEdit.getState().requestId !== requestId) return;
    const result = normalizeRewrite(state.original, response.text);
    const issues = validateRewrite(state.original, result, { bibKeys: bibKeys() });
    if (response.finishReason === "length") {
      issues.unshift({ severity: "error", message: "The response was cut off (output limit reached)." });
    }
    useInlineEdit.setState({
      phase: "review",
      output: response.text,
      result,
      issues,
      finishReason: response.finishReason,
    });
  } catch (err) {
    if (useInlineEdit.getState().requestId !== requestId) return;
    const error = err instanceof AIError ? err : new AIError("unknown", String(err));
    if (error.kind === "cancelled") {
      useInlineEdit.setState({ phase: "input", note: "Generation stopped.", requestId: undefined });
      return;
    }
    useInlineEdit.setState({ phase: "error", error: error.message, errorKind: error.kind, requestId: undefined });
  }
}

export function stopInlineEdit() {
  const { requestId } = useInlineEdit.getState();
  if (requestId) void aiService.cancel(requestId);
}

/** Apply the reviewed result to the document. */
export function acceptInlineEdit(): boolean {
  const state = useInlineEdit.getState();
  const target = currentTarget();
  const view = editorSession.getView();
  if (!state.open || state.phase !== "review" || !view || !state.path) return false;
  if (editorSession.activePath !== state.path) return false;
  if (!target || view.state.sliceDoc(target.from, target.to) !== state.original) {
    useInlineEdit.setState({
      phase: "error",
      error: "The original text was edited while the AI was working. Run the edit again on the new text.",
      errorKind: "unknown",
    });
    return false;
  }
  editorSession.applyEdit(state.path, target.from, target.to, state.result, [setAITarget.of(null)]);
  useInlineEdit.setState({ ...closedState });
  editorSession.focus();
  return true;
}

export function rejectInlineEdit() {
  stopInlineEdit();
  setTarget(useInlineEdit.getState().path, null);
  useInlineEdit.setState({ ...closedState });
  editorSession.focus();
}

export function regenerateInlineEdit(provider?: ProviderId) {
  const { instruction } = useInlineEdit.getState();
  if (instruction) void runInlineEdit(instruction, provider);
}

export function setInlineProvider(provider: ProviderId) {
  useInlineEdit.setState({ provider, model: useSettings.getState().ai.models[provider] });
}

/**
 * Review a replacement proposed in the chat for a given range. The anchor
 * text is looked up again in case the document changed since the request.
 */
export async function reviewProposal(anchor: { path: string; from: number; to: number; text: string }, proposal: string, instruction: string, provider: ProviderId) {
  const opened = await openFile(anchor.path);
  const view = editorSession.getView();
  if (!opened || !view) return;
  const doc = view.state.doc.toString();
  let from = anchor.from;
  let to = anchor.to;
  if (doc.slice(from, to) !== anchor.text) {
    const index = doc.indexOf(anchor.text);
    if (index < 0 || !anchor.text) {
      notify("error", "The original text is no longer in the document, so the suggestion cannot be applied.");
      return;
    }
    from = index;
    to = index + anchor.text.length;
  }
  if (useInlineEdit.getState().open) rejectInlineEdit();
  setTarget(anchor.path, { from, to });
  view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
  const result = normalizeRewrite(anchor.text, proposal);
  useInlineEdit.setState({
    ...closedState,
    open: true,
    path: anchor.path,
    original: anchor.text,
    phase: "review",
    origin: "chat",
    instruction,
    provider,
    model: useSettings.getState().ai.models[provider],
    output: proposal,
    result,
    issues: validateRewrite(anchor.text, result, { bibKeys: bibKeys() }),
  });
}
