import { getAccessToken } from '../auth/google-oauth.js';
import { loadSettings } from '../store/settings.js';
import { readMemory, readPersona, writeMemory } from '../store/documents.js';
import { chat as coreChat, listModels as coreListModels } from '../../core/chat.js';
import {
  endpointFor,
  transcribe as coreTranscribe,
  type ChatContext,
  type GeminiContext,
  type ModelOption,
} from '../../core/gemini.js';
import type { ChatMessage, ChatReply } from '@shared/types';

export { endpointFor };
export type { ModelOption };

/**
 * Desktop binding for the shared Gemini client: supplies the OAuth token from
 * the encrypted credential store and persona/memory from disk. All request
 * logic lives in core so the Android shell behaves identically.
 */
function context(): GeminiContext {
  return { settings: loadSettings().gemini, getAccessToken };
}

function chatContext(): ChatContext {
  return {
    ...context(),
    persona: readPersona().text,
    memory: readMemory().markdown,
    saveMemory: (markdown) => {
      writeMemory(markdown);
    },
  };
}

export function chat(userText: string, history: ChatMessage[]): Promise<ChatReply> {
  return coreChat(userText, history, chatContext());
}

export function transcribe(audio: ArrayBuffer, mimeType: string): Promise<string> {
  return coreTranscribe(audio, mimeType, context());
}

export function listModels(): Promise<ModelOption[]> {
  return coreListModels(context());
}
