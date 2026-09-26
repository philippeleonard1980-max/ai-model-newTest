import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAppPath } from './electron-stub';
import {
  assetStatus,
  catalogEntries,
  installModel,
  useLocalModel,
} from '../src/main/assets/manager';
import { loadSettings, saveSettings } from '../src/main/store/settings';
import { userAssetsDir } from '../src/main/store/paths';

/** Smallest thing that passes the glTF magic-byte check. */
function writeStubVrm(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const header = Buffer.alloc(20);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20, 8);
  writeFileSync(path, header);
}

function clearChosenModel(): void {
  const settings = loadSettings();
  settings.avatar.modelPath = null;
  saveSettings(settings);
}

/** Pretend the app was installed without its bundled avatars. */
function withoutBundledAvatars(): void {
  setAppPath(mkdtempSync(join(tmpdir(), 'kitsune-bare-')));
}

beforeEach(() => {
  clearChosenModel();
});

afterEach(() => {
  setAppPath(process.cwd());
});

describe('assetStatus — usingFallback', () => {
  it('does not flag a model the user chose themselves', () => {
    // A fox downloaded from VRoid Hub has no catalog entry, but choosing it is
    // deliberate — the companion screen must not call it a stand-in.
    const path = join(userAssetsDir(), 'models', 'my-own-fox.vrm');
    writeStubVrm(path);
    useLocalModel(path);

    const status = assetStatus();
    expect(status.modelPath).toBe(path);
    expect(status.usingFallback).toBe(false);
  });

  it('flags the catalog fallback, which really is a stand-in', () => {
    withoutBundledAvatars();
    const fallback = catalogEntries().find((entry) => !entry.fox);
    expect(fallback).toBeDefined();
    const models = join(userAssetsDir(), 'models');
    if (existsSync(models)) rmSync(models, { recursive: true, force: true });
    const path = join(models, 'vroid-sample-girl.vrm');
    writeStubVrm(path);
    useLocalModel(path);

    expect(assetStatus().usingFallback).toBe(true);
  });

  it('lets the bundled fox win over a pinned stand-in', () => {
    // The stand-in is what the app falls back to, never something anyone picks.
    // Leaving it pinned is how an install that later gains a real avatar ends
    // up showing the stand-in for ever.
    const standIn = join(userAssetsDir(), 'models', 'vroid-sample-girl.vrm');
    writeStubVrm(standIn);
    useLocalModel(standIn);

    const status = assetStatus();
    expect(status.modelPath).not.toBe(standIn);
    expect(status.usingFallback).toBe(false);
  });

  it('does not flag a catalog fox', () => {
    const path = join(userAssetsDir(), 'models', 'megan-the-fox.vrm');
    writeStubVrm(path);
    useLocalModel(path);

    const status = assetStatus();
    expect(status.modelName).toBe('Megan the Fox');
    expect(status.usingFallback).toBe(false);
  });

  it('reports no fallback when there is no avatar at all', () => {
    const models = join(userAssetsDir(), 'models');
    if (existsSync(models)) rmSync(models, { recursive: true, force: true });
    clearChosenModel();

    const status = assetStatus();
    if (status.modelPath === null) expect(status.usingFallback).toBe(false);
  });
});

describe('useLocalModel', () => {
  it('rejects a file that is not a .vrm', () => {
    const path = join(userAssetsDir(), 'models', 'notes.txt');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'hello');
    expect(() => useLocalModel(path)).toThrow(/not a \.vrm/i);
  });

  it('rejects a path that does not exist', () => {
    expect(() => useLocalModel(join(userAssetsDir(), 'models', 'missing.vrm'))).toThrow(/no file/i);
  });
});

describe('catalogEntries', () => {
  it('exposes the fox flag and licence provenance the picker renders', () => {
    for (const entry of catalogEntries()) {
      expect(typeof entry.fox).toBe('boolean');
      expect(typeof entry.licenseVerified).toBe('boolean');
      expect(typeof entry.installed).toBe('boolean');
      expect(entry.sourceUrl).toMatch(/^https:\/\//);
    }
  });

  it('marks the bundled avatar as already installed', () => {
    const bundled = catalogEntries().find((entry) => entry.installed);
    expect(bundled, 'the default avatar ships with the app').toBeDefined();
  });
});

describe('installModel', () => {
  it('selects an avatar that is already on disk without downloading it', async () => {
    // The bundled fox has a mirror URL, but choosing her must work with no
    // network at all — otherwise an offline user cannot pick her back.
    const bundled = catalogEntries().find((entry) => entry.installed);
    expect(bundled).toBeDefined();

    const fetchSpy = (): never => {
      throw new Error('installModel must not reach the network for a local file');
    };
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const path = await installModel(bundled!.id, () => undefined);
      expect(existsSync(path)).toBe(true);
      expect(assetStatus().modelName).toBe(bundled!.name);
    } finally {
      globalThis.fetch = original;
    }
  });
});
