#!/usr/bin/env node
/**
 * Makes sure Electron's prebuilt binary is actually on disk.
 *
 * Electron 44 dropped its `postinstall` hook: `npm install` no longer fetches
 * the ~100 MB platform binary, and instead `require('electron')` downloads it
 * lazily on first use. electron-vite never goes through that path — it reads
 * `node_modules/electron/path.txt` directly and throws a bare
 * `Error: Electron uninstall` when the file is absent. The result is that
 * `npm run dev` fails immediately after a perfectly successful install, with an
 * error that says nothing about what to do.
 *
 * So we restore the old behaviour ourselves: after install, and again before
 * `npm run dev`, check for the binary and fetch it if it is missing.
 *
 * This never fails the build. Someone installing only to work on the Android
 * shell, or to run the tests, does not need a 100 MB desktop binary, and an
 * offline install should still leave a usable checkout. Set
 * `KITSUNE_SKIP_ELECTRON` to skip the download outright.
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

function electronModuleDir() {
  try {
    // Resolve the package.json rather than the entry point: requiring
    // electron's index.js from Node would itself trigger the lazy download.
    return dirname(require.resolve('electron/package.json'));
  } catch {
    return null;
  }
}

function main() {
  // An Android-only build has no use for a 100 MB desktop binary, and the CI
  // job that produces the APK sets this rather than spending the download.
  if (process.env['KITSUNE_SKIP_ELECTRON']) {
    console.log('[electron] KITSUNE_SKIP_ELECTRON set; skipping the binary.');
    return;
  }

  const moduleDir = electronModuleDir();
  if (moduleDir === null) {
    console.log('[electron] not installed; skipping (fine for Android-only or test-only work).');
    return;
  }

  const pathFile = join(moduleDir, 'path.txt');
  if (existsSync(pathFile)) {
    return; // Already there; say nothing.
  }

  const installer = join(moduleDir, 'install.js');
  if (!existsSync(installer)) {
    console.warn('[electron] no install.js found; cannot fetch the binary automatically.');
    return;
  }

  console.log('[electron] binary missing — downloading it (~100 MB, once)…');
  const result = spawnSync(process.execPath, [installer], { stdio: 'inherit' });

  if (result.status === 0 && existsSync(pathFile)) {
    console.log('[electron] binary installed.');
    return;
  }

  console.warn(
    '\n[electron] Could not download the Electron binary.\n' +
      '  The desktop app (npm run dev / npm run package:win) will not start until it is present.\n' +
      '  Everything else — tests, and the Android build — works without it.\n' +
      '\n' +
      '  To retry:      node node_modules/electron/install.js\n' +
      '  Behind a proxy or a blocked CDN, point npm at a mirror, for example:\n' +
      '                 set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/\n' +
      '                 node node_modules/electron/install.js\n',
  );
}

main();
