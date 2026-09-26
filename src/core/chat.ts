import { chat as geminiChat, listModels as geminiModels, type ChatContext, type GeminiContext, type ModelOption } from './gemini.js';
import { chat as ollamaChat, listModels as ollamaModels, DEFAULT_OLLAMA_HOST } from './ollama.js';
import type { ChatMessage, ChatReply } from '@shared/types';

/**
 * Picks the provider for a turn.
 *
 * Both shells call through here, so adding a provider never means touching the
 * UI or either platform adapter.
 */
export async function chat(
  userText: string,
  history: ChatMessage[],
  context: ChatContext,
): Promise<ChatReply> {
  if (context.settings.backend !== 'ollama') {
    return geminiChat(userText, history, context);
  }
  return ollamaChat(userText, history, {
    host: context.settings.ollamaHost ?? DEFAULT_OLLAMA_HOST,
    model: context.settings.ollamaModel ?? 'llama3.2',
    temperature: context.settings.temperature,
    persona: context.persona,
    memory: context.memory,
    saveMemory: context.saveMemory,
  });
}

export async function listModels(context: GeminiContext): Promise<ModelOption[]> {
  if (context.settings.backend !== 'ollama') return geminiModels(context);
  return ollamaModels(context.settings.ollamaHost ?? DEFAULT_OLLAMA_HOST);
}

/** Transcription is Gemini-only; Ollama has no audio input. */
export function supportsVoiceInput(backend: string): boolean {
  return backend !== 'ollama';
}
