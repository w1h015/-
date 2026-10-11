/* 息屏复位的「主进程 → 渲染层」通路探针。
   验证两件事：
     1) 主进程那套复位动作（重挂鼠标钩子 / setBounds / setAlwaysOnTop / moveTop）
        在本机 Electron 上调得通、不抛异常；
     2) wake-reset 这个 ipc 真的送到了渲染层（preload.onWake → wakeReset 生效）。
   这两处是最容易写错又最难从外面看出来的地方：事件名对不上就完全静默失效。
   用法：electron tools/_wake_ipc.js */
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('use-gl', 'angle');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1000, height: 700, show: false,
    transparent: true, frame: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      contextIsolation: true, webSecurity: false,
      allowFileAccessFromFiles: true, backgroundThrottling: false, offscreen: true,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await sleep(6000);

  const before = await win.webContents.executeJavaScript(
    `JSON.stringify(window.__pet ? window.__pet.wake : null)`);
  console.log('复位前   ' + before);

  // 主进程的复位动作逐个跑一遍，任何一个抛异常都会在这里暴露
  const steps = [
    ['setIgnoreMouseEvents(false)', () => win.setIgnoreMouseEvents(false)],
    ['setIgnoreMouseEvents(true,forward)', () => win.setIgnoreMouseEvents(true, { forward: true })],
    ['setBounds', () => win.setBounds({ x: 0, y: 0, width: 1000, height: 700 })],
    ['setAlwaysOnTop(true)', () => win.setAlwaysOnTop(true)],
    ['moveTop', () => win.moveTop()],
    ['send wake-reset', () => win.webContents.send('wake-reset', { reason: 'probe-ipc', w: 1000, h: 700 })],
  ];
  for (const [name, fn] of steps) {
    try { fn(); console.log('  ok   ' + name); }
    catch (e) { console.log('  FAIL ' + name + ' -> ' + e.message); }
  }

  await sleep(600);
  const after = await win.webContents.executeJavaScript(
    `JSON.stringify(window.__pet ? window.__pet.wake : null)`);
  console.log('复位后   ' + after);

  const ok = /"count":1/.test(after) && /probe-ipc/.test(after);
  console.log(ok ? '\n结论：主进程→渲染层通路正常' : '\n结论：通路不通，检查 ipc 事件名与 preload 绑定');

  // 反向通路：渲染层主动申请复位（页面可见性变化 / rAF 停摆时走这条）
  let got = null;
  const { ipcMain } = require('electron');
  ipcMain.on('need-heal', (_e, reason) => { got = reason; });
  await win.webContents.executeJavaScript(`window.petAPI.requestHeal('probe-renderer')`);
  await sleep(500);
  console.log(got ? '渲染层申请复位 收到: ' + got : '渲染层申请复位 未收到（ipc 名或 preload 绑定有问题）');
  app.quit();
});
