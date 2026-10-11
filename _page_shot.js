/* 离屏截真实页面：用与 main.js 相同的 webPreferences 加载 index.html，
   等几秒让素材解码、状态机跑起来，然后把整屏存成 png。
   用途：桌宠是透明全屏窗口，肉眼"没反应"时看不出是没画还是画错了。
   用法：electron tools/_page_shot.js [等待毫秒] [输出文件] */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const WAIT = parseInt(process.argv[2] || '6000', 10);
const OUT = process.argv[3] || path.join(__dirname, '_page_shot.png');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('use-gl', 'angle');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900, height: 700, show: false,
    transparent: true, frame: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      contextIsolation: true,
      webSecurity: false,
      allowFileAccessFromFiles: true,
      backgroundThrottling: false,
      offscreen: true,
    },
  });
  const errs = [];
  win.webContents.on('console-message', (_e, lv, msg) => { if (lv >= 2) errs.push('[' + lv + '] ' + msg); });
  win.webContents.on('render-process-gone', (_e, d) => errs.push('gone:' + d.reason));
  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await new Promise(r => setTimeout(r, WAIT));
  const info0 = await win.webContents.executeJavaScript(`(() => {
    const cv = document.getElementById('petCanvas');
    const p = document.getElementById('pet');
    const r = cv.getBoundingClientRect(), pr = p.getBoundingClientRect();
    const x = cv.getContext('2d');
    let opaque = 0;
    try {
      const d = x.getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 20) opaque++;
    } catch (e) { opaque = -1; }
    return JSON.stringify({
      canvasAttr: cv.width + 'x' + cv.height,
      canvasCss: Math.round(r.width) + 'x' + Math.round(r.height),
      petBox: Math.round(pr.width) + 'x' + Math.round(pr.height),
      canvasPos: Math.round(r.left) + ',' + Math.round(r.top),
      petPos: Math.round(pr.left) + ',' + Math.round(pr.top),
      opaquePx: opaque,
      metaLoaded: typeof META !== 'undefined' && !!META,
      sheetCount: typeof sheets !== 'undefined' ? Object.keys(sheets).length : -1,
      cur: typeof cur !== 'undefined' && cur ? cur.name : null,
      log: (window.__petLog || []).slice(-6),
    });
  })()`).catch(e => 'EVAL_FAIL ' + e.message);
  await new Promise(r => setTimeout(r, 1500));
  const info1 = await win.webContents.executeJavaScript(`(() => {
    const x = document.getElementById('petCanvas').getContext('2d');
    const d = x.getImageData(0, 0, 360, 360).data;
    let o = 0, sum = 0;
    for (let i = 3; i < d.length; i += 4) { if (d[i] > 20) { o++; sum += d[i - 1]; } }
    return o + '|' + sum;
  })()`).catch(e => 'EVAL_FAIL ' + e.message);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  console.log('INFO ' + info0);
  console.log('T+1.5s ' + info1);
  if (errs.length) console.log('ERRS\n' + errs.slice(0, 10).join('\n'));
  console.log('SHOT ' + OUT);
  app.quit();
});
