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
  /** Source of the current section (chat only, size-limited). */
  currentSectionText?: string;
  previousParagraph?: string;
  /** Paragraph around the cursor when nothing is selected. */
  currentParagraph?: string;
  nextParagraph?: string;
}

export interface AIMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Chat runs as a pipeline: `intent` works out what the user wants to know,
 * then `answer` (the Answer Agent) answers from the whole paper.
 */
export type AITask = "inline-edit" | "intent" | "answer";

export interface ProjectFile {
  path: string;
  text: string;
}

export type IntentType = "concept" | "method" | "result" | "claim" | "edit" | "other";

/** What the user wants, as worked out by the Intent Module. */
export interface QuestionIntent {
  type: IntentType;
  /** One or two sentences in the user's language. */
  text: string;
}

export interface AIRequest {
  id: string;
  task: AITask;
  instruction: string;
  selectedText?: string;
  context: AIContext;
  /** Earlier chat turns (intent and answer). */
  history?: AIMessage[];
  /** The paper's source files (answer only, size-limited). */
  projectFiles?: ProjectFile[];
  /** Paper files left out of `projectFiles` to stay within the budget. */
  omittedFiles?: string[];
  /** Output of the Intent Module (answer only). */
  intent?: QuestionIntent;
  model: string;
  maxOutputTokens?: number;
}

export type FinishReason = "stop" | "length" | "cancelled" | "error";

export interface AIUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface AIResponse {
  id: string;
  provider: ProviderId;
  model: string;
  text: string;
  finishReason: FinishReason;
  usage?: AIUsage;
}

export interface StreamHandlers {
  /** Called for every streamed text delta with the accumulated text. */
  onDelta?: (delta: string, fullText: string) => void;
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
