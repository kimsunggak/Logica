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

/**
 * Chat is run by the Chat Orchestrator: `judge` picks the route of a message
 * by calling a tool, `reply` answers small talk, `refine` rewrites an
 * abstract question into a clear one, and `answer` answers from the whole
 * paper.
 */
export type AITask = "inline-edit" | "judge" | "reply" | "refine" | "answer";

/** The model calls of a chat turn. */
export type ChatTask = Exclude<AITask, "inline-edit">;

export type ReasoningEffort = "low" | "medium" | "high";

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

export interface ProjectFile {
  path: string;
  text: string;
}

export interface AIRequest {
  id: string;
  task: AITask;
  instruction: string;
  selectedText?: string;
  context: AIContext;
  /** Earlier chat turns. */
  history?: AIMessage[];
  /** The paper's source files (refine and answer, size-limited). */
  projectFiles?: ProjectFile[];
  /** Paper files left out of `projectFiles` to stay within the budget. */
  omittedFiles?: string[];
  /** The question as rewritten by the Refine Module (answer only). */
  refinedQuestion?: string;
  /** Functions the model must choose one of (judge only). */
  tools?: ToolDefinition[];
  model: string;
  /** Reasoning effort, mapped to each provider’s API format. */
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
}

export type FinishReason = "stop" | "length" | "cancelled" | "error";

export interface AIUsage {
  inputTokens?: number;
  /** Input tokens served from the provider's prompt cache. */
  cachedInputTokens?: number;
  outputTokens?: number;
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
