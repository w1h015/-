/* 一次性工具：把跳段之后的实际播放帧序列渲染成联络表（支持非连续帧号）。
   用法： electron.exe tools/_contact_seq.js <clip> <spec> <cols> <cell> <out.png>
         spec 支持区间与单个帧号混写，例如 "48-66,83-84" 或 "48,49,55-60"
   启动前必须清空 ELECTRON_RUN_AS_NODE。 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const clip = process.argv[2] || 'turn';
const spec = process.argv[3] || '48-66,83-84';
const COLS = Number(process.argv[4] || 8);
const T = Number(process.argv[5] || 150);
const out = process.argv[6] || path.join(__dirname, '_turn_seq.png');

const frames = [];
for (const part of spec.split(',')) {
  const seg = part.trim();
  if (!seg) continue;
  const m = seg.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) throw new Error('bad spec part: ' + seg);
  const a = Number(m[1]), b = m[2] == null ? a : Number(m[2]);
  for (let f = a; f <= b; f++) frames.push(f);
}

const html = `<!doctype html><html><body style="margin:0;background:#ff00ff">
<canvas id="c"></canvas>
<script>
const CLIP = ${JSON.stringify(clip)};
const FRAMES = ${JSON.stringify(frames)};
const GRID = 8;   // CELL 从 meta 读（每条分镜不同）
const BASE = ${JSON.stringify('file:///' + path.join(__dirname, '..', 'assets_sprites').replace(/\\\\/g, '/'))};
async function main() {
  const meta = await (await fetch(BASE + '/meta.json')).json();
  const m = meta[CLIP];
  const sheets = [];
  for (const s of m.sheets) {
    const img = new Image(); img.src = BASE + '/' + s.file;
    await new Promise(r => { img.onload = r; img.onerror = r; });
    sheets.push(img);
  }
  const rows = Math.ceil(FRAMES.length / ${COLS});
  const cv = document.getElementById('c');
  cv.width = ${COLS} * ${T}; cv.height = rows * ${T};
  const x = cv.getContext('2d');
  x.fillStyle = '#ff00ff'; x.fillRect(0, 0, cv.width, cv.height);
  x.font = 'bold 18px monospace'; x.textBaseline = 'top';
  const CELL = m.cell;
  for (let i = 0; i < FRAMES.length; i++) {
    const f = FRAMES[i];
    if (f >= m.frames) continue;
    const per = GRID * GRID;
    const img = sheets[Math.floor(f / per)];
    const k = f % per;
    const sx = (k % GRID) * CELL, sy = Math.floor(k / GRID) * CELL;
    const gx = (i % ${COLS}) * ${T}, gy = Math.floor(i / ${COLS}) * ${T};
    x.drawImage(img, sx, sy, CELL, CELL, gx, gy, ${T}, ${T});
    x.fillStyle = '#000'; x.fillRect(gx, gy, 40, 22);
    x.fillStyle = '#fff'; x.fillText(String(f), gx + 4, gy + 2);
  }
  document.title = 'done:' + FRAMES.length;
}
main();
</script></body></html>`;

app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('use-gl', 'angle');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');

app.whenReady().then(async () => {
  const rows = Math.ceil(frames.length / COLS);
  const win = new BrowserWindow({
    show: false, width: COLS * T + 16, height: rows * T + 16,
    webPreferences: { offscreen: true, webSecurity: false, allowFileAccessFromFiles: true }
  });
  const tmp = path.join(__dirname, '_contact_seq.html');
  fs.writeFileSync(tmp, html);
  await win.loadFile(tmp);
  for (let i = 0; i < 60; i++) {
    const t = await win.webContents.executeJavaScript('document.title');
    if (t.startsWith('done:')) break;
    await new Promise(r => setTimeout(r, 200));
  }
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  fs.unlinkSync(tmp);
  console.log('saved ' + out + '  frames=' + frames.length);
  app.quit();
});
