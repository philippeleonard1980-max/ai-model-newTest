import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { chat, listModels } from '../src/core/ollama';

/**
 * Drives the local-model path against a stand-in Ollama.
 *
 * Ollama cannot be installed in CI, but its HTTP surface is two endpoints, so
 * the interesting behaviour — the tool loop, the memory writes, the shapes
 * smaller models actually return — is all reachable with a fake server. Without
 * this the whole backend was unexercised.
 */

let server: Server | null = null;

/** Starts a fake Ollama that replies with `turns` in order. */
async function fakeOllama(turns: unknown[], tags: unknown = { models: [] }): Promise<string> {
  let turn = 0;
  server = createServer((request, response) => {
    if (request.url === '/api/tags') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(tags));
      return;
    }
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const payload = turns[Math.min(turn++, turns.length - 1)];
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

afterEach(() => {
  server?.close();
  server = null;
});

function context(host: string, saved: string[]): Parameters<typeof chat>[2] {
  return {
    host,
    model: 'llama3.2',
    temperature: 0.8,
    persona: 'You are Rin, a seven-tailed kitsune.',
    memory: '# Memory\n\n## About the user\n\n- Lives in Montreal.\n',
    saveMemory: (markdown) => {
      saved.push(markdown);
    },
  };
}

describe('the local model backend', () => {
  it('answers, and carries the mood tag out of the reply', async () => {
    const host = await fakeOllama([
      { message: { role: 'assistant', content: 'Seven tails, at your service. [mood: proud]' } },
    ]);
    const reply = await chat('hello', [], context(host, []));
    expect(reply.text).toBe('Seven tails, at your service.');
    expect(reply.emotion).toBe('proud');
    expect(reply.memoryOps).toEqual([]);
  });

  it('runs the memory tools and saves the file', async () => {
    const saved: string[] = [];
    const host = await fakeOllama([
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              function: {
                name: 'remember',
                arguments: { section: 'Preferences', text: 'Prefers tea to coffee.' },
              },
            },
          ],
        },
      },
      { message: { role: 'assistant', content: 'Noted. [mood: happy]' } },
    ]);

    const reply = await chat('I prefer tea', [], context(host, saved));
    expect(reply.text).toBe('Noted.');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toContain('Prefers tea to coffee.');
    // The original line must survive the edit.
    expect(saved[0]).toContain('Lives in Montreal.');
    expect(reply.memoryOps.map((op) => op.op)).toEqual(['remember']);
  });

  it('copes with a model that returns tool arguments as a JSON string', async () => {
    // Smaller local models do this, and it is the difference between the memory
    // working and every call silently doing nothing.
    const saved: string[] = [];
    const host = await fakeOllama([
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              function: {
                name: 'remember',
                arguments: '{"section":"Notes","text":"Ships on Fridays."}' as unknown as Record<string, unknown>,
              },
            },
          ],
        },
      },
      { message: { role: 'assistant', content: 'Filed. [mood: neutral]' } },
    ]);

    await chat('we ship on fridays', [], context(host, saved));
    expect(saved[0]).toContain('Ships on Fridays.');
  });

  it('surfaces an error the server reports rather than a blank reply', async () => {
    const host = await fakeOllama([{ error: 'model "llama3.2" not found, try pulling it first' }]);
    await expect(chat('hi', [], context(host, []))).rejects.toThrow(/not found/);
  });

  it('refuses an empty reply instead of showing a blank bubble', async () => {
    const host = await fakeOllama([{ message: { role: 'assistant', content: '   ' } }]);
    await expect(chat('hi', [], context(host, []))).rejects.toThrow(/empty reply/i);
  });

  it('stops rather than looping for ever on a model that only calls tools', async () => {
    const saved: string[] = [];
    const host = await fakeOllama([
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'remember', arguments: { section: 'Notes', text: 'x' } } }],
        },
      },
    ]);
    // The last turn repeats, so the only way out is the round cap.
    await expect(chat('hi', [], context(host, saved))).rejects.toThrow(/without answering|empty reply/i);
  });

  it('lists the models that are pulled', async () => {
    const host = await fakeOllama([], {
      models: [{ name: 'qwen2.5:7b' }, { name: 'llama3.2:latest' }],
    });
    expect(await listModels(host)).toEqual([
      { id: 'llama3.2:latest', label: 'llama3.2:latest' },
      { id: 'qwen2.5:7b', label: 'qwen2.5:7b' },
    ]);
  });

  it('says Ollama is unreachable, with the address, when nothing is listening', async () => {
    // Port 1 is never an Ollama; the message has to name the address so a wrong
    // host in Settings is obvious.
    await expect(listModels('http://127.0.0.1:1')).rejects.toThrow(/Could not reach Ollama at http:\/\/127\.0\.0\.1:1/);
  });

  it('accepts a bare host and fills the scheme in', async () => {
    const host = await fakeOllama([], { models: [{ name: 'a' }] });
    const bare = host.replace('http://', '');
    expect(await listModels(bare)).toEqual([{ id: 'a', label: 'a' }]);
  });
});
