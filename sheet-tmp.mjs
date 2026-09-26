import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const files = process.argv.slice(3);
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1300, height: 600 } });
await p.setContent(`<body style="margin:0;background:#222;display:flex;flex-wrap:wrap">${
  files.map(f=>`<figure style="margin:0;width:320px"><img src="data:image/png;base64,${readFileSync(f).toString('base64')}" style="width:320px;display:block"><figcaption style="color:#fff;font:13px sans-serif;text-align:center">${f.split('/').pop()}</figcaption></figure>`).join('')}</body>`);
await p.waitForTimeout(400);
await p.screenshot({ path: process.argv[2], fullPage: true });
await b.close();
