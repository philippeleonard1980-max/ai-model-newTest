import { Browser } from '@capacitor/browser';
import { chat as coreChat, listModels as coreListModels } from '../core/chat';
import { transcribe as coreTranscribe, type ChatContext, type GeminiContext } from '../core/gemini';
import { getAccessToken, getAuthState, getClientConfig, setClientConfig, signIn, signOut } from './google-auth';
import { assetStatus, catalogEntries, installModel } from './assets';
import {
  loadSettings,
  readMemory,
  readPersona,
  resetPersona,
  saveSettings,
  writeMemory,
  writePersona,
} from './storage';
import type { KitsuneApi } from '@shared/api';
import type { AppSettings, ChatMessage, DownloadProgress } from '@shared/types';

/**
 * The Android implementation of the exact API the desktop preload exposes.
 *
 * The renderer only ever talks to `window.kitsune`, so reproducing that surface
 * here is what lets both platforms share every screen, the 3D stage and the
 * animation logic without a single conditional in the UI.
 */

async function geminiContext(): Promise<GeminiContext> {
  const settings = await loadSettings();
  return { settings: settings.gemini, getAccessToken };
}

async function chatContext(): Promise<ChatContext> {
  const [base, persona, memory] = await Promise.all([
    geminiContext(),
    readPersona(),
    readMemory(),
  ]);
  return {
    ...base,
    persona: persona.text,
    memory: memory.markdown,
    saveMemory: async (markdown) => {
      await writeMemory(markdown);
    },
  };
}

type ProgressListener = (progress: DownloadProgress) => void;
const progressListeners = new Set<ProgressListener>();

/** Lets first-run provisioning report through the same channel the UI listens on. */
export function emitProgress(progress: DownloadProgress): void {
  for (const listener of progressListeners) listener(progress);
}

export const mobileApi = {
  auth: {
    state: () => getAuthState(),
    signIn: () => signIn(),
    signOut: () => signOut(),
    getClient: async () => getClientConfig(),
    setClient: () => setClientConfig(),
    // Android's Play Services flow is already one tap, so there is nothing to
    // automate and no CLI to look for.
    capability: async () => ({ hasAdc: false, hasGcloud: false, gcloudInstallUrl: '' }),
    autoSetup: () => signIn(),
    onSetupStep: () => () => undefined,
  },
  settings: {
    get: () => loadSettings(),
    set: (settings: AppSettings) => saveSettings(settings),
  },
  persona: {
    get: () => readPersona(),
    set: (text: string) => writePersona(text),
    reset: () => resetPersona(),
  },
  memory: {
    get: () => readMemory(),
    set: (markdown: string) => writeMemory(markdown),
  },
  chat: {
    send: async (text: string, history: ChatMessage[]) =>
      coreChat(text, history, await chatContext()),
    transcribe: async (audio: ArrayBuffer, mimeType: string) =>
      coreTranscribe(audio, mimeType, await geminiContext()),
    models: async () => coreListModels(await geminiContext()),
  },
  assets: {
    status: () => assetStatus(),
    catalog: () => catalogEntries(),
    install: (id: string) => installModel(id, emitProgress),
    // There is no file picker on Android; avatars come from the catalog or a
    // download. Returning null leaves the current avatar untouched.
    pickLocal: async () => null,
    onProgress: (listener: ProgressListener) => {
      progressListeners.add(listener);
      return () => {
        progressListeners.delete(listener);
      };
    },
  },
  shell: {
    // "Open file" has no meaning on Android; the path shown is informational.
    openPath: async () => undefined,
    openExternal: async (url: string) => {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('Refusing to open a non-web link.');
      }
      await Browser.open({ url: parsed.toString() });
    },
  },
} satisfies KitsuneApi;
