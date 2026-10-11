/* 内置语言系统 · 页面内回归
   在真实 index.html 里跑 ZhiWarm，确认：
     ① 脚本被正确加载（app.js 之前）
     ② 各情绪场景路由正确
     ③ 生成的句子都过得了打分门槛（有结尾标点、长度合理、无禁忌句）
     ④ 设置面板「智能」页的新控件存在且已回填配置值
     ⑤ 页面无控制台报错
   用法：electron tools/_lm_page.js */
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
    webPreferences: { preload: path.join(__dirname, '..', 'electron', 'preload.js') }
  });

  const errs = [];
  win.webContents.on('console-message', (_e, lvl, msg) => {
    if (lvl >= 2) errs.push(msg);
  });

  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await new Promise(r => setTimeout(r, 4000));

  const out = await win.webContents.executeJavaScript(`
    (() => {
      const Z = window.ZhiWarm;
      if (!Z) return JSON.stringify({ loaded: false });
      const cases = ['我好难过','下周答辩没头绪','我成功了','累不想动','感冒了头疼','在吗','谢谢'];
      const rows = cases.map(t => ({ t: t, scene: Z.route(t), reply: Z.reply(t, {}) }));
      const ui = {};
      ['cfgEngine','cfgLmTemp','cfgLmMaxLen','btnLmTry','lmGenState'].forEach(id => {
        const el = document.getElementById(id);
        ui[id] = el ? (el.value !== undefined ? String(el.value) : '(element)') : 'MISSING';
      });
      return JSON.stringify({
        loaded: true,
        scenes: Object.keys(Z.models),
        corpusSize: Object.keys(Z.CORPUS).filter(k=>k!=='weather')
                     .reduce((n,k)=>n+Z.CORPUS[k].length, 0),
        linesSample: Z.LINES.tired,
        ui: ui,
        rows: rows
      });
    })()
  `);

  console.log(out);
  console.log('控制台错误数:', errs.length);
  if (errs.length) console.log(errs.slice(0, 5).join('\n'));
  app.quit();
});
