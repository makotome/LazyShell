export type DangerLevel = 'green' | 'yellow' | 'red';
export type CommandSource = 'direct' | 'terminal' | 'ai' | 'history' | 'favorite' | 'builtin';

export type CommandCategory = 'file' | 'text' | 'system' | 'network' | 'process' | 'archive' | 'disk' | 'package' | 'other';

export interface AIProvider {
  type: 'minimax' | 'openai' | 'anthropic';
  name: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  complete(prompt: string, context: TerminalContext): Promise<AIResponse>;
}

export interface AICommandOption {
  command: string;
  description: string;
  isDangerous: boolean;
  reason?: string;
}

export interface AIResponse {
  // Single command mode (backward compatible)
  command?: string;
  explanation?: string;
  isDangerous?: boolean;

  // Multiple options mode
  options?: AICommandOption[];

  // Intent: single (single command), multiple (multiple options), clarification (needs clarification)
  intent: 'single' | 'multiple' | 'clarification';
}

export interface AiDecision {
  mode: 'answer' | 'command' | 'inspect_then_command' | 'clarification';
  intent: 'single' | 'multiple' | 'clarification';
  responseText: string;
  command?: string;
  options: AICommandOption[];
  riskLevel: DangerLevel;
  reasoningSummary?: string;
  retrievedMemoryIds: string[];
  sourceLabels: string[];
}

export interface TerminalContext {
  currentDir: string;
  recentCommands: CommandHistory[];
  sessionState: SessionState;
  memoryContext?: MemoryContext;
}

export interface MemoryContext {
  frequentCommands: { command: string; description: string; usageCount: number }[];
  recentChatSummary: string[];
}

export interface CommandHistory {
  command: string;
  output: string;
  exitCode: number;
  timestamp: number;
  source?: CommandSource;
}

export interface CommandHistoryFile {
  serverId: string;
  entries: CommandHistory[];
  version: string;
}

export interface SessionState {
  connectedServer?: string;
  isConnected: boolean;
}

export interface ServerInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'private_key';
}

export interface AddServerRequest {
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method: AuthMethodInput;
}

export interface EditServerRequest extends AddServerRequest {
  id: string;
}

export interface AuthMethodInput {
  type: 'Password' | 'PrivateKey';
  password?: string;
  key_data?: string;
  passphrase?: string;
}

export interface CommandResult {
  success: boolean;
  output?: CommandOutput;
  error?: string;
  requires_confirmation?: boolean;
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
  is_dangerous: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  content: string;
  sourceLabel?: string;
  command?: string;
  explanation?: string;
  isDangerous?: boolean;
  dangerLevel?: DangerLevel;
  options?: AICommandOption[];
  timestamp: number;
}

export interface ChatHistoryEntry {
  id: string;
  serverId: string;
  role: 'user' | 'ai';
  content: string;
  sourceLabel?: string;
  command?: string;
  explanation?: string;
  dangerLevel: DangerLevel;
  options?: AICommandOption[];
  timestamp: number;
}

export interface CommandCard {
  id: string;
  serverId: string;
  naturalLanguage: string;
  command: string;
  description: string;
  dangerLevel: DangerLevel;
  category: CommandCategory;
  usageCount: number;
  createdAt: number;
  lastUsed: number;
}

export interface ExecutionExperience {
  id: string;
  serverId: string;
  userIntent: string;
  suggestedCommand?: string;
  finalCommand: string;
  userModified: boolean;
  currentDir?: string;
  stdoutSummary: string;
  stderrSummary: string;
  exitCode?: number;
  success: boolean;
  failureKind?: string;
  riskLevel: DangerLevel;
  source: string;
  createdAt: number;
}

export interface MemoryItem {
  id: string;
  kind: 'task' | 'environment' | 'preference' | 'failure_case' | 'success_case' | string;
  summary: string;
  tags: string[];
  serverId?: string;
  relatedCommand?: string;
  score: number;
  createdAt: number;
  updatedAt: number;
}

export interface RecordExecutionFeedbackRequest {
  serverId: string;
  userIntent: string;
  suggestedCommand?: string;
  finalCommand: string;
  currentDir?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  source?: string;
  riskLevel?: DangerLevel;
}

export interface DiskUsage {
  filesystem: string;
  size: string;
  used: string;
  available: string;
  usePercent: number;
  mountedOn: string;
}

export interface MemoryUsage {
  total: string;
  used: string;
  free: string;
  available: string;
  usePercent: number;
}

export interface NetworkStats {
  interface: string;
  rxBytes: number;
  txBytes: number;
  rxSpeed: number;
  txSpeed: number;
}

export interface ListeningProcess {
  program: string;
  pid: number;
  port: number;
  protocol: string;
}

export interface ServerStatus {
  disk: DiskUsage[];
  memory: MemoryUsage;
  network: NetworkStats[];
  processes: ListeningProcess[];
}

export type LayoutMode = 'sidebar-terminal' | 'all' | 'terminal-ai' | 'terminal-fullscreen';

export interface ServerTab {
  id: string;
  serverId: string;
  serverName: string;
  currentDir: string;
  previousDir?: string;
}

export interface PendingAiTerminalExecution {
  id: string;
  userIntent: string;
  suggestedCommand: string;
  finalCommand: string;
  currentDir: string;
}

export interface RemoteEntry {
  name: string;
  path: string;
  entryType: 'file' | 'directory' | 'symlink';
  size: number | null;
  modifiedAt: number | null;
  permissions: number | null;
  isTextEditable: boolean;
}

export interface RemoteDirectoryPayload {
  currentPath: string;
  parentPath: string | null;
  entries: RemoteEntry[];
}

export interface RemoteFileContent {
  path: string;
  content: string;
  encoding: string;
  size: number;
  isReadonly: boolean;
}

export interface BuiltinCommand {
  name: string;
  description: string;
  category: string;
  surface?: 'shell' | 'chat';
  parameters: Parameter[];
  examples: Example[];
  scenarios: string[];
}

export interface Parameter {
  flag: string;
  description: string;
}

export interface Example {
  command: string;
  description: string;
}

export interface CommandDatabase {
  version: string;
  commands: BuiltinCommand[];
}

export interface ServerBanner {
  hostname: string;
  os_info: string;
  distro_info: string;
  disk_usage: string;
  memory_usage: string;
  uptime_info: string;
  last_login: string;
  timestamp: string;
}
