/* 兜底鼠标通路探针：验证「转发钩子断了之后，轮询能不能顶上」。
   做法：先喂一组原生 mousemove（模拟健康状态），停 600ms 让原生通路"断掉"，
   再由主进程直接发一条 cursor-pos（等价于轮询推过来的系统光标），
   看渲染层有没有接管：pollCount 应该 +1、lastMouse 应该跳到新坐标、
   命中判定应该照常工作（把坐标给到猫身上 → ignore 变 false）。
   用法：electron tools/_cursor_poll.js */
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('use-gl', 'angle');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const SNAP = `(() => {
  const P = window.__pet || {};
  return JSON.stringify({
    ignore: P.ignoreMouse, mouse: P.mouseCount, poll: P.pollCount,
    center: P.center ? Math.round(P.center.x) + ',' + Math.round(P.center.y) : null,
  });
})()`;

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
  const errs = [];
  win.webContents.on('console-message', (_e, lv, msg) => {
    if (lv >= 2 && !/Security Warning/.test(msg)) errs.push('[' + lv + '] ' + msg);
  });
  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await sleep(6000);

  const ev = js => win.webContents.executeJavaScript(js);
  const snap = async tag => console.log(tag.padEnd(26) + await ev(SNAP));

  // 1) 健康状态：喂原生 mousemove
  for (let i = 0; i < 5; i++) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 400 + i * 4, y: 300 });
    await sleep(30);
  }
  await snap('1 原生 mousemove 之后');

  // 2) 停 600ms，模拟转发钩子失效（原生事件不再进来）
  await sleep(600);
  await snap('2 停 600ms（钩子断）');

  // 3) 主进程推一条轮询坐标 —— 落在**猫身上**
  const c = JSON.parse(await ev('JSON.stringify(window.__pet.center)'));
  win.webContents.send('cursor-pos', { x: Math.round(c.x), y: Math.round(c.y) });
  await sleep(120);
  await snap('3 推猫身上的坐标');

  // 4) 再推一条远离猫的坐标，应该重新回到穿透
  win.webContents.send('cursor-pos', { x: 20, y: 20 });
  await sleep(120);
  await snap('4 推远离猫的坐标');

  const s3ok = /"poll":[1-9]/.test(await ev(SNAP));
  console.log('\n' + (errs.length ? '控制台报错: ' + errs.join(' | ') : '无控制台报错'));
  console.log('结论：' + (/poll":[1-9]/.test(await ev(SNAP))
    ? '轮询兜底生效（钩子断掉后由主进程接管命中判定）'
    : '轮询没生效，检查 preload.onCursor / app.js 里的 onCursor 绑定'));
  app.quit();
});
