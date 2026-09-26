#!/usr/bin/env node
/**
 * Downloads the 3D avatar and the VRMA animation clips into ./assets.
 *
 * Runs automatically after `npm install`, and can be re-run by hand:
 *
 *   npm run assets           # fetch anything missing
 *   npm run assets:force     # re-fetch everything
 *
 * Assets are deliberately not committed to the repository: the avatar alone is
 * ~18 MB, and the upstream files are public-domain downloads rather than our
 * source. Nothing here is generated or modelled by the app — the avatar is an
 * existing CC0 model that gets installed.
 *
 * The script is resilient by design. The animation pack and the fallback
 * avatar come from GitHub; the fox avatars come from Arweave mirrors. If the
 * fox download fails on a restricted network, the fallback still lands and the
 * app runs — you can install the fox later from the Settings screen.
 */

import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const assetsDir = join(root, 'assets');
const modelsDir = join(assetsDir, 'models');
const animationsDir = join(assetsDir, 'animations');

const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const ifMissing = args.has('--if-missing');
/** In CI or an offline build, a failed asset fetch must not fail the install. */
const lenient = ifMissing || args.has('--lenient');

const DOWNLOAD_TIMEOUT_MS = 180_000;

function human(bytes) {
  if (bytes === null || bytes === undefined) return 'unknown size';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** A VRM/VRMA is a glTF binary container; every valid file starts with "glTF". */
function looksLikeGltf(buffer) {
  return buffer.length > 12 && buffer.subarray(0, 4).toString('ascii') === 'glTF';
}

async function download(url, destination, { expectGltf = true } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) throw new Error('empty response');
    if (expectGltf && !looksLikeGltf(buffer)) {
      // Gateways love to answer with an HTML error page and a 200 status.
      throw new Error(`not a glTF/VRM file (starts with ${JSON.stringify(buffer.subarray(0, 16).toString('utf8'))})`);
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, buffer);
    return buffer.length;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithMirrors(label, mirrors, destination) {
  if (!force && existsSync(destination)) {
    const { size } = await stat(destination);
    console.log(`  = ${label} already present (${human(size)})`);
    return { ok: true, skipped: true };
  }
  const failures = [];
  for (const url of mirrors) {
    try {
      process.stdout.write(`  . ${label} <- ${new URL(url).host} ... `);
      const size = await download(url, destination);
      console.log(`ok (${human(size)})`);
      return { ok: true };
    } catch (error) {
      console.log(`failed (${error.message})`);
      failures.push(`${new URL(url).host}: ${error.message}`);
    }
  }
  return { ok: false, failures };
}

async function main() {
  const catalog = JSON.parse(await readFile(join(root, 'resources', 'model-catalog.json'), 'utf8'));
  await mkdir(modelsDir, { recursive: true });
  await mkdir(animationsDir, { recursive: true });

  console.log('\nAnimations (VRMA)');
  const animationFailures = [];
  for (const clip of catalog.animationPack.clips) {
    const result = await fetchWithMirrors(clip.name, [clip.url], join(animationsDir, clip.file));
    if (!result.ok) animationFailures.push(clip.name);
  }

  console.log('\nAvatar');
  const byId = new Map(catalog.models.map((model) => [model.id, model]));
  const preferred = byId.get(catalog.defaultModelId);
  const fallback = byId.get(catalog.fallbackModelId);

  let installedFox = false;
  if (preferred) {
    const result = await fetchWithMirrors(
      `${preferred.name} (fox)`,
      preferred.mirrors,
      join(modelsDir, preferred.file),
    );
    installedFox = result.ok;
    if (!result.ok) {
      console.log(`  ! Could not reach any mirror for ${preferred.name}.`);
    }
  }

  let haveFallback = false;
  if (fallback && fallback.id !== preferred?.id) {
    const result = await fetchWithMirrors(
      `${fallback.name}`,
      fallback.mirrors,
      join(modelsDir, fallback.file),
    );
    haveFallback = result.ok;
  }

  console.log('\nSummary');
  if (installedFox) {
    console.log(`  Fox avatar installed: ${preferred.name} (${preferred.license}).`);
  } else if (haveFallback) {
    console.log('  Fox avatar unavailable on this network; the fallback avatar was installed.');
    console.log('  Open Settings -> Avatar in the app to retry the fox download, or point it at any local .vrm.');
  } else {
    console.log('  No avatar could be downloaded. Open Settings -> Avatar in the app to retry or choose a file.');
  }
  if (animationFailures.length > 0) {
    console.log(`  Animations missing: ${animationFailures.join(', ')}.`);
  } else {
    console.log(`  All ${catalog.animationPack.clips.length} animation clips installed.`);
  }
  console.log(`  Assets directory: ${assetsDir}\n`);

  const hardFailure = !installedFox && !haveFallback;
  if (hardFailure && !lenient) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nAsset download failed: ${error.message}\n`);
  if (!lenient) process.exitCode = 1;
});
