import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { loadSettings, saveSettings } from './storage';
import type { AssetStatus, CatalogEntry, DownloadProgress } from '@shared/types';

/**
 * Avatar and animation storage on Android.
 *
 * The VRM is ~15-18 MB, which is too much to bake into an APK that also has to
 * ship a WebView bundle, so the same catalog the desktop build uses is fetched
 * into app storage on first run. Files are handed to the WebView through
 * `Capacitor.convertFileSrc`, which is the mobile equivalent of the desktop
 * build's private asset protocol.
 */

interface CatalogModel {
  id: string;
  name: string;
  description: string;
  license: string;
  licenseVerified: boolean;
  credit: string;
  sourceUrl: string;
  fox: boolean;
  file: string;
  approxBytes?: number;
  mirrors: string[];
}

interface Catalog {
  foxPreferenceOrder: string[];
  defaultModelId: string;
  fallbackModelId: string;
  models: CatalogModel[];
  animationPack: { clips: Array<{ name: string; file: string; url: string }> };
}

const MODELS_DIR = 'assets/models';
const ANIMATIONS_DIR = 'assets/animations';

let catalogCache: Catalog | null = null;

export async function catalog(): Promise<Catalog> {
  if (catalogCache) return catalogCache;
  const response = await fetch('defaults/model-catalog.json');
  if (!response.ok) throw new Error('Bundled model catalog is missing.');
  catalogCache = (await response.json()) as Catalog;
  return catalogCache;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Filesystem.stat({ path, directory: Directory.Data });
    return true;
  } catch {
    return false;
  }
}

async function uriFor(path: string): Promise<string> {
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Data });
  return Capacitor.convertFileSrc(uri);
}

/** A VRM/VRMA is a glTF container; every valid file starts with "glTF". */
function looksLikeGltf(bytes: Uint8Array): boolean {
  return (
    bytes.length > 12 &&
    bytes[0] === 0x67 &&
    bytes[1] === 0x6c &&
    bytes[2] === 0x54 &&
    bytes[3] === 0x46
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function download(
  url: string,
  path: string,
  onProgress?: (received: number, total: number | null) => void,
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || null;

  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress?.(received, total);
    }
  } else {
    const buffer = new Uint8Array(await response.arrayBuffer());
    chunks.push(buffer);
    received = buffer.length;
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  if (!looksLikeGltf(body)) {
    // Gateways answer with an HTML error page under a 200 status often enough
    // that the status code alone is not evidence.
    throw new Error('the download was not a VRM file');
  }

  await Filesystem.writeFile({
    path,
    directory: Directory.Data,
    data: toBase64(body),
    recursive: true,
  });
}

export async function assetStatus(): Promise<AssetStatus> {
  const cat = await catalog();
  const settings = await loadSettings();

  const animations: Array<{ name: string; path: string }> = [];
  for (const clip of cat.animationPack.clips) {
    const path = `${ANIMATIONS_DIR}/${clip.file}`;
    if (await exists(path)) animations.push({ name: clip.name, path: await uriFor(path) });
  }

  const chosen = settings.avatar.modelPath;
  const order = [
    ...cat.foxPreferenceOrder,
    cat.defaultModelId,
    ...cat.models.filter((m) => m.fox).map((m) => m.id),
    cat.fallbackModelId,
  ];

  let entry: CatalogModel | null = null;
  if (chosen) entry = cat.models.find((m) => m.file === chosen) ?? null;
  // The stand-in is a fallback, not a choice: never let it outrank a real
  // avatar that has since been installed.
  if (entry && entry.id === cat.fallbackModelId) entry = null;
  if (!entry) {
    for (const id of order) {
      const candidate = cat.models.find((m) => m.id === id);
      if (candidate && (await exists(`${MODELS_DIR}/${candidate.file}`))) {
        entry = candidate;
        break;
      }
    }
  }

  const modelPath = entry ? await uriFor(`${MODELS_DIR}/${entry.file}`) : null;
  return {
    modelPath,
    modelName: entry?.name ?? null,
    animations,
    assetsDir: 'app storage',
    usingFallback: entry ? !entry.fox : false,
  };
}

export async function catalogEntries(): Promise<CatalogEntry[]> {
  const cat = await catalog();
  const installedFiles = new Set<string>();
  for (const model of cat.models) {
    if (await exists(`${MODELS_DIR}/${model.file}`)) installedFiles.add(model.file);
  }
  return cat.models.map((model) => ({
    id: model.id,
    name: model.name,
    description: model.description,
    license: model.license,
    licenseVerified: model.licenseVerified,
    credit: model.credit,
    sourceUrl: model.sourceUrl,
    fox: model.fox,
    url: model.mirrors[0] ?? '',
    installed: installedFiles.has(model.file),
    approxBytes: model.approxBytes,
  }));
}

export async function installModel(
  id: string,
  onProgress: (progress: DownloadProgress) => void,
): Promise<AssetStatus> {
  const cat = await catalog();
  const entry = cat.models.find((m) => m.id === id);
  if (!entry) throw new Error(`Unknown model "${id}".`);

  // Already downloaded: just select it, so choosing an avatar works offline
  // and nothing is fetched twice.
  if (await exists(`${MODELS_DIR}/${entry.file}`)) {
    const settings = await loadSettings();
    settings.avatar.modelPath = entry.file;
    await saveSettings(settings);
    onProgress({ id, receivedBytes: 0, totalBytes: null, done: true });
    return assetStatus();
  }

  const failures: string[] = [];
  for (const url of entry.mirrors) {
    try {
      await download(url, `${MODELS_DIR}/${entry.file}`, (received, total) =>
        onProgress({ id, receivedBytes: received, totalBytes: total, done: false }),
      );
      const settings = await loadSettings();
      settings.avatar.modelPath = entry.file;
      await saveSettings(settings);
      onProgress({ id, receivedBytes: 0, totalBytes: null, done: true });
      return assetStatus();
    } catch (error) {
      let host = url;
      try {
        host = new URL(url).host;
      } catch {
        /* keep the raw url */
      }
      failures.push(`${host}: ${(error as Error).message}`);
    }
  }
  const message = `Could not download ${entry.name}. Tried ${entry.mirrors.length} mirror(s) — ${failures.join('; ')}.`;
  onProgress({ id, receivedBytes: 0, totalBytes: null, done: true, error: message });
  throw new Error(message);
}

/**
 * First-run provisioning: fetch the animation clips and an avatar. Reports
 * progress so the companion screen can say what it is waiting for.
 */
export async function ensureAssets(
  onProgress: (progress: DownloadProgress) => void,
): Promise<AssetStatus> {
  const cat = await catalog();

  for (const clip of cat.animationPack.clips) {
    const path = `${ANIMATIONS_DIR}/${clip.file}`;
    if (await exists(path)) continue;
    try {
      await download(clip.url, path);
      onProgress({ id: `anim:${clip.name}`, receivedBytes: 1, totalBytes: 1, done: true });
    } catch (error) {
      // One missing clip degrades an expression; it must not stop startup.
      onProgress({
        id: `anim:${clip.name}`,
        receivedBytes: 0,
        totalBytes: null,
        done: true,
        error: (error as Error).message,
      });
    }
  }

  const current = await assetStatus();
  if (current.modelPath) return current;

  const order = [...cat.foxPreferenceOrder, cat.fallbackModelId];
  for (const id of order) {
    try {
      return await installModel(id, onProgress);
    } catch {
      // Try the next source; they are on independent hosts.
    }
  }
  return assetStatus();
}
