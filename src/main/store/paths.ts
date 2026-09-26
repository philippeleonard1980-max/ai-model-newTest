import { app } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

/**
 * All writable state lives under Electron's per-user data directory
 * (`%APPDATA%/Kitsune Companion` on Windows) so the install directory stays
 * read-only and the app survives an upgrade without losing memory.
 */
export function userDataDir(): string {
  return app.getPath('userData');
}

/**
 * Read-only files shipped inside the package. electron-builder packs
 * `resources/` into app.asar, and Electron's patched `fs` reads straight out of
 * the archive, so the same path works packaged and unpackaged.
 */
export function resourcesDir(): string {
  return join(app.getAppPath(), 'resources');
}

/**
 * Where VRM models and VRMA clips live. Bundled assets ship next to the app;
 * anything the user downloads later goes into their data directory so an
 * upgrade does not wipe it.
 */
export function bundledAssetsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'assets')
    : join(app.getAppPath(), 'assets');
}

export function userAssetsDir(): string {
  return ensureDir(join(userDataDir(), 'assets'));
}

export function personaPath(): string {
  return join(userDataDir(), 'persona.md');
}

export function memoryPath(): string {
  return join(userDataDir(), 'memory.md');
}

export function settingsPath(): string {
  return join(userDataDir(), 'settings.json');
}

export function credentialsPath(): string {
  return join(userDataDir(), 'credentials.bin');
}

export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
