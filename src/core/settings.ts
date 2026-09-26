import type { AppSettings } from '@shared/types';

export const DEFAULT_SETTINGS: AppSettings = {
  gemini: {
    backend: 'generativelanguage',
    // Overridable in the settings screen; the model list can also be refreshed
    // live from the API so this default going stale is never fatal.
    model: 'gemini-flash-latest',
    location: 'global',
    temperature: 0.9,
    maxOutputTokens: 2048,
  },
  voice: {
    speak: true,
    voiceURI: null,
    rate: 1.05,
    pitch: 1.15,
    volume: 1,
  },
  avatar: {
    modelPath: null,
    framing: 'upper',
    lookAtCursor: true,
  },
};

/** Deep-merges stored settings over the defaults so new keys appear on upgrade. */
export function mergeSettings(stored: unknown): AppSettings {
  const base: AppSettings = structuredClone(DEFAULT_SETTINGS);
  if (!stored || typeof stored !== 'object') return base;
  const s = stored as Partial<AppSettings>;
  const avatar = { ...base.avatar, ...(s.avatar ?? {}) };
  // Older installs stored fixed camera coordinates, which framed exactly one
  // model correctly. Drop them in favour of a framing preset.
  delete (avatar as Record<string, unknown>)['cameraHeight'];
  delete (avatar as Record<string, unknown>)['cameraDistance'];
  if (avatar.framing !== 'full' && avatar.framing !== 'upper' && avatar.framing !== 'face') {
    avatar.framing = base.avatar.framing;
  }

  return {
    gemini: { ...base.gemini, ...(s.gemini ?? {}) },
    voice: { ...base.voice, ...(s.voice ?? {}) },
    avatar,
  };
}
