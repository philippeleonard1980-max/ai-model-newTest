import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { bundledAssetsDir, userAssetsDir, resourcesDir, ensureDir } from '../store/paths.js';
import { loadSettings, saveSettings } from '../store/settings.js';
import type { AssetStatus, CatalogEntry, DownloadProgress } from '@shared/types';

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
  /** Which foxes to prefer, best first, when nothing is explicitly chosen. */
  foxPreferenceOrder: string[];
  defaultModelId: string;
  fallbackModelId: string;
  models: CatalogModel[];
  animationPack: { clips: Array<{ name: string; file: string; url: string }> };
}

let catalogCache: Catalog | null = null;

export function catalog(): Catalog {
  if (catalogCache) return catalogCache;
  catalogCache = JSON.parse(
    readFileSync(join(resourcesDir(), 'model-catalog.json'), 'utf8'),
  ) as Catalog;
  return catalogCache;
}

/**
 * Asset lookup order: whatever the user downloaded into their data directory
 * wins, then whatever shipped with the install. This lets an installed app add
 * models without write access to Program Files.
 */
function searchRoots(): string[] {
  return [userAssetsDir(), bundledAssetsDir()].filter((dir) => existsSync(dir));
}

function findFile(kind: 'models' | 'animations', file: string): string | null {
  for (const root of searchRoots()) {
    const candidate = join(root, kind, file);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function listFiles(kind: 'models' | 'animations', extension: string): string[] {
  const seen = new Map<string, string>();
  for (const root of searchRoots()) {
    const dir = join(root, kind);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.toLowerCase().endsWith(extension)) continue;
      if (!seen.has(entry)) seen.set(entry, join(dir, entry));
    }
  }
  return [...seen.values()];
}

/** Resolves the VRM to show: the user's explicit choice, else the best installed. */
export function resolveModelPath(): { path: string | null; entry: CatalogModel | null } {
  const chosen = loadSettings().avatar.modelPath;
  if (chosen && existsSync(chosen)) {
    const entry = catalog().models.find((model) => basename(chosen) === model.file) ?? null;
    return { path: chosen, entry };
  }

  const preferenceOrder = [
    ...catalog().foxPreferenceOrder,
    catalog().defaultModelId,
    ...catalog().models.filter((model) => model.fox).map((model) => model.id),
    catalog().fallbackModelId,
  ];
  for (const id of preferenceOrder) {
    const entry = catalog().models.find((model) => model.id === id);
    if (!entry) continue;
    const path = findFile('models', entry.file);
    if (path) return { path, entry };
  }

  // Any stray .vrm the user dropped into the assets folder by hand.
  const loose = listFiles('models', '.vrm')[0];
  return { path: loose ?? null, entry: null };
}

export function animationFiles(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const clip of catalog().animationPack.clips) {
    const path = findFile('animations', clip.file);
    if (path) map[clip.name] = path;
  }
  return map;
}

export function assetStatus(): AssetStatus {
  const { path, entry } = resolveModelPath();
  return {
    modelPath: path,
    modelName: entry?.name ?? (path ? basename(path) : null),
    animations: Object.entries(animationFiles()).map(([name, path]) => ({ name, path })),
    assetsDir: userAssetsDir(),
    usingFallback: entry ? !entry.fox : path !== null,
  };
}

export function catalogEntries(): CatalogEntry[] {
  return catalog().models.map((model) => ({
    id: model.id,
    name: model.name,
    description: model.description,
    license: model.license,
    licenseVerified: model.licenseVerified,
    credit: model.credit,
    sourceUrl: model.sourceUrl,
    fox: model.fox,
    url: model.mirrors[0] ?? '',
    approxBytes: model.approxBytes,
  }));
}

/** True when the given catalog model is already on disk. */
export function isInstalled(id: string): boolean {
  const entry = catalog().models.find((model) => model.id === id);
  return Boolean(entry && findFile('models', entry.file));
}

function looksLikeGltf(buffer: Buffer): boolean {
  return buffer.length > 12 && buffer.subarray(0, 4).toString('ascii') === 'glTF';
}

/**
 * Downloads a catalog model into the user assets directory, reporting progress.
 * Writes to a temporary file and renames on success so a failed download can
 * never leave a truncated .vrm behind.
 */
export async function installModel(
  id: string,
  onProgress: (progress: DownloadProgress) => void,
): Promise<string> {
  const entry = catalog().models.find((model) => model.id === id);
  if (!entry) throw new Error(`Unknown model "${id}".`);

  const targetDir = ensureDir(join(userAssetsDir(), 'models'));
  const target = join(targetDir, entry.file);
  const temporary = `${target}.part`;
  const failures: string[] = [];

  for (const url of entry.mirrors) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const total = Number(response.headers.get('content-length')) || entry.approxBytes || null;

      const chunks: Buffer[] = [];
      let received = 0;
      if (response.body) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          const buffer = Buffer.from(chunk);
          chunks.push(buffer);
          received += buffer.length;
          onProgress({ id, receivedBytes: received, totalBytes: total, done: false });
        }
      } else {
        const buffer = Buffer.from(await response.arrayBuffer());
        chunks.push(buffer);
        received = buffer.length;
      }

      const body = Buffer.concat(chunks);
      if (!looksLikeGltf(body)) {
        // Gateways often answer with an HTML error page under a 200 status.
        throw new Error('the download was not a VRM file');
      }

      mkdirSync(targetDir, { recursive: true });
      writeFileSync(temporary, body);
      if (existsSync(target)) rmSync(target);
      renameSync(temporary, target);

      onProgress({ id, receivedBytes: received, totalBytes: total, done: true });

      // Make the freshly installed model the active one.
      const settings = loadSettings();
      settings.avatar.modelPath = target;
      saveSettings(settings);
      return target;
    } catch (error) {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
      failures.push(`${safeHost(url)}: ${(error as Error).message}`);
    }
  }

  const message = `Could not download ${entry.name}. Tried ${entry.mirrors.length} mirror(s) — ${failures.join('; ')}.`;
  onProgress({ id, receivedBytes: 0, totalBytes: null, done: true, error: message });
  throw new Error(message);
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Points the app at an arbitrary .vrm the user picked from disk. */
export function useLocalModel(path: string): AssetStatus {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`No file at ${path}`);
  }
  if (!path.toLowerCase().endsWith('.vrm')) {
    throw new Error('That is not a .vrm file.');
  }
  const settings = loadSettings();
  settings.avatar.modelPath = path;
  saveSettings(settings);
  return assetStatus();
}
