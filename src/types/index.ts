export interface AIProvider {
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

export interface TerminalContext {
  currentDir: string;
  recentCommands: CommandHistory[];
  sessionState: SessionState;
}

export interface CommandHistory {
  command: string;
  output: string;
  exitCode: number;
  timestamp: number;
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
  command?: string;
  explanation?: string;
  isDangerous?: boolean;
  timestamp: number;
}

export interface LearningDataEntry {
  id: string;
  natural_language: string;
  command: string;
  server_os: string;
  usage_count: number;
  last_used: number;
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

export interface ServerTab {
  id: string;
  serverId: string;
  serverName: string;
  currentDir: string;
}

export interface BuiltinCommand {
  name: string;
  description: string;
  category: string;
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
