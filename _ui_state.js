/* 浮层交互状态探针：模拟「右键猫 → 开菜单 → 开聊天 → 点面板 → 拖面板 → 移出」，
   每一步打印穿透状态 / 浮层 / 焦点 / 猫是否还在动。
   重点验证两件事：
     1) 浮层开着时，鼠标不在浮层上 → ignore=true（屏幕不受影响，点一下就生效）；
     2) 鼠标移出浮层后 UI 会自动关闭（穿透态收不到 click，「点空白关闭」只能这样等价实现）。
   用法：electron tools/_ui_state.js */
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('use-gl', 'angle');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const SNAP = `(() => {
  const cv = document.getElementById('petCanvas');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let o = 0, sig = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 20) { o++; sig = (sig + d[i - 3] * 3 + d[i - 2] * 5 + d[i - 1] * 7) % 999983; }
  const ch = document.getElementById('chat');
  const P = window.__pet || {};
  return JSON.stringify({
    ignore: P.ignoreMouse, leave: P.leaving, ov: (P.overlays || []).join('+') || '-',
    cur: P.cur ? P.cur.name + '#' + P.cur.frame : null,
    opaque: o, sig: sig,
    msgs: document.querySelectorAll('#chatLog .ch-msg').length,
    chatPos: ch.style.left + ',' + ch.style.top,
    focus: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
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
    console.log(tag.padEnd(30) + s);
  };
  const move = async (x, y) => {
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new MouseEvent('mousemove', { clientX: ${x}, clientY: ${y}, bubbles: true }))`);
    await sleep(200);
  };
  const rect = async sel => JSON.parse(await win.webContents.executeJavaScript(
    `(() => { const e = document.querySelector('${sel}'); if (!e || e.classList.contains('hidden')) return 'null';
       const r = e.getBoundingClientRect();
       return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 30) }); })()`));

  await snap('[0] 基线');
  await sleep(1200);
  await snap('[1] +1.2s');

  // ---- 右键猫 → 菜单 ----
  await win.webContents.executeJavaScript(`(() => {
    const p = document.getElementById('pet');
    const r = p.getBoundingClientRect();
    window.__pt = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.8) };
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: window.__pt.x, clientY: window.__pt.y, bubbles: true }));
    p.dispatchEvent(new MouseEvent('contextmenu', { clientX: window.__pt.x, clientY: window.__pt.y, bubbles: true, cancelable: true }));
    return 'ok';
  })()`);
  await sleep(300);
  await snap('[2] 右键开菜单(应 ignore)');
  const mr = await rect('#menu');
  if (mr !== 'null') {
    await move(mr.x, mr.y);
    await snap('[3] 鼠标移到菜单上(应接收)');
  }
  await move(900, 640);                        // 鼠标移到远处（桌面）
  await snap('[4] 鼠标移开(应 ignore)');
  await sleep(2300);                           // grace 1.5s + 关闭延时 0.35s
  await snap('[5] 移开 2.3s 后(菜单应自动关)');

  // ---- 开聊天 ----
  await win.webContents.executeJavaScript(`(() => {
    const pt = window.__pt;
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: pt.x, clientY: pt.y, bubbles: true }));
    document.getElementById('pet').dispatchEvent(new MouseEvent('contextmenu', { clientX: pt.x, clientY: pt.y, bubbles: true, cancelable: true }));
    const mi = document.querySelector('.mi[data-act="chat"]');
    if (!mi) return 'no-item';
    mi.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return 'ok';
  })()`);
  await sleep(400);
  await snap('[6] 开聊天(不该抢焦点)');
  const cr = await rect('#chat');
  if (cr !== 'null') {
    await move(cr.x, cr.y);
    await snap('[7] 鼠标在面板上(应接收)');
  }
  await win.webContents.executeJavaScript(`(() => {
    const c = document.querySelector('.ch-chip');
    if (c) c.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return 'ok';
  })()`);
  await sleep(300);
  await snap('[8] 点短语后(消息应增加)');

  // ---- 拖面板标题栏 ----
  const before = await win.webContents.executeJavaScript(`document.getElementById('chat').style.left + ',' + document.getElementById('chat').style.top`);
  await win.webContents.executeJavaScript(`(() => {
    const h = document.querySelector('.ch-head');
    const r = h.getBoundingClientRect();
    const x = Math.round(r.left + 30), y = Math.round(r.top + 12);
    h.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }));
    for (let i = 1; i <= 6; i++) {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: x + i * 10, clientY: y + i * 5, bubbles: true }));
    }
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: x + 60, clientY: y + 30, bubbles: true }));
    return 'ok';
  })()`);
  await sleep(300);
  await snap('[9] 拖动面板后');
  console.log('拖动前 chatPos = ' + before);

  // ---- 移出面板：应不影响屏幕（ignore），随后自动关闭 ----
  await move(950, 660);
  await snap('[10] 移出面板(应 ignore)');
  await sleep(2300);
  await snap('[11] 2.3s 后(面板应自动关)');

  // ---- 回归：点输入框仍要能借到焦点 ----
  await win.webContents.executeJavaScript(`(() => {
    const pt = window.__pt;
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: pt.x, clientY: pt.y, bubbles: true }));
    document.getElementById('pet').dispatchEvent(new MouseEvent('contextmenu', { clientX: pt.x, clientY: pt.y, bubbles: true, cancelable: true }));
    const mi = document.querySelector('.mi[data-act="chat"]');
    if (mi) mi.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return 'ok';
  })()`);
  await sleep(400);
  const cr2 = await rect('#chat');
  if (cr2 !== 'null') await move(cr2.x, cr2.y);
  await win.webContents.executeJavaScript(`(() => {
    const inp = document.getElementById('chatInput');
    const r = inp.getBoundingClientRect();
    inp.dispatchEvent(new MouseEvent('mousedown', { clientX: Math.round(r.left + 10), clientY: Math.round(r.top + 5), button: 0, bubbles: true, cancelable: true }));
    return 'ok';
  })()`);
  await sleep(700);
  await snap('[12] 点输入框(应借到焦点)');
  await move(950, 660);
  await sleep(2300);
  await snap('[13] 打字时移开(输入框聚焦不该关)');

  if (errs.length) console.log('ERRS\n' + errs.slice(0, 8).join('\n'));
  app.quit();
});
