import * as logging from "../logging";
import * as registry from "../registry";
import { clipboardApi, filesApi, notificationApi, storageApi } from "./core";
import { screenApi } from "./screen";
import { keyboardApi, mouseApi } from "./input";
import * as processSvc from "./processSvc";
import * as hotkeys from "./hotkeys";
import * as windows from "./windows";

export interface ServiceCtx {
  appId: string;
  appPath: string;
  pushEvent(key: string, event: string, data: unknown): void;
}

/**
 * Routes a host.* service call from an app (runtime process or window)
 * to the implementing service. Unknown combinations throw; the error
 * travels back to the caller through the SDK promise.
 */
export async function dispatch(
  ctx: ServiceCtx,
  service: string,
  method: string,
  args: any,
): Promise<unknown> {
  switch (service) {
    case "log": {
      const level = method as "info" | "warn" | "error";
      logging.logApp(ctx.appId, level, String(args?.msg ?? ""));
      return null;
    }

    case "clipboard":
      if (method === "readText") return clipboardApi.readText();
      if (method === "writeText") return clipboardApi.writeText(String(args?.text ?? ""));
      break;

    case "files":
      switch (method) {
        case "read":
          return filesApi.read(String(args?.path));
        case "write":
          return filesApi.write(String(args?.path), String(args?.data ?? ""));
        case "copy":
          return filesApi.copy(String(args?.from), String(args?.to));
        case "move":
          return filesApi.move(String(args?.from), String(args?.to));
        case "remove":
          return filesApi.remove(String(args?.path));
        case "selectFile":
          return filesApi.selectFile();
        case "selectDirectory":
          return filesApi.selectDirectory();
      }
      break;

    case "storage":
      switch (method) {
        case "get":
          return storageApi.get(ctx.appId, String(args?.key));
        case "set":
          return storageApi.set(ctx.appId, String(args?.key), args?.value);
        case "delete":
          return storageApi.delete(ctx.appId, String(args?.key));
        case "keys":
          return storageApi.keys(ctx.appId);
      }
      break;

    case "screen":
      switch (method) {
        case "capture":
          return screenApi.capture();
        case "captureRegion":
          return screenApi.captureRegion(args?.rect);
        case "selectRegion": {
          const rect = await screenApi.selectRegion();
          // 系统截图工具完成后,焦点回到原先的全屏游戏窗口;全屏窗口
          // 处于比置顶层更高的全屏层,会把 App 浮窗整个盖住(表现为
          // "面板消失")—— 把发起选区的 App 窗口拉回最前
          windows.focusApp(ctx.appId);
          return rect;
        }
        case "getMonitors":
          return screenApi.getMonitors();
      }
      break;

    case "mouse":
      switch (method) {
        case "position":
          return mouseApi.position();
        case "move":
          return mouseApi.move(Number(args?.x), Number(args?.y));
        case "click":
          return mouseApi.click(Number(args?.x), Number(args?.y), String(args?.button ?? "left"));
        case "doubleClick":
          return mouseApi.doubleClick(Number(args?.x), Number(args?.y));
        case "waitClick":
          return mouseApi.waitClick();
      }
      break;

    case "keyboard":
      switch (method) {
        case "press":
          return keyboardApi.press(String(args?.key));
        case "hotkey":
          return keyboardApi.hotkey((args?.keys ?? []).map(String));
        case "type":
          return keyboardApi.type(String(args?.text ?? ""));
      }
      break;

    case "hotkey":
      if (method === "register") {
        const combo = String(args?.combo);
        const key = String(args?.key ?? `hotkey:${combo}`);
        return hotkeys.register(combo, ctx.appId, () => ctx.pushEvent(key, "fire", {}));
      }
      if (method === "unregister") {
        return hotkeys.unregister(String(args?.combo), ctx.appId);
      }
      break;

    case "process":
      switch (method) {
        case "spawn":
          return processSvc.spawnHelper(ctx.appId, args?.opts ?? {}, ctx.pushEvent);
        case "write":
          return processSvc.write(ctx.appId, String(args?.handleId), String(args?.data ?? ""));
        case "kill":
          return processSvc.kill(ctx.appId, String(args?.handleId));
      }
      break;

    case "window":
      switch (method) {
        case "create": {
          const o = args?.opts ?? {};
          const type = ["window", "floating", "overlay"].includes(o.type) ? o.type : "window";
          return windows.createWindow(
            ctx.appId,
            type,
            Number(o.width ?? 360),
            Number(o.height ?? 240),
          );
        }
        case "close":
          // 无 windowId = 关闭本 App 的全部窗口(统一关闭语义);浮窗类
          // 窗口没有系统标题栏,这是面板唯一的一键退出途径
          if (args?.windowId) return windows.closeWindow(ctx.appId, String(args.windowId));
          return { hidden: windows.hideApp(ctx.appId) };
        case "hide":
          return { hidden: windows.hideApp(ctx.appId) };
        case "focusSelf":
          windows.focusApp(ctx.appId);
          return null;
        case "sendToUi":
          windows.sendToUi(ctx.appId, args?.msg);
          return null;
      }
      break;

    case "notification":
      if (method === "show") {
        // 点击命令与 invoke 的 command 校验同口径:string、非空、≤80,否则按未传处理
        const clickCommand =
          typeof args?.clickCommand === "string" && args.clickCommand.length > 0 && args.clickCommand.length <= 80
            ? args.clickCommand
            : undefined;
        return notificationApi.show({
          title: String(args?.title ?? ctx.appId),
          body: args?.body,
          appId: ctx.appId,
          clickCommand,
          declaredCommands: (registry.get(ctx.appId)?.manifest.commands ?? []).map((c) => c.id),
        });
      }
      break;
  }

  throw new Error(`未知的服务调用: ${service}.${method}`);
}
