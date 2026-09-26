#!/usr/bin/env node
/** Headless VRM renderer: loads an avatar (optionally posed by a VRMA clip) and writes a PNG. */
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error(
    '\nThis tool needs Playwright, which the app itself does not:\n' +
    '  npm i -D playwright\n' +
    'Set CHROME_BIN if your Chromium lives somewhere unusual.\n',
  );
  process.exit(1);
}
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.vrm':'model/gltf-binary', '.vrma':'model/gltf-binary', '.json':'application/json', '.wasm':'application/wasm' };

const server = createServer(async (req, res) => {
  try {
    const path = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
         '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage'],
});
const width = Number(opt('width', 900)), height = Number(opt('height', 1100));
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error') console.error('  [page]', m.text()); });
page.on('pageerror', (e) => console.error('  [pageerror]', e.message));

await page.goto(`${base}/tools/render-page.html`);
await page.waitForFunction(() => window.__status === 'ready', null, { timeout: 60000 });

const result = await page.evaluate((o) => window.renderVrm(o), {
  modelUrl: `${base}/${opt('model').replace(/^\.?\//, '')}`,
  animUrl: opt('anim') ? `${base}/${opt('anim').replace(/^\.?\//, '')}` : null,
  width, height,
  view: opt('view', 'full'),
  yaw: Number(opt('yaw', 0)),
  frameTime: Number(opt('time', 0)),
});
console.log('  bounds', result.size.map((n) => n.toFixed(2)).join(' x '), '| name', result.meta);

await page.locator('canvas').screenshot({ path: opt('out', 'render.png') });
console.log('  wrote', opt('out', 'render.png'));
await browser.close();
server.close();
