// 一次性热键探测:electron scripts/hotkey-probe.js <combo> [combo...]
// 输出每个组合 FREE / TAKEN 后退出。
const { app, globalShortcut } = require("electron");
const combos = process.argv.slice(2);

app.whenReady().then(() => {
  for (const combo of combos) {
    let ok = false;
    try {
      ok = globalShortcut.register(combo, () => {});
    } catch {
      ok = false;
    }
    console.log(`${ok ? "FREE " : "TAKEN"} ${combo}`);
    if (ok) {
      try {
        globalShortcut.unregister(combo);
      } catch {
        /* ignore */
      }
    }
  }
  app.quit();
});
