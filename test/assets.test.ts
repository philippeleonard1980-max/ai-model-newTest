import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { assetStatus, catalogEntries, useLocalModel } from '../src/main/assets/manager';
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

beforeEach(() => {
  clearChosenModel();
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
    const fallback = catalogEntries().find((entry) => !entry.fox);
    expect(fallback).toBeDefined();
    const path = join(userAssetsDir(), 'models', 'vroid-sample-girl.vrm');
    writeStubVrm(path);
    useLocalModel(path);

    expect(assetStatus().usingFallback).toBe(true);
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
      expect(entry.sourceUrl).toMatch(/^https:\/\//);
    }
  });
});
