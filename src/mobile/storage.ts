import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { mergeSettings } from '../core/settings';
import type { AppSettings, MemoryFile, PersonaFile } from '@shared/types';

/**
 * Android storage. Persona and memory stay real Markdown files in the app's
 * documents directory — same contract as the desktop build, so they can be
 * pulled off the device and read or edited as ordinary text. Settings are small
 * and structured, so they live in Preferences.
 */

const DIRECTORY = Directory.Data;
const PERSONA_PATH = 'persona.md';
const MEMORY_PATH = 'memory.md';
const SETTINGS_KEY = 'settings';

/** Defaults are bundled with the web assets and copied out on first run. */
async function fetchDefault(name: string): Promise<string> {
  const response = await fetch(`defaults/${name}`);
  if (!response.ok) throw new Error(`Missing bundled default: ${name}`);
  return response.text();
}

async function readOrSeed(path: string, defaultName: string): Promise<string> {
  try {
    const file = await Filesystem.readFile({ path, directory: DIRECTORY, encoding: Encoding.UTF8 });
    return typeof file.data === 'string' ? file.data : '';
  } catch {
    // First run, or the user deleted it.
    const seed = await fetchDefault(defaultName);
    await Filesystem.writeFile({
      path,
      directory: DIRECTORY,
      encoding: Encoding.UTF8,
      data: seed,
      recursive: true,
    });
    return seed;
  }
}

async function write(path: string, data: string): Promise<void> {
  await Filesystem.writeFile({
    path,
    directory: DIRECTORY,
    encoding: Encoding.UTF8,
    data,
    recursive: true,
  });
}

/** Shown in the UI so the user knows where the file actually is. */
async function describe(path: string): Promise<string> {
  try {
    const { uri } = await Filesystem.getUri({ path, directory: DIRECTORY });
    return uri;
  } catch {
    return path;
  }
}

export async function readPersona(): Promise<PersonaFile> {
  const text = await readOrSeed(PERSONA_PATH, 'default-persona.md');
  let isDefault = false;
  try {
    isDefault = text === (await fetchDefault('default-persona.md'));
  } catch {
    /* the comparison is cosmetic */
  }
  return { text, path: await describe(PERSONA_PATH), isDefault };
}

export async function writePersona(text: string): Promise<PersonaFile> {
  await write(PERSONA_PATH, text);
  return readPersona();
}

export async function resetPersona(): Promise<PersonaFile> {
  return writePersona(await fetchDefault('default-persona.md'));
}

export async function readMemory(): Promise<MemoryFile> {
  const markdown = await readOrSeed(MEMORY_PATH, 'default-memory.md');
  return { markdown, path: await describe(MEMORY_PATH) };
}

export async function writeMemory(markdown: string): Promise<MemoryFile> {
  await write(MEMORY_PATH, markdown);
  return readMemory();
}

let settingsCache: AppSettings | null = null;

export async function loadSettings(): Promise<AppSettings> {
  if (settingsCache) return settingsCache;
  try {
    const { value } = await Preferences.get({ key: SETTINGS_KEY });
    settingsCache = mergeSettings(value ? JSON.parse(value) : null);
  } catch {
    settingsCache = mergeSettings(null);
  }
  return settingsCache;
}

export async function saveSettings(next: AppSettings): Promise<AppSettings> {
  settingsCache = mergeSettings(next);
  await Preferences.set({ key: SETTINGS_KEY, value: JSON.stringify(settingsCache) });
  return settingsCache;
}
