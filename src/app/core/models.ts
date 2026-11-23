export type ProviderId =
  | 'askiicloud'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openrouter'
  | 'opencodego'
  | 'ollama'
  | 'lmstudio';

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  description: string;
  connection: 'apiKey' | 'serverUrl';
  supportsCustomBaseUrl: boolean;
}

export interface PromptRecipe {
  command: string;
  label: string;
  description: string;
  systemPrompt: string;
  userPrefix: string;
  autoAttachClipboard: boolean;
  modelOverride?: string | null;
}

export type AgentMode = 'confirm' | 'autoDo';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string | null;
  args: string[];
  url?: string | null;
  enabled: boolean;
}

export interface AgentSettings {
  enabled: boolean;
  mode: AgentMode;
  autoApproveDesktopControls: boolean;
  guardDestructiveCommands: boolean;
  maxSteps: number;
  mcpServers: McpServerConfig[];
}

export type ApprovalDecision = 'allowOnce' | 'allowSession' | 'deny';

export interface ModelProfile {
  provider: ProviderId;
  model: string;
}

export interface ClipboardHistoryItem {
  index: number;
  text: string;
  preview: string;
  sourceApp?: string | null;
  capturedAt: number;
}

export interface AppConfig {
  setupCompleted: boolean;
  provider: ProviderId;
  model: string;
  ollamaUrl: string;
  lmstudioUrl: string;
  openaiUrl: string;
  shortcut: string;
  actionShortcut: string;
  whisperUrl: string;
  startWithWindows: boolean;
  clipboardHistoryEnabled: boolean;
  recentModels: ModelProfile[];
  promptHistory: string[];
  recipes: PromptRecipe[];
  agent: AgentSettings;
}

export interface AppStateDto {
  config: AppConfig;
  providers: ProviderDefinition[];
  savedCredentials: Record<string, boolean>;
  needsSetup: boolean;
}

export interface DiscoverModelsRequest {
  provider: ProviderId;
  apiKey?: string;
  serverUrl?: string;
  openaiBaseUrl?: string;
}

export interface ModelDiscoveryResult {
  mode: 'models' | 'manual';
  models: string[];
  warning?: string | null;
}

export interface SaveSetupRequest {
  provider: ProviderId;
  model: string;
  apiKey?: string;
  ollamaUrl?: string;
  lmstudioUrl?: string;
  openaiUrl?: string;
  shortcut?: string;
  actionShortcut?: string;
  whisperUrl?: string;
}

export interface PreviousWindowInfo {
  hwnd: number;
  title: string;
  processName: string;
  exePath?: string | null;
}

export interface WindowShownPayload {
  openSetup: boolean;
  previousWindow?: PreviousWindowInfo | null;
  selectionText?: string | null;
}

export interface ClipboardContextPayload {
  kind: 'text' | 'image' | 'empty';
  text?: string | null;
  base64Png?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface ScreenCaptureResult {
  base64Png: string;
  width: number;
  height: number;
  label: string;
}

export interface FileAttachmentResult {
  kind: 'text' | 'image';
  name: string;
  path: string;
  text?: string | null;
  truncated: boolean;
  base64Png?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface ImageAttachment {
  mimeType: string;
  dataBase64: string;
}

export type ContextAttachmentKind =
  | 'selection'
  | 'clipboard'
  | 'window'
  | 'screenshot'
  | 'file';

export interface ContextAttachment {
  id: string;
  kind: ContextAttachmentKind;
  label: string;
  detail?: string;
  text?: string;
  image?: ImageAttachment;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: ImageAttachment[];
}

export interface ToolActionEntry {
  callId: string;
  name: string;
  tier: number;
  summary: string;
  arguments: Record<string, unknown>;
  status: 'pendingApproval' | 'running' | 'success' | 'error' | 'denied';
  dangerWarning?: string | null;
  output?: string;
  backupId?: string | null;
  undone?: boolean;
}

export type StreamEvent =
  | { event: 'chunk'; data: { text: string } }
  | {
      event: 'toolProposed';
      data: {
        callId: string;
        name: string;
        tier: number;
        summary: string;
        arguments: Record<string, unknown>;
        needsApproval: boolean;
        dangerWarning?: string | null;
      };
    }
  | { event: 'toolRunning'; data: { callId: string; name: string } }
  | {
      event: 'toolResult';
      data: {
        callId: string;
        name: string;
        success: boolean;
        output: string;
        backupId?: string | null;
      };
    }
  | { event: 'toolDenied'; data: { callId: string; name: string; reason: string } }
  | { event: 'done'; data: { truncated: boolean } }
  | { event: 'error'; data: { message: string } }
  | { event: 'cancelled' };

export interface ConversationTurn {
  id: number;
  question: string;
  answer: string;
  timestamp: string;
  providerLabel: string;
  model: string;
  streaming: boolean;
  stopped: boolean;
  truncated: boolean;
  error?: string;
  contextLabels?: string[];
  toolActions?: ToolActionEntry[];
}

export interface InstantResult {
  id: string;
  kind: 'calc' | 'unit' | 'util' | 'app' | 'window';
  label: string;
  description: string;
  badge: string;
  copyValue?: string | null;
  launchPath?: string | null;
  hwnd?: number | null;
}

export interface StoredTurn {
  question: string;
  answer: string;
  timestamp: string;
  providerLabel: string;
  model: string;
  contextLabels: string[];
  toolActionsJson: string;
}

export interface StoredSlip {
  id: string;
  slipNumber: number;
  title: string;
  provider: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  turns: StoredTurn[];
}

export interface SlipSummary {
  id: string;
  slipNumber: number;
  title: string;
  preview: string;
  provider: string;
  model: string;
  turnCount: number;
  updatedAt: number;
}

export interface MemoryEntry {
  id: number;
  content: string;
  createdAt: number;
}

export type AskiiMode = 'pill' | 'setup' | 'paper' | 'history' | 'memory';

export interface SlashCommand {
  command: string;
  label: string;
  description: string;
  kaomoji: string;
}

export interface AutocompleteSuggestion {
  kind: 'command' | 'recipe' | 'mention' | 'instant' | 'model' | 'history';
  value: string;
  label: string;
  description: string;
  badge: string;
  instantItem?: InstantResult;
  modelProfile?: ModelProfile;
}
