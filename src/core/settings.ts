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
    cameraHeight: 1.32,
    cameraDistance: 1.9,
    lookAtCursor: true,
  },
};

/** Deep-merges stored settings over the defaults so new keys appear on upgrade. */
export function mergeSettings(stored: unknown): AppSettings {
  const base: AppSettings = structuredClone(DEFAULT_SETTINGS);
  if (!stored || typeof stored !== 'object') return base;
  const s = stored as Partial<AppSettings>;
  return {
    gemini: { ...base.gemini, ...(s.gemini ?? {}) },
    voice: { ...base.voice, ...(s.voice ?? {}) },
    avatar: { ...base.avatar, ...(s.avatar ?? {}) },
  };
}
