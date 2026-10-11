/* 一次性工具：把某个分镜的指定帧区间渲染成放大联络表，人工挑动作帧。
   用法： electron.exe tools/_contact2.js <clip> <start> <end> <cols> <cell> <out.png>
   例：  electron.exe tools/_contact2.js turn 40 95 8 192 tools/_turn_big.png
   启动前必须清空 ELECTRON_RUN_AS_NODE。 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const clip = process.argv[2] || 'turn';
const f0 = Number(process.argv[3] || 0);
const f1 = Math.min(Number(process.argv[4] || 0), 999);
const COLS = Number(process.argv[5] || 8);
const T = Number(process.argv[6] || 192);
const out = process.argv[7] || path.join(__dirname, `_${clip}_${f0}_${f1}.png`);

const html = `<!doctype html><html><body style="margin:0;background:#ff00ff">
<canvas id="c"></canvas>
<script>
const CLIP = ${JSON.stringify(clip)};
const F0 = ${f0}, F1 = ${f1}, GRID = 8;   // CELL 从 meta 读（每条分镜不同）
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
  const rows = Math.ceil((F1 - F0 + 1) / ${COLS});
  const cv = document.getElementById('c');
  cv.width = ${COLS} * ${T}; cv.height = rows * ${T};
  const x = cv.getContext('2d');
  x.fillStyle = '#ff00ff'; x.fillRect(0, 0, cv.width, cv.height);
  x.font = 'bold 18px monospace'; x.textBaseline = 'top';
  const CELL = m.cell;
  for (let f = F0; f <= F1 && f < m.frames; f++) {
    const per = GRID * GRID;
    const img = sheets[Math.floor(f / per)];
    const k = f % per;
    const sx = (k % GRID) * CELL, sy = Math.floor(k / GRID) * CELL;
    const gx = ((f - F0) % ${COLS}) * ${T}, gy = Math.floor((f - F0) / ${COLS}) * ${T};
    x.drawImage(img, sx, sy, CELL, CELL, gx, gy, ${T}, ${T});
    x.fillStyle = '#000'; x.fillRect(gx, gy, 40, 22);
    x.fillStyle = '#fff'; x.fillText(String(f), gx + 4, gy + 2);
  }
  document.title = 'done:' + (F1 - F0 + 1);
}
main();
</script></body></html>`;

app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('use-gl', 'angle');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');

app.whenReady().then(async () => {
  const rows = Math.ceil((f1 - f0 + 1) / COLS);
  const win = new BrowserWindow({
    show: false, width: COLS * T + 16, height: rows * T + 16,
    webPreferences: { offscreen: true, webSecurity: false, allowFileAccessFromFiles: true }
  });
  const tmp = path.join(__dirname, '_contact2.html');
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
  console.log('saved ' + out);
  app.quit();
});
