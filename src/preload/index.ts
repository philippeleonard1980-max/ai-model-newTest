import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@shared/ipc';
import type { KitsuneApi, ModelOption } from '@shared/api';
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
  Result,
} from '@shared/types';

/** Unwraps the Result envelope so callers can use try/catch normally. */
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as Result<T>;
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

const api = {
  auth: {
    state: () => call<AuthState>(IPC.authState),
    signIn: () => call<AuthState>(IPC.authSignIn),
    signOut: () => call<AuthState>(IPC.authSignOut),
    getClient: () => call<OAuthClientConfig | null>(IPC.authGetClient),
    setClient: (config: OAuthClientConfig) => call<AuthState>(IPC.authSetClient, config),
  },
  settings: {
    get: () => call<AppSettings>(IPC.settingsGet),
    set: (settings: AppSettings) => call<AppSettings>(IPC.settingsSet, settings),
  },
  persona: {
    get: () => call<PersonaFile>(IPC.personaGet),
    set: (text: string) => call<PersonaFile>(IPC.personaSet, text),
    reset: () => call<PersonaFile>(IPC.personaReset),
  },
  memory: {
    get: () => call<MemoryFile>(IPC.memoryGet),
    set: (markdown: string) => call<MemoryFile>(IPC.memorySet, markdown),
  },
  chat: {
    send: (text: string, history: ChatMessage[]) => call<ChatReply>(IPC.chatSend, text, history),
    transcribe: (audio: ArrayBuffer, mimeType: string) =>
      call<string>(IPC.chatTranscribe, audio, mimeType),
    models: () => call<ModelOption[]>(IPC.chatModels),
  },
  assets: {
    status: () => call<AssetStatus>(IPC.assetsStatus),
    catalog: () => call<CatalogEntry[]>(IPC.assetsCatalog),
    install: (id: string) => call<AssetStatus>(IPC.assetsInstall, id),
    pickLocal: () => call<AssetStatus | null>(IPC.assetsPickLocal),
    onProgress: (listener: (progress: DownloadProgress) => void) => {
      const handler = (_event: unknown, progress: DownloadProgress): void => listener(progress);
      ipcRenderer.on(IPC.assetsProgress, handler);
      return (): void => {
        ipcRenderer.removeListener(IPC.assetsProgress, handler);
      };
    },
  },
  shell: {
    openPath: (path: string) => call<void>(IPC.shellOpenPath, path),
    openExternal: (url: string) => call<void>(IPC.shellOpenExternal, url),
  },
} satisfies KitsuneApi;

contextBridge.exposeInMainWorld('kitsune', api);
