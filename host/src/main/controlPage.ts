import path from "node:path";
import { pathToFileURL } from "node:url";
import { logHost } from "./logging";

export function isTrustedPage(sender: Electron.WebContents, current: Electron.WebContents | undefined, file: string): boolean {
  if (!current || sender !== current || sender.isDestroyed()) return false;
  const actual = sender.getURL();
  const expected = pathToFileURL(path.resolve(file)).href;
  try {
    const url = new URL(actual);
    return url.protocol === "file:" && decodeURIComponent(url.pathname).toLowerCase() ===
      decodeURIComponent(new URL(expected).pathname).toLowerCase() && !url.search && !url.hash;
  } catch { return false; }
}

export function lockControlPage(win: Electron.BrowserWindow, label: string): void {
  const wc = win.webContents;
  wc.on("will-navigate", (event) => event.preventDefault());
  wc.on("will-redirect", (event) => event.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("did-fail-load", (_event, code, detail) => logHost("error", `${label} load failed ${code}: ${detail}`));
  // These pages use only the preload bridge; permission requests have no legitimate use.
  wc.session.setPermissionRequestHandler((_requester, _permission, callback) => callback(false));
  wc.session.setPermissionCheckHandler(() => false);
}
