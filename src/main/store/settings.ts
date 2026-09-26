import { readFileSync, writeFileSync } from 'node:fs';
import { settingsPath } from './paths.js';
import { DEFAULT_SETTINGS, mergeSettings } from '../../core/settings.js';
import type { AppSettings } from '@shared/types';

export { DEFAULT_SETTINGS, mergeSettings };

let cache: AppSettings | null = null;

export function loadSettings(): AppSettings {
  if (cache) return cache;
  try {
    cache = mergeSettings(JSON.parse(readFileSync(settingsPath(), 'utf8')));
  } catch {
    cache = structuredClone(DEFAULT_SETTINGS);
  }
  return cache;
}

export function saveSettings(next: AppSettings): AppSettings {
  cache = mergeSettings(next);
  writeFileSync(settingsPath(), JSON.stringify(cache, null, 2), 'utf8');
  return cache;
}
