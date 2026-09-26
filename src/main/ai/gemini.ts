import { getAccessToken } from '../auth/google-oauth.js';
import { loadSettings } from '../store/settings.js';
import { readMemory, readPersona, rememberInMemory, updateInMemory, forgetFromMemory } from '../store/documents.js';
import { buildSystemInstruction, extractMood, toSpeakableText } from './prompt.js';
import type { ChatMessage, ChatReply, GeminiSettings, MemoryOpSummary } from '@shared/types';

/* ------------------------------ wire types ------------------------------ */

interface Part {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: Content;
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

/* -------------------------------- tools --------------------------------- */

const MEMORY_TOOLS = [
  {
    name: 'remember',
    description:
      'Save a new durable fact to your long-term memory file. Use for things that will still matter next week.',
    parameters: {
      type: 'OBJECT',
      properties: {
        section: {
          type: 'STRING',
          description:
            'Which heading to file it under: "About the user", "Preferences", "Projects", "Decisions" or "Notes".',
        },
        text: {
          type: 'STRING',
          description: 'The fact, written as one short self-contained sentence in the third person.',
        },
      },
      required: ['section', 'text'],
    },
  },
  {
    name: 'update_memory',
    description: 'Rewrite an existing memory line that has become wrong or out of date.',
    parameters: {
      type: 'OBJECT',
      properties: {
        match: { type: 'STRING', description: 'Distinctive text from the line to replace.' },
        replacement: { type: 'STRING', description: 'The corrected sentence.' },
      },
      required: ['match', 'replacement'],
    },
  },
  {
    name: 'forget',
    description: 'Delete a memory line, for example when the user asks you to forget something.',
    parameters: {
      type: 'OBJECT',
      properties: {
        match: { type: 'STRING', description: 'Distinctive text from the line to delete.' },
      },
      required: ['match'],
    },
  },
] as const;

function runMemoryTool(name: string, args: Record<string, unknown>): MemoryOpSummary {
  const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
  switch (name) {
    case 'remember':
      return rememberInMemory(str('section') || 'Notes', str('text'));
    case 'update_memory':
      return updateInMemory(str('match'), str('replacement'));
    case 'forget':
      return forgetFromMemory(str('match'));
    default:
      return { op: 'remember', section: '', detail: `unknown tool "${name}"` };
  }
}

/* ------------------------------- endpoints ------------------------------- */

export function endpointFor(settings: GeminiSettings, method: 'generateContent' | 'models'): string {
  const model = settings.model.replace(/^models\//, '');
  if (settings.backend === 'vertex') {
    const project = settings.projectId?.trim();
    if (!project) {
      throw new Error('Vertex AI needs a Google Cloud project ID. Set one on the Settings screen.');
    }
    const location = settings.location?.trim() || 'global';
    const host =
      location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
    const base = `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models`;
    return method === 'models' ? base : `${base}/${model}:generateContent`;
  }
  const base = 'https://generativelanguage.googleapis.com/v1beta/models';
  return method === 'models' ? base : `${base}/${model}:generateContent`;
}

async function callGemini(body: unknown, settings: GeminiSettings): Promise<GenerateContentResponse> {
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  // Billing/quota attribution for OAuth calls against the public endpoint.
  if (settings.backend === 'generativelanguage' && settings.projectId?.trim()) {
    headers['x-goog-user-project'] = settings.projectId.trim();
  }

  const response = await fetch(endpointFor(settings, 'generateContent'), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed: GenerateContentResponse;
  try {
    parsed = JSON.parse(text) as GenerateContentResponse;
  } catch {
    throw new Error(`Gemini returned a non-JSON response (${response.status}): ${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(describeApiError(response.status, parsed, settings));
  }
  return parsed;
}

function describeApiError(
  status: number,
  parsed: GenerateContentResponse,
  settings: GeminiSettings,
): string {
  const message = parsed.error?.message ?? `HTTP ${status}`;
  if (status === 401) {
    return `Google rejected the sign-in (401). Sign out and back in from Settings. Details: ${message}`;
  }
  if (status === 403) {
    const api =
      settings.backend === 'vertex' ? 'Vertex AI API (aiplatform.googleapis.com)' : 'Generative Language API';
    return `Access denied (403). Enable the ${api} in your Google Cloud project and make sure the signed-in account can use it. Details: ${message}`;
  }
  if (status === 404) {
    return `Model "${settings.model}" was not found on the ${settings.backend} backend (404). Pick another model in Settings — the list can be refreshed live. Details: ${message}`;
  }
  if (status === 429) {
    return `Rate limited (429). Wait a moment, or switch to a lighter model in Settings. Details: ${message}`;
  }
  return `Gemini request failed (${status}): ${message}`;
}

/* --------------------------------- chat ---------------------------------- */

/** Keeps the request bounded without a tokenizer: recent turns only. */
const MAX_HISTORY_TURNS = 24;

function historyToContents(history: ChatMessage[]): Content[] {
  return history.slice(-MAX_HISTORY_TURNS).map((message) => ({
    role: message.role === 'user' ? ('user' as const) : ('model' as const),
    parts: [{ text: message.text }],
  }));
}

function textFrom(content: Content | undefined): string {
  return (content?.parts ?? [])
    .map((part) => part.text ?? '')
    .join('')
    .trim();
}

function functionCallsFrom(content: Content | undefined): Array<{ name: string; args: Record<string, unknown> }> {
  return (content?.parts ?? [])
    .map((part) => part.functionCall)
    .filter((call): call is { name: string; args: Record<string, unknown> } => Boolean(call));
}

/** How many tool round trips to allow before giving up and taking the text. */
const MAX_TOOL_ROUNDS = 4;

export async function chat(userText: string, history: ChatMessage[]): Promise<ChatReply> {
  const settings = loadSettings().gemini;
  const persona = readPersona().text;
  const memory = readMemory().markdown;

  const contents: Content[] = [
    ...historyToContents(history),
    { role: 'user', parts: [{ text: userText }] },
  ];

  const memoryOps: MemoryOpSummary[] = [];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const body = {
      systemInstruction: { parts: [{ text: buildSystemInstruction(persona, memory) }] },
      contents,
      tools: [{ functionDeclarations: MEMORY_TOOLS }],
      generationConfig: {
        temperature: settings.temperature,
        maxOutputTokens: settings.maxOutputTokens,
      },
    };

    const response = await callGemini(body, settings);
    const blockReason = response.promptFeedback?.blockReason;
    if (blockReason) {
      throw new Error(`Gemini declined to answer that (${blockReason}).`);
    }

    const candidate = response.candidates?.[0];
    const content = candidate?.content;
    const calls = functionCallsFrom(content);

    if (calls.length === 0 || round === MAX_TOOL_ROUNDS) {
      const raw = textFrom(content);
      if (!raw) {
        const reason = candidate?.finishReason ?? 'no content';
        throw new Error(
          reason === 'MAX_TOKENS'
            ? 'Gemini hit the output limit before saying anything. Raise "Max output tokens" in Settings.'
            : `Gemini returned an empty reply (${reason}).`,
        );
      }
      const { text, emotion } = extractMood(raw);
      return { text, speech: toSpeakableText(text), emotion, memoryOps };
    }

    // Run every requested tool, then hand the results back for another pass.
    contents.push({ role: 'model', parts: calls.map((call) => ({ functionCall: call })) });
    const responses: Part[] = calls.map((call) => {
      const summary = runMemoryTool(call.name, call.args);
      memoryOps.push(summary);
      return {
        functionResponse: {
          name: call.name,
          response: { result: summary.detail || 'done' },
        },
      };
    });
    contents.push({ role: 'user', parts: responses });
  }

  throw new Error('Gemini kept calling tools without producing a reply.');
}

/* ----------------------------- transcription ----------------------------- */

/**
 * Sends recorded push-to-talk audio to Gemini for transcription. Reusing the
 * same multimodal endpoint means no second service and no extra credentials.
 */
export async function transcribe(audio: ArrayBuffer, mimeType: string): Promise<string> {
  const settings = loadSettings().gemini;
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              'Transcribe this audio verbatim. Reply with the transcription only — no quotes, ' +
              'no preamble, no commentary. If the audio contains no intelligible speech, reply ' +
              'with the single word NOSPEECH.',
          },
          {
            inlineData: {
              mimeType: mimeType || 'audio/webm',
              data: Buffer.from(audio).toString('base64'),
            },
          },
        ],
      },
    ],
    generationConfig: { temperature: 0, maxOutputTokens: 1024 },
  };

  const response = await callGemini(body, settings);
  const raw = textFrom(response.candidates?.[0]?.content);
  if (!raw || raw.trim().toUpperCase() === 'NOSPEECH') return '';
  return raw.trim();
}

/* ------------------------------ model listing ---------------------------- */

export interface ModelOption {
  id: string;
  label: string;
}

/** Asks the API which models this account can actually use. */
export async function listModels(): Promise<ModelOption[]> {
  const settings = loadSettings().gemini;
  const token = await getAccessToken();
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (settings.backend === 'generativelanguage' && settings.projectId?.trim()) {
    headers['x-goog-user-project'] = settings.projectId.trim();
  }

  if (settings.backend === 'vertex') {
    // Vertex has no per-project generative model listing on this endpoint, so
    // offer the documented ids and let the request itself be the check.
    return VERTEX_FALLBACK_MODELS.map((id) => ({ id, label: id }));
  }

  const response = await fetch(`${endpointFor(settings, 'models')}?pageSize=200`, { headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Could not list models (${response.status}): ${text.slice(0, 300)}`);
  }
  const parsed = JSON.parse(text) as {
    models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>;
  };
  const options = (parsed.models ?? [])
    .filter((model) => (model.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((model) => {
      const id = (model.name ?? '').replace(/^models\//, '');
      return { id, label: model.displayName ? `${model.displayName} (${id})` : id };
    })
    .filter((option) => option.id.length > 0);
  return options.sort((a, b) => a.id.localeCompare(b.id));
}

const VERTEX_FALLBACK_MODELS = [
  'gemini-flash-latest',
  'gemini-pro-latest',
  'gemini-3.8-flash',
  'gemini-3.1-pro',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
];
