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

export type AITask = "inline-edit" | "chat";

export interface AIRequest {
  id: string;
  task: AITask;
  instruction: string;
  selectedText?: string;
  context: AIContext;
  /** Earlier chat turns (chat only). */
  history?: AIMessage[];
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

export type AuthMethodKind = "api_key";

export interface AuthMethodDescriptor {
  kind: AuthMethodKind;
  label: string;
  /** Where users obtain the credential. */
  helpUrl: string;
  placeholder: string;
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
