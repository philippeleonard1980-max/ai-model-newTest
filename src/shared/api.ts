import type {
  AppSettings,
  AssetStatus,
  AuthState,
  CatalogEntry,
  ChatMessage,
  ChatReply,
  DownloadProgress,
  MemoryFile,
  OAuthClientConfig,
  PersonaFile,
} from './types';

export interface ModelOption {
  id: string;
  label: string;
}

/**
 * Everything the UI is allowed to ask of the platform.
 *
 * This is the seam that lets one React app run as a Windows desktop program and
 * as an Android app: the desktop shell implements it over Electron IPC, the
 * Android shell over Capacitor plugins, and no screen knows which it is talking
 * to. Both implementations are declared `satisfies KitsuneApi`, so if one of
 * them drifts from the other the build fails rather than the app.
 */
export interface KitsuneApi {
  auth: {
    state(): Promise<AuthState>;
    signIn(): Promise<AuthState>;
    signOut(): Promise<AuthState>;
    getClient(): Promise<OAuthClientConfig | null>;
    /**
     * Desktop asks the user for an OAuth client ID. Android identifies the app
     * by its signing certificate instead, so there it is a no-op.
     */
    setClient(config: OAuthClientConfig): Promise<AuthState>;
  };
  settings: {
    get(): Promise<AppSettings>;
    set(settings: AppSettings): Promise<AppSettings>;
  };
  persona: {
    get(): Promise<PersonaFile>;
    set(text: string): Promise<PersonaFile>;
    reset(): Promise<PersonaFile>;
  };
  memory: {
    get(): Promise<MemoryFile>;
    set(markdown: string): Promise<MemoryFile>;
  };
  chat: {
    send(text: string, history: ChatMessage[]): Promise<ChatReply>;
    transcribe(audio: ArrayBuffer, mimeType: string): Promise<string>;
    models(): Promise<ModelOption[]>;
  };
  assets: {
    status(): Promise<AssetStatus>;
    catalog(): Promise<CatalogEntry[]>;
    install(id: string): Promise<AssetStatus>;
    /** Returns null when the platform has no file picker, or the user cancels. */
    pickLocal(): Promise<AssetStatus | null>;
    /** Returns an unsubscribe function. */
    onProgress(listener: (progress: DownloadProgress) => void): () => void;
  };
  shell: {
    /** Reveals a local file. A no-op where the concept does not apply. */
    openPath(path: string): Promise<void>;
    openExternal(url: string): Promise<void>;
  };
}

declare global {
  interface Window {
    kitsune: KitsuneApi;
  }
}
