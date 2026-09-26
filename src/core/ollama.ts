import { applyMemoryTool } from './memory-doc.js';
import { buildSystemInstruction, extractMood, toSpeakableText } from './prompt.js';
import type { ChatMessage, ChatReply, MemoryOpSummary } from '@shared/types';

/**
 * A local model, through Ollama.
 *
 * This is the free, offline route: no Google account, no Cloud project, no
 * quota and nothing leaving the machine. Rin runs on whatever model the user
 * has pulled. It speaks the same `ChatReply` contract as the Gemini client, so
 * every screen, the memory tools and the mood-driven animation work unchanged.
 *
 * The one thing it cannot do is transcription — Ollama has no audio input — so
 * push-to-talk still needs Gemini. The UI says so rather than failing quietly.
 */

export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

export interface OllamaContext {
  host: string;
  model: string;
  temperature: number;
  persona: string;
  memory: string;
  saveMemory: (markdown: string) => Promise<void> | void;
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

interface OllamaChatResponse {
  message?: OllamaMessage;
  error?: string;
}

/** Same three tools the Gemini path offers, in Ollama's schema. */
const MEMORY_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        'Save a new durable fact to your long-term memory file. Use for things that will still matter next week.',
      parameters: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            description:
              'Which heading to file it under: "About the user", "Preferences", "Projects", "Decisions" or "Notes".',
          },
          text: {
            type: 'string',
            description: 'The fact, as one short self-contained sentence in the third person.',
          },
        },
        required: ['section', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_memory',
      description: 'Rewrite an existing memory line that has become wrong or out of date.',
      parameters: {
        type: 'object',
        properties: {
          match: { type: 'string', description: 'Distinctive text from the line to replace.' },
          replacement: { type: 'string', description: 'The corrected sentence.' },
        },
        required: ['match', 'replacement'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forget',
      description: 'Delete a memory line, for example when the user asks you to forget something.',
      parameters: {
        type: 'object',
        properties: {
          match: { type: 'string', description: 'Distinctive text from the line to delete.' },
        },
        required: ['match'],
      },
    },
  },
];

const MAX_HISTORY_TURNS = 24;
const MAX_TOOL_ROUNDS = 4;

function normaliseHost(host: string): string {
  const trimmed = (host || DEFAULT_OLLAMA_HOST).trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
}

async function post(host: string, path: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${normaliseHost(host)}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(
      `Could not reach Ollama at ${normaliseHost(host)} (${(error as Error).message}). ` +
        'Check that it is running — `ollama serve` — and that the address in Settings is right.',
    );
  }
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `Ollama does not have that model. Pull it first, for example: ollama pull llama3.2`,
      );
    }
    throw new Error(`Ollama returned ${response.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

export async function chat(
  userText: string,
  history: ChatMessage[],
  context: OllamaContext,
): Promise<ChatReply> {
  let memory = context.memory;
  const memoryOps: MemoryOpSummary[] = [];

  const messages: OllamaMessage[] = [
    { role: 'system', content: buildSystemInstruction(context.persona, memory) },
    ...history.slice(-MAX_HISTORY_TURNS).map((message) => ({
      role: message.role === 'user' ? ('user' as const) : ('assistant' as const),
      content: message.text,
    })),
    { role: 'user', content: userText },
  ];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const response = (await post(context.host, '/api/chat', {
      model: context.model,
      messages,
      tools: MEMORY_TOOLS,
      stream: false,
      options: { temperature: context.temperature },
    })) as OllamaChatResponse;

    if (response.error) throw new Error(`Ollama: ${response.error}`);
    const reply = response.message;
    const calls = reply?.tool_calls ?? [];

    if (calls.length === 0 || round === MAX_TOOL_ROUNDS) {
      const raw = (reply?.content ?? '').trim();
      if (!raw) throw new Error('The local model returned an empty reply.');
      const { text, emotion } = extractMood(raw);
      return { text, speech: toSpeakableText(text), emotion, memoryOps };
    }

    messages.push({ role: 'assistant', content: reply?.content ?? '', tool_calls: calls });

    let touched = false;
    for (const call of calls) {
      // Smaller local models sometimes hand back the arguments as a JSON string.
      let args = call.function.arguments as unknown;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      const edit = applyMemoryTool(memory, call.function.name, (args ?? {}) as Record<string, unknown>);
      memory = edit.markdown;
      touched = touched || edit.changed;
      memoryOps.push(edit.summary);
      messages.push({ role: 'tool', content: edit.summary.detail || 'done' });
    }
    if (touched) await context.saveMemory(memory);
  }

  throw new Error('The local model kept calling tools without answering.');
}

export interface OllamaModel {
  id: string;
  label: string;
}

/** Lists the models the user has already pulled. */
export async function listModels(host: string): Promise<OllamaModel[]> {
  const base = normaliseHost(host);
  let response: Response;
  try {
    response = await fetch(`${base}/api/tags`);
  } catch (error) {
    throw new Error(
      `Could not reach Ollama at ${base} (${(error as Error).message}). Is it running?`,
    );
  }
  if (!response.ok) throw new Error(`Ollama returned ${response.status} listing models.`);
  const parsed = (await response.json()) as { models?: Array<{ name?: string; size?: number }> };
  return (parsed.models ?? [])
    .map((model) => model.name)
    .filter((name): name is string => Boolean(name))
    .sort()
    .map((name) => ({ id: name, label: name }));
}
