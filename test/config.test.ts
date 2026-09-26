import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/main/store/settings';
import { endpointFor } from '../src/main/ai/gemini';
import { assetUrl, ASSET_SCHEME } from '../src/shared/ipc';
import { EMOTIONS, isEmotion } from '../src/shared/types';

describe('mergeSettings', () => {
  it('returns defaults for junk input', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings('nonsense')).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps stored values and fills in keys added by an upgrade', () => {
    const merged = mergeSettings({ gemini: { model: 'gemini-custom' } });
    expect(merged.gemini.model).toBe('gemini-custom');
    expect(merged.gemini.backend).toBe(DEFAULT_SETTINGS.gemini.backend);
    expect(merged.voice.rate).toBe(DEFAULT_SETTINGS.voice.rate);
  });

  it('does not share structure with the defaults object', () => {
    const merged = mergeSettings({});
    merged.gemini.model = 'mutated';
    expect(DEFAULT_SETTINGS.gemini.model).not.toBe('mutated');
  });
});

describe('endpointFor', () => {
  const base = DEFAULT_SETTINGS.gemini;

  it('targets the OAuth-friendly Gemini API by default', () => {
    const url = endpointFor({ ...base, model: 'gemini-flash-latest' }, 'generateContent');
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
    );
  });

  it('tolerates a model id that already carries the models/ prefix', () => {
    const url = endpointFor({ ...base, model: 'models/gemini-flash-latest' }, 'generateContent');
    expect(url).toContain('/models/gemini-flash-latest:generateContent');
    expect(url).not.toContain('models/models/');
  });

  it('builds a regional Vertex URL', () => {
    const url = endpointFor(
      { ...base, backend: 'vertex', projectId: 'my-proj', location: 'us-central1' },
      'generateContent',
    );
    expect(url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-central1/publishers/google/models/gemini-flash-latest:generateContent',
    );
  });

  it('uses the unprefixed host for the global Vertex location', () => {
    const url = endpointFor(
      { ...base, backend: 'vertex', projectId: 'my-proj', location: 'global' },
      'generateContent',
    );
    expect(url).toContain('https://aiplatform.googleapis.com/');
    expect(url).toContain('/locations/global/');
  });

  it('refuses Vertex without a project id, with an actionable message', () => {
    expect(() => endpointFor({ ...base, backend: 'vertex' }, 'generateContent')).toThrow(
      /project ID/i,
    );
  });

  it('never puts a key in the URL — auth is the OAuth bearer header', () => {
    const url = endpointFor(base, 'generateContent');
    expect(url).not.toMatch(/[?&]key=/);
  });
});

describe('assetUrl', () => {
  it('produces a URL on the private asset scheme', () => {
    expect(assetUrl('/home/u/assets/models/a.vrm')).toBe(
      `${ASSET_SCHEME}://local/home/u/assets/models/a.vrm`,
    );
  });

  it('normalises Windows separators', () => {
    expect(assetUrl('C:\\Users\\Sam\\a.vrm')).toBe(`${ASSET_SCHEME}://local/C%3A/Users/Sam/a.vrm`);
  });

  it('escapes spaces and other characters that would break the URL', () => {
    expect(assetUrl('/tmp/My Models/fox girl.vrm')).toContain('My%20Models/fox%20girl.vrm');
  });
});

describe('emotion vocabulary', () => {
  it('recognises every declared emotion and rejects others', () => {
    for (const emotion of EMOTIONS) expect(isEmotion(emotion)).toBe(true);
    expect(isEmotion('incandescent')).toBe(false);
    expect(isEmotion(undefined)).toBe(false);
  });
});

describe('model catalog', () => {
  const catalog = JSON.parse(readFileSync('resources/model-catalog.json', 'utf8')) as {
    defaultModelId: string;
    fallbackModelId: string;
    models: Array<{ id: string; file: string; mirrors: string[]; fox: boolean; license: string }>;
    animationPack: { clips: Array<{ name: string; file: string; url: string }> };
  };

  it('points its default and fallback ids at real entries', () => {
    const ids = catalog.models.map((model) => model.id);
    expect(ids).toContain(catalog.defaultModelId);
    expect(ids).toContain(catalog.fallbackModelId);
  });

  it('defaults to a fox and falls back to something that always downloads', () => {
    const preferred = catalog.models.find((m) => m.id === catalog.defaultModelId);
    const fallback = catalog.models.find((m) => m.id === catalog.fallbackModelId);
    expect(preferred?.fox).toBe(true);
    expect(fallback?.mirrors[0]).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
  });

  it('gives every model a redistributable licence and at least one mirror', () => {
    for (const model of catalog.models) {
      expect(model.license).toMatch(/^CC0/);
      expect(model.mirrors.length).toBeGreaterThan(0);
      for (const mirror of model.mirrors) expect(mirror).toMatch(/^https:\/\//);
    }
  });

  it('uses unique ids and unique filenames', () => {
    const ids = catalog.models.map((m) => m.id);
    const files = catalog.models.map((m) => m.file);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(files).size).toBe(files.length);
  });

  it('ships an idle clip plus a clip for every emotion the model can pick', () => {
    const clips = new Set(catalog.animationPack.clips.map((clip) => clip.name));
    expect(clips.has('idle')).toBe(true);
    // 'neutral' deliberately maps onto idle rather than having its own clip.
    for (const emotion of EMOTIONS) {
      if (emotion === 'neutral') continue;
      expect(clips.has(emotion), `missing animation clip for "${emotion}"`).toBe(true);
    }
  });

  it('serves every animation over https', () => {
    for (const clip of catalog.animationPack.clips) {
      expect(clip.url).toMatch(/^https:\/\//);
      expect(clip.file).toMatch(/\.vrma$/);
    }
  });
});
