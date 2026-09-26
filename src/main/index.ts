import { app, BrowserWindow, protocol, net, shell, session } from 'electron';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { ASSET_SCHEME } from '@shared/ipc';
import { registerIpc } from './ipc.js';
import { bundledAssetsDir, ensureDir, userAssetsDir, userDataDir } from './store/paths.js';
import { loadSettings } from './store/settings.js';

// Registered before `app.ready` so the renderer may fetch() these URLs.
protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: false } },
]);

let mainWindow: BrowserWindow | null = null;

/**
 * The renderer may only read avatar and animation files: the asset directories,
 * plus whichever single .vrm the user explicitly picked from elsewhere on disk.
 * The user-data directory as a whole is deliberately excluded — it holds the
 * encrypted credential store.
 */
function isServableAsset(candidate: string): boolean {
  const target = normalize(candidate);
  const onWindows = process.platform === 'win32';
  const same = (a: string, b: string): boolean =>
    onWindows ? a.toLowerCase() === b.toLowerCase() : a === b;
  const within = (root: string): boolean => {
    const base = normalize(root);
    const prefix = base.endsWith(sep) ? base : base + sep;
    return (
      same(target, base) ||
      (onWindows
        ? target.toLowerCase().startsWith(prefix.toLowerCase())
        : target.startsWith(prefix))
    );
  };

  if ([userAssetsDir(), bundledAssetsDir()].some(within)) return true;

  const chosen = loadSettings().avatar.modelPath;
  return Boolean(chosen && same(normalize(chosen), target));
}

/**
 * Serves VRM/VRMA files to the renderer over `kitsune-asset://`. Paths are
 * confined to the app's own asset roots so a compromised renderer cannot read
 * the rest of the disk through this channel.
 */
function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      // kitsune-asset://local/<absolute path, percent-encoded>
      const raw = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const filePath = process.platform === 'win32' ? raw.replace(/\//g, sep) : '/' + raw;

      if (!isServableAsset(filePath) || !existsSync(filePath)) {
        return new Response('Not found', { status: 404 });
      }
      return await net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response('Bad request', { status: 400 });
    }
  });
}

function applySecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            // Vite injects styles at runtime in both dev and production builds.
            "style-src 'self' 'unsafe-inline'",
            `img-src 'self' data: blob: ${ASSET_SCHEME}:`,
            `media-src 'self' blob: ${ASSET_SCHEME}:`,
            `connect-src 'self' ${ASSET_SCHEME}: data: blob:` +
              (process.env['ELECTRON_RENDERER_URL'] ? ' ws://localhost:* http://localhost:*' : ''),
            "script-src 'self'" + (process.env['ELECTRON_RENDERER_URL'] ? " 'unsafe-inline' 'unsafe-eval'" : ''),
            "object-src 'none'",
            "frame-src 'none'",
            // form-action does not fall back to default-src, so without this a
            // stray <form> in rendered Markdown could still post off-machine.
            "form-action 'none'",
          ].join('; '),
        ],
      },
    });
  });

  // The model and memory never leave the machine except via the Gemini call in
  // the main process, so the renderer needs no outbound network permissions
  // beyond the microphone.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    // 'media' is what a getUserMedia() microphone request reports as.
    callback(permission === 'media');
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#14100e',
    title: 'Kitsune Companion',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // External links open in the real browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServer = process.env['ELECTRON_RENDERER_URL'];
  if (devServer) {
    void mainWindow.loadURL(devServer);
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

// One instance only: a second launch focuses the existing window instead of
// opening a rival copy that would fight over the memory file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    ensureDir(userDataDir());
    ensureDir(userAssetsDir());
    applySecurityPolicy();
    registerAssetProtocol();
    registerIpc(() => mainWindow);
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
