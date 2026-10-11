/* 息屏复位探针：验证「屏幕熄灭回来之后还能不能摸到猫」。
   检查三件事：
     1) wakeReset() 之后状态回到初始（ignore=true、没有残留拖拽、移出计时器清掉）；
     2) 复位后鼠标移到猫身上还能正常切回「接收」（即不会永远卡在穿透）；
     3) 浮层开着时复位，浮层不会被误关，但宽限期重新开始计。
   用法：electron tools/_wake_check.js
   （离屏脚本必须带 swiftshader 三件套 + no-sandbox，否则 loadFile 报 ERR_FAILED(-2)） */
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
    ignore: P.ignoreMouse, drg: P.dragging, uiDrag: P.uiDrag,
    ov: (P.overlays || []).join('+') || '-',
    leave: P.leaving, wake: P.wake, hb: P.hb,
    cur: P.cur ? P.cur.name + '#' + P.cur.frame : null,
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

  const snap = async tag => {
    const s = await win.webContents.executeJavaScript(SNAP).catch(e => 'EVAL_FAIL ' + e.message);
    console.log(tag.padEnd(32) + s);
    return s;
  };
  const move = async (x, y) => {
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new MouseEvent('mousemove', { clientX: ${x}, clientY: ${y}, bubbles: true }))`);
    await sleep(250);
  };
  const ev = async js => {
    await win.webContents.executeJavaScript(js).catch(e => console.log('EVAL_FAIL ' + e.message));
    await sleep(250);
  };

  await snap('1 启动后');

  // 2) 把鼠标放到猫身上：正常应该切到「接收」
  const c = JSON.parse(await snap('2 取猫中心')).center;
  const [cx, cy] = (c || '0,0').split(',').map(Number);
  await move(cx, cy);
  await snap('3 鼠标在猫身上');

  // 4) 真右键开菜单（按真实矩形判定，手工 remove hidden 的菜单是空的）
  await ev(`document.getElementById('pet').dispatchEvent(
              new MouseEvent('contextmenu', { clientX: ${cx}, clientY: ${cy}, bubbles: true }))`);
  const mr = await win.webContents.executeJavaScript(
    `(() => { const m = document.getElementById('menu'); const r = m.getBoundingClientRect();
              return JSON.stringify({ hidden: m.classList.contains('hidden'),
                                      w: Math.round(r.width), h: Math.round(r.height),
                                      cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) }); })()`);
  console.log('菜单矩形 ' + mr);
  await move(cx + 400, cy + 200);
  await snap('4 菜单开着、鼠标在别处');

  // 5) 息屏复位（不带光标）：状态必须回初始，浮层不能丢
  await ev(`window.__pet.wakeReset('probe')`);
  await snap('5 wakeReset 之后');

  // 5b) 带光标复位：鼠标就停在猫身上时，回来第一下就该能摸到
  await ev(`window.__pet.wakeReset('probe-cursor', { cursor: { x: ${cx}, y: ${cy} } })`);
  await snap('5b 带光标的 wakeReset');

  // 6) 复位后菜单里的操作还能不能点（关键：不能永远卡在穿透）
  const mm = JSON.parse(mr);
  await move(mm.cx, mm.cy);
  await snap('6 鼠标回到菜单上');

  // 7) 关掉菜单后再摸猫：必须能切回接收
  await ev(`document.getElementById('menu').classList.add('hidden')`);
  await move(cx, cy);
  await snap('7 关菜单后再摸猫');

  // 8) 关键场景：鼠标就停在猫身上时息屏再回来，第一下就该摸得到（不能卡在穿透）
  await ev(`window.__pet.wakeReset('probe-cursor', { cursor: { x: ${cx}, y: ${cy} } })`);
  await snap('8 猫身上的光标复位');

  console.log(errs.length ? '\n控制台报错:\n' + errs.join('\n') : '\n无控制台报错');
  app.quit();
});
