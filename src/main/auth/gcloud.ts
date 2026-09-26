import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Drives the Google Cloud CLI so the user does not have to.
 *
 * One command — `gcloud auth application-default login` — replaces the entire
 * manual route: creating a Cloud project, configuring a consent screen,
 * creating an OAuth client and pasting its ID. It opens the browser, the user
 * picks their Google account, and gcloud writes the credentials file we read.
 */

/** Where the Windows installer puts it, for when it is not on PATH. */
const WINDOWS_FALLBACKS = [
  'C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd',
  'C:\\Program Files\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd',
];

function candidateNames(): string[] {
  // On Windows the executable is a .cmd shim; spawn will not find it without
  // the extension unless we go through a shell, which we would rather not.
  return process.platform === 'win32' ? ['gcloud.cmd', 'gcloud.exe', 'gcloud'] : ['gcloud'];
}

/** Locates gcloud on PATH, or in the default install directory on Windows. */
export function findGcloud(): string | null {
  const path = process.env['PATH'] ?? '';
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const name of candidateNames()) {
      const candidate = join(dir, name);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        /* unreadable PATH entry */
      }
    }
  }
  if (process.platform === 'win32') {
    for (const candidate of WINDOWS_FALLBACKS) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function gcloudInstalled(): boolean {
  return findGcloud() !== null;
}

/** Where to send someone who does not have it yet. */
export const GCLOUD_INSTALL_URL = 'https://cloud.google.com/sdk/docs/install';

export interface GcloudRun {
  ok: boolean;
  output: string;
}

/**
 * Runs a gcloud subcommand. `login` opens a browser and blocks until the user
 * finishes, so the timeout is generous; everything else is quick.
 */
export function runGcloud(args: string[], timeoutMs = 5 * 60_000): Promise<GcloudRun> {
  const binary = findGcloud();
  if (!binary) {
    return Promise.resolve({
      ok: false,
      output: `The Google Cloud CLI is not installed. Get it from ${GCLOUD_INSTALL_URL}`,
    });
  }

  return new Promise((resolve) => {
    let output = '';
    let settled = false;

    const child = spawn(binary, args, {
      // A .cmd shim needs a shell on Windows; elsewhere we avoid one so the
      // arguments are never re-parsed.
      shell: process.platform === 'win32',
      windowsHide: true,
      env: { ...process.env },
    });

    const finish = (ok: boolean, extra = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, output: (output + extra).trim() });
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(false, '\nTimed out waiting for gcloud.');
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      // gcloud writes its progress and its browser URL to stderr.
      output += chunk.toString();
    });
    child.on('error', (error) => finish(false, `\n${error.message}`));
    child.on('close', (code) => finish(code === 0));
  });
}

/** Opens the browser and writes Application Default Credentials. */
export function loginApplicationDefault(): Promise<GcloudRun> {
  return runGcloud(['auth', 'application-default', 'login', '--quiet']);
}
