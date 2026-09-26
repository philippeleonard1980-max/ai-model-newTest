/**
 * Types shared between the Electron main process, the preload bridge and the
 * renderer. Keep this file free of runtime imports from either side.
 */

/** Which Google backend serves `generateContent`. Both use the same OAuth token. */
export type GeminiBackend = 'generativelanguage' | 'vertex';

/** Which credential the app is currently using. */
export type AuthMethod = 'adc' | 'oauth-client';

export interface SetupStep {
  id: 'credentials' | 'project' | 'api' | 'verify';
  label: string;
  state: 'running' | 'done' | 'failed';
  detail?: string;
  /** A page that helps with this step, opened in the real browser. */
  helpUrl?: string;
}

export interface SetupCapability {
  /** True when Application Default Credentials are already on disk. */
  hasAdc: boolean;
  /** True when the Google Cloud CLI can be run. */
  hasGcloud: boolean;
  gcloudInstallUrl: string;
}

export interface AuthState {
  signedIn: boolean;
  /** Null when not signed in. */
  method: AuthMethod | null;
  email: string | null;
  /** Epoch millis at which the current access token expires. */
  expiresAt: number | null;
  /** True once an OAuth client ID has been configured. */
  clientConfigured: boolean;
}

export interface OAuthClientConfig {
  clientId: string;
  /** Google marks desktop-app client secrets as non-confidential; optional. */
  clientSecret?: string;
}

export interface GeminiSettings {
  backend: GeminiBackend;
  model: string;
  /** Vertex only. */
  projectId?: string;
  /** Vertex only, e.g. `global` or `us-central1`. */
  location?: string;
  temperature: number;
  maxOutputTokens: number;
}

export interface VoiceSettings {
  /** Speak replies aloud through the system voice. */
  speak: boolean;
  /** `speechSynthesis` voice URI, or null to auto-pick. */
  voiceURI: string | null;
  rate: number;
  pitch: number;
  volume: number;
}

export interface AvatarSettings {
  /** Absolute path to the active .vrm file, or null to use the bundled default. */
  modelPath: string | null;
  /** Vertical framing offset applied to the camera target. */
  cameraHeight: number;
  cameraDistance: number;
  /** Follow the mouse cursor with head and eyes. */
  lookAtCursor: boolean;
}

export interface AppSettings {
  gemini: GeminiSettings;
  voice: VoiceSettings;
  avatar: AvatarSettings;
}

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  /** Epoch millis. */
  at: number;
  /** Emotion the model chose for this reply; drives the VRM animation. */
  emotion?: Emotion;
  /** Memory operations the model performed while producing this reply. */
  memoryOps?: MemoryOpSummary[];
}

/**
 * The emotion vocabulary the model may choose from. Each maps to a VRMA clip
 * and a VRM expression preset.
 */
export const EMOTIONS = [
  'neutral',
  'happy',
  'thinking',
  'surprised',
  'sad',
  'angry',
  'sleepy',
  'blush',
  'proud',
  'playful',
  'curious',
  'farewell',
] as const;

export type Emotion = (typeof EMOTIONS)[number];

export function isEmotion(value: unknown): value is Emotion {
  return typeof value === 'string' && (EMOTIONS as readonly string[]).includes(value);
}

export interface MemoryOpSummary {
  op: 'remember' | 'update' | 'forget';
  section: string;
  detail: string;
}

export interface ChatRequest {
  text: string;
  /** Prior turns, oldest first. The main process trims this to fit context. */
  history: ChatMessage[];
}

export interface ChatReply {
  /** Markdown shown in the transcript. */
  text: string;
  /** The same reply flattened for the speech synthesiser. */
  speech: string;
  emotion: Emotion;
  memoryOps: MemoryOpSummary[];
}

export interface TranscriptionRequest {
  /** Raw audio bytes (webm/opus from MediaRecorder). */
  audio: ArrayBuffer;
  mimeType: string;
}

export interface PersonaFile {
  /** The editable persona text shown in the personality box. */
  text: string;
  /** Absolute path on disk, shown to the user. */
  path: string;
  /** True when the file is still the shipped default. */
  isDefault: boolean;
}

export interface MemoryFile {
  markdown: string;
  path: string;
}

export interface AssetStatus {
  /** Absolute path to the resolved VRM, or null when none is installed. */
  modelPath: string | null;
  modelName: string | null;
  /** VRMA clips found on disk, keyed by emotion-ish clip name. */
  animations: Array<{ name: string; path: string }>;
  assetsDir: string;
  /** True when the active model is the offline fallback rather than a fox. */
  usingFallback: boolean;
}

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  license: string;
  /**
   * True only where the licence came from a machine-readable source. Where it
   * is false the UI points at `sourceUrl` instead of asserting terms we have
   * not actually read.
   */
  licenseVerified: boolean;
  credit: string;
  /** Page describing the model and its terms. */
  sourceUrl: string;
  /** Whether this avatar is a fox, which is what Rin is written to be. */
  fox: boolean;
  url: string;
  /** Approximate download size in bytes, for progress display. */
  approxBytes?: number;
}

export interface DownloadProgress {
  id: string;
  receivedBytes: number;
  totalBytes: number | null;
  done: boolean;
  error?: string;
}

/** Result envelope used by every IPC call so the renderer never sees a throw. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
