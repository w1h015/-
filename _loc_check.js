/* 自动定位回归检查：在离屏里加载真实 index.html（走真实 userData，读到用户配置），
   强制重跑一次 autoLocate，打印：地点 / 坐标 / 依据 / 天气结果。
   用法：electron tools/_loc_check.js */
const { app, BrowserWindow } = require('electron');
const path = require('path');

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
  await new Promise(r => setTimeout(r, 2500));

  const before = await win.webContents.executeJavaScript('JSON.stringify(window.__pet.loc)');
  console.log('定位前 ' + before);

  // 强制重识别（force=true 跳过「一天一次」和「手填让位」）
  const t0 = Date.now();
  const ok = await win.webContents.executeJavaScript('window.__pet.locate(true)');
  console.log('强制识别 返回=' + ok + ' 耗时=' + (Date.now() - t0) + 'ms');

  await new Promise(r => setTimeout(r, 2500));
  const after = await win.webContents.executeJavaScript(
    'JSON.stringify({ loc: window.__pet.loc, weather: window.__pet.weather })');
  console.log('定位后 ' + after);

  // 再跑一次不带 force：应当被「一天一次」挡住（返回 false / 值不变）
  const again = await win.webContents.executeJavaScript('window.__pet.locate(false)');
  console.log('再次识别(不强制) 返回=' + again + '（应为 false —— 一天只查一次）');

  const ui = await win.webContents.executeJavaScript(`(() => {
    const s = document.getElementById('locState');
    const p = document.getElementById('cfgPlace');
    const la = document.getElementById('cfgLat'), lo = document.getElementById('cfgLon');
    const c = document.getElementById('cfgAutoLocate');
    return JSON.stringify({ locState: s && s.textContent, place: p && p.value,
                            lat: la && la.value, lon: lo && lo.value,
                            autoChecked: c && c.checked });
  })()`);
  console.log('面板同步 ' + ui);
  console.log('气象 ' + await win.webContents.executeJavaScript(
    'document.getElementById("weatherState").textContent'));

  if (errs.length) console.log('ERRS\n' + errs.slice(0, 8).join('\n'));
  app.quit();
});
