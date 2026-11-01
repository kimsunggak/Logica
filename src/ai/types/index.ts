/**
 * Provider-independent AI types.
 *
 * UI code builds an `AIRequest` (semantic context + instruction) and hands it
 * to the AI service. Provider adapters turn it into vendor-specific requests.
 */

export type ProviderId = "openai" | "anthropic";

export const PROVIDER_IDS: readonly ProviderId[] = ["openai", "anthropic"];

/** Semantic paper context shared by all providers. */
export interface AIContext {
  projectName?: string;
  currentFile?: string;
  paperTitle?: string;
  abstract?: string;
  outline?: string;
  /** e.g. "3 Method › 3.2 Uncertainty-guided Routing" */
  currentSection?: string;
  previousParagraph?: string;
  /** Paragraph around the cursor when nothing is selected. */
  currentParagraph?: string;
  nextParagraph?: string;
}

export interface AIMessage {
  role: "user" | "assistant";
  content: string;
}

/** UI purpose; common refinement precedes fixed routing or Auto classification. */
export type ChatMode = "auto" | "chat" | "edit";
export type ExecutionMode = Exclude<ChatMode, "auto">;
export type AITask = "inline-edit" | "judge" | "reply" | "refine" | "select" | "research" | "answer" | "edit" | "summary" | "sections";

/** The model calls of a chat turn. */
export type ChatTask = Exclude<AITask, "inline-edit">;

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

/** A function the model may call; `parameters` is a JSON Schema object. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** A function call made by the model. */
export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments; empty when the model sent none or invalid JSON. */
  arguments: Record<string, unknown>;
  /** Set when the streamed arguments could not be read as a JSON object. */
  argumentsError?: "invalid_json" | "not_object";
}

/** A turn handed to the Session Summary Module to fold into the session summary. */
export interface FoldTurn {
  index: number;
  question: string;
  answer: string;
}

export interface ProjectFile {
  path: string;
  text: string;
}

/** Lines `fromLine`..`toLine` (1-based, inclusive) of one file. */
export interface SourceRange {
  path: string;
  fromLine: number;
  toLine: number;
  text: string;
}

/** A section of the paper map: what routing and source selection see of it. */
export interface MapEntry {
  key: string;
  title: string;
  /** 0 for the front matter and top-level sections, 1 for subsections. */
  depth: number;
  words: number;
  labels: string[];
  /** Its summary in the paper report; absent when there is none yet. */
  summary?: string;
  /** Read word for word in every turn (the front matter). */
  always?: boolean;
}

/** A section as the Chat and Edit modules read it: word for word, as its summary, or left out. */
export type ViewSection = { key: string; title: string; depth: number } & (
  | { content: "full"; sources: SourceRange[] }
  | { content: "summary"; summary: string }
  | { content: "omitted" }
);

/** The paper section by section, once the report has summaries of it. */
export interface PaperView {
  sections: ViewSection[];
  /** Macro definitions of the preamble. */
  macros?: string;
}

/** A section handed to the Paper Summary Module. */
export interface SectionToSummarize {
  key: string;
  title: string;
  text: string;
}

/** A web page the answer drew on, from the provider's built-in web search. */
export interface WebSource {
  url: string;
  title?: string;
}

/** A source cited for `response.text.slice(start, end)`. */
export interface TextCitation {
  start: number;
  end: number;
  url: string;
  title?: string;
  /** The cited text of the source (Claude only, up to 150 characters). */
  quote?: string;
}

/** A finding of the Web Research Module that the Paper Edit Module may use, with the sources it cites. */
export interface WebEvidence {
  /** W1, W2, ... */
  id: string;
  finding: string;
  sources: (WebSource & { quote?: string })[];
}

export interface AIRequest {
  id: string;
  task: AITask;
  instruction: string;
  uiMode?: ChatMode;
  executionMode?: ExecutionMode;
  selectedText?: string;
  context: AIContext;
  /** Earlier chat turns sent word for word (L2). */
  history?: AIMessage[];
  /** The session summary of the turns before them (L1), as prompt text. */
  sessionSummary?: string;
  /** The turns to fold into the session summary (summary only). */
  foldTurns?: FoldTurn[];
  /** The paper's source files (Chat and Edit, size-limited), when the whole paper is read. */
  projectFiles?: ProjectFile[];
  /** Paper files left out of `projectFiles` to stay within the budget. */
  omittedFiles?: string[];
  /** The paper section by section (Chat and Edit), in place of `projectFiles`. */
  paperView?: PaperView;
  /** The sections routing and source selection read, with their summaries (Auto Router and section selection). */
  paperMap?: MapEntry[];
  /** The answer may ask for sections it has only as summaries (answer only). */
  mayAskForSections?: boolean;
  /** Section selection decides whether the edit needs web research (select, in Edit with web search on). */
  mayResearch?: boolean;
  /** What to find out on the web (research only). */
  researchQuestions?: string[];
  /** The text the edit will change, to research for (research only). */
  researchSources?: SourceRange[];
  /** What the web research found, for the edit to use (edit only). */
  webEvidence?: WebEvidence[];
  /** What the web research could not find (edit only). */
  researchGaps?: string[];
  /** The sections to summarize (sections only). */
  sectionsToSummarize?: SectionToSummarize[];
  /** The question as rewritten by the Refine Module (routing and execution). */
  refinedQuestion?: string;
  /** Sections this edit may change; reference sections are read-only. */
  editSections?: string[];
  /** Functions offered to routing, selection, edit and summary models. */
  tools?: ToolDefinition[];
  model: string;
  /** Reasoning effort, mapped to each provider’s API format. */
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
  /** Offer the provider's built-in web search; the model decides whether to search (answer and research). */
  webSearch?: boolean;
  /** Most web searches this call may run, where the provider takes a limit (research). */
  maxSearches?: number;
  /**
   * Keep the text written before each web search (research: findings come
   * between searches). By default it is dropped as a note such as "let me
   * look that up", and the text starts over after the search.
   */
  keepTextBeforeSearch?: boolean;
}

export type FinishReason = "stop" | "length" | "cancelled" | "error";

export interface AIUsage {
  inputTokens?: number;
  /** Input tokens served from the provider's prompt cache. */
  cachedInputTokens?: number;
  outputTokens?: number;
  /** Searches the provider's built-in web search ran. */
  webSearchRequests?: number;
}

export interface AIResponse {
  id: string;
  provider: ProviderId;
  model: string;
  text: string;
  /** Function calls the model made (only when the request offered tools). */
  toolCalls?: ToolCall[];
  finishReason: FinishReason;
  usage?: AIUsage;
  /** Web pages the answer cites (or, when it cites none, the search results). */
  sources?: WebSource[];
  /** The queries of the web searches the model ran. */
  searchQueries?: string[];
  /** Which parts of `text` cite which sources. */
  citations?: TextCitation[];
}

export interface StreamHandlers {
  /** Called for every streamed text delta with the accumulated text. */
  onDelta?: (delta: string, fullText: string) => void;
  /**
   * A web search started (no query yet) or its query is known. The text so far
   * (a note like "let me look that up") is dropped: `onDelta` starts over after it.
   */
  onSearch?: (query?: string) => void;
}

export interface ModelConfig {
  id: string;
  provider: ProviderId;
  displayName: string;
  supportsStreaming: boolean;
  contextWindow?: number;
  /** Where the entry comes from: shipped defaults, provider API, or the user. */
  source?: "default" | "api" | "custom";
}

/** `chatgpt` is OpenAI's Sign in with ChatGPT (uses the user's ChatGPT plan). */
export type AuthMethodKind = "api_key" | "chatgpt";

export interface AuthMethodDescriptor {
  kind: AuthMethodKind;
  label: string;
  /** Where users obtain the credential or manage the connection. */
  helpUrl: string;
  /** Input placeholder for API keys. */
  placeholder?: string;
}

/** Sign in with ChatGPT connection state (no tokens). */
export interface ChatGPTStatus {
  connected: boolean;
  email: string | null;
  name: string | null;
  /** Whether the user allowed LOGICA to use their ChatGPT plan. */
  planUsage: boolean;
  storeAvailable: boolean;
  error: string | null;
}

export interface CredentialStatus {
  provider: ProviderId;
  stored: boolean;
  method: AuthMethodKind | null;
  hint: string | null;
  storeAvailable: boolean;
  error: string | null;
}

export interface AIProvider {
  id: ProviderId;
  name: string;
  authMethods: AuthMethodDescriptor[];

  isAuthenticated(): Promise<boolean>;

  generate(request: AIRequest, handlers?: StreamHandlers): Promise<AIResponse>;

  cancel?(requestId: string): Promise<void>;

  /** Models available to the connected account (provider API). */
  listModels?(): Promise<ModelConfig[]>;
}
