import { ipcMain, dialog, shell, type BrowserWindow } from 'electron';
import { IPC } from '@shared/ipc';
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
  SetupCapability,
} from '@shared/types';
import { hasAdc } from './auth/adc.js';
import { GCLOUD_INSTALL_URL, gcloudInstalled } from './auth/gcloud.js';
import { runAutoSetup } from './auth/autosetup.js';
import {
  getAuthState,
  getClientConfig,
  setClientConfig,
  signIn,
  signOut,
} from './auth/google-oauth.js';
import { loadSettings, saveSettings } from './store/settings.js';
import {
  readMemory,
  readPersona,
  resetPersona,
  writeMemory,
  writePersona,
} from './store/documents.js';
import { chat, listModels, transcribe, type ModelOption } from './ai/gemini.js';
import { assetStatus, catalogEntries, installModel, useLocalModel } from './assets/manager.js';

/** Wraps a handler so the renderer always receives a Result rather than a throw. */
function handle<T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<Result<T>> => {
    try {
      return { ok: true, value: await fn(...(args as never[])) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Surfaced in the UI, so it must read as advice rather than a stack trace.
      console.error(`[ipc] ${channel}:`, error);
      return { ok: false, error: message };
    }
  });
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  /* ------------------------------- auth -------------------------------- */
  handle<AuthState>(IPC.authState, () => getAuthState());
  handle<AuthState>(IPC.authSignIn, () => signIn());
  handle<AuthState>(IPC.authSignOut, () => signOut());
  handle<AuthState>(IPC.authSetClient, (config: OAuthClientConfig) => {
    if (!config?.clientId?.trim()) throw new Error('Paste the OAuth client ID first.');
    if (!/\.apps\.googleusercontent\.com\s*$/.test(config.clientId.trim())) {
      throw new Error('That does not look like a Google OAuth client ID — it should end in ".apps.googleusercontent.com".');
    }
    setClientConfig(config);
    return getAuthState();
  });
  handle<OAuthClientConfig | null>(IPC.authGetClient, () => getClientConfig());
  handle<SetupCapability>(IPC.authCapability, () => ({
    hasAdc: hasAdc(),
    hasGcloud: gcloudInstalled(),
    gcloudInstallUrl: GCLOUD_INSTALL_URL,
  }));
  handle<AuthState>(IPC.authAutoSetup, async () => {
    await runAutoSetup((step) => {
      getWindow()?.webContents.send(IPC.authSetupStep, step);
    });
    return getAuthState();
  });

  /* ----------------------------- settings ------------------------------ */
  handle<AppSettings>(IPC.settingsGet, () => loadSettings());
  handle<AppSettings>(IPC.settingsSet, (next: AppSettings) => saveSettings(next));

  /* ------------------------ persona and memory ------------------------- */
  handle<PersonaFile>(IPC.personaGet, () => readPersona());
  handle<PersonaFile>(IPC.personaSet, (text: string) => writePersona(text));
  handle<PersonaFile>(IPC.personaReset, () => resetPersona());
  handle<MemoryFile>(IPC.memoryGet, () => readMemory());
  handle<MemoryFile>(IPC.memorySet, (markdown: string) => writeMemory(markdown));

  /* -------------------------------- chat ------------------------------- */
  handle<ChatReply>(IPC.chatSend, (text: string, history: ChatMessage[]) =>
    chat(text, history ?? []),
  );
  handle<string>(IPC.chatTranscribe, (audio: ArrayBuffer, mimeType: string) =>
    transcribe(audio, mimeType),
  );
  handle<ModelOption[]>(IPC.chatModels, () => listModels());

  /* ------------------------------- assets ------------------------------ */
  handle<AssetStatus>(IPC.assetsStatus, () => assetStatus());
  handle<CatalogEntry[]>(IPC.assetsCatalog, () => catalogEntries());
  handle<AssetStatus>(IPC.assetsInstall, async (id: string) => {
    await installModel(id, (progress: DownloadProgress) => {
      getWindow()?.webContents.send(IPC.assetsProgress, progress);
    });
    return assetStatus();
  });
  handle<AssetStatus | null>(IPC.assetsPickLocal, async () => {
    const window = getWindow();
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a VRM avatar',
      filters: [{ name: 'VRM avatar', extensions: ['vrm'] }],
      properties: ['openFile'],
    });
    const picked = result.filePaths[0];
    if (result.canceled || !picked) return null;
    return useLocalModel(picked);
  });

  /* -------------------------------- shell ------------------------------ */
  handle<void>(IPC.shellOpenPath, async (path: string) => {
    await shell.openPath(path);
  });
  handle<void>(IPC.shellOpenExternal, async (url: string) => {
    // Only ever open web links, never arbitrary local commands.
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Refusing to open a non-web link.');
    }
    await shell.openExternal(parsed.toString());
  });
}
