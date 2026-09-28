/**
 * Bootstrap for Mini App runtime processes (Electron utilityProcess).
 * Plain CJS, no build step. Loads the app's built dist/main.js and
 * bridges host messages to the app lifecycle.
 *
 * Protocol (host → app):
 *   {type:"mini-start"}
 *   {type:"mini-invoke", reqId, command, args}
 *   {type:"mini-stop"}
 *   {type:"mini-svc-event", key, event, data}   → consumed by @mini/sdk
 * Protocol (app → host):
 *   {type:"mini-ready"}
 *   {type:"mini-started"} / {type:"mini-start-failed", error}
 *   {type:"mini-invoke-res", reqId, ok, result | error}
 *   {type:"mini-stopped"}
 *   {type:"mini-svc", id, service, method, args} → consumed by @mini/sdk
 */

const entry = process.env.MINI_APP_ENTRY;
const port = process.parentPort;
let mod = null;

function post(msg) {
  port.postMessage(msg);
}

function safeSerialize(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (err) {
    throw new Error("App 返回值无法序列化为 JSON: " + err.message);
  }
}

function ensureMod() {
  if (!mod) mod = require(entry);
  return mod;
}

port.on("message", async (e) => {
  const m = e && e.data ? e.data : e;
  try {
    if (m.type === "mini-start") {
      const app = ensureMod();
      if (app.onStart) await app.onStart();
      post({ type: "mini-started" });
    } else if (m.type === "mini-invoke") {
      const app = ensureMod();
      if (!app.invoke) {
        post({ type: "mini-invoke-res", reqId: m.reqId, ok: false, error: "App 未实现 invoke()" });
        return;
      }
      const result = safeSerialize(await app.invoke(m.command, m.args));
      post({ type: "mini-invoke-res", reqId: m.reqId, ok: true, result });
    } else if (m.type === "mini-stop") {
      try {
        const app = mod;
        if (app && app.onStop) await app.onStop();
      } catch (err) {
        post({ type: "mini-svc-event", key: "stop-error", event: "error", data: String(err && err.stack) });
      }
      post({ type: "mini-stopped" });
      setTimeout(() => process.exit(0), 50);
    }
  } catch (err) {
    const message = String((err && err.stack) || err);
    if (m.type === "mini-invoke") {
      post({ type: "mini-invoke-res", reqId: m.reqId, ok: false, error: message });
    } else if (m.type === "mini-start") {
      post({ type: "mini-start-failed", error: message });
    }
  }
});

post({ type: "mini-ready" });
