import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A throwaway directory standing in for the app's user-data folder. */
const sandbox = mkdtempSync(join(tmpdir(), 'kitsune-test-'));

/**
 * The install directory. It is the repository by default, so tests see the
 * avatar that really ships; a test that needs a bare install points it
 * somewhere empty instead.
 */
let appPath = process.cwd();
export function setAppPath(path: string): void {
  appPath = path;
}

export const app = {
  getPath: (): string => sandbox,
  getAppPath: (): string => appPath,
  isPackaged: false,
};

export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (value: string): Buffer => Buffer.from(value, 'utf8'),
  decryptString: (value: Buffer): string => value.toString('utf8'),
};

export const shell = { openExternal: async (): Promise<void> => undefined };
export const ipcMain = { handle: (): void => undefined };
export const dialog = {};
export const protocol = { registerSchemesAsPrivileged: (): void => undefined };
export const net = {};
export const session = {};
export const BrowserWindow = class {};
