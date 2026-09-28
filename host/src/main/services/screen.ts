import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  clipboard,
  desktopCapturer,
  screen as electronScreen,
  shell,
} from "electron";
import { paths } from "../config";
import { logHost } from "../logging";
import type { Rect } from "./shared";

/**
 * Screen capture + region selection. All coordinates crossing the SDK
 * boundary are physical pixels; conversions from DIP happen here.
 */

function physicalSize(display: Electron.Display): { width: number; height: number } {
  return {
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor),
  };
}

// Windows 的全局坐标系(虚拟屏幕)按主屏 DPI 缩放:每个显示器的 bounds 原点
// 都要 ×主屏 scaleFactor 才是物理像素;各屏自己的宽高则 ×自己的 scaleFactor。
// 之前原点误用各屏自己的缩放 —— 副屏(2560 DIP,自身 scale 1.0,主屏 1.5)被
// 算到物理 2560 而真实位置是 3840,与主屏物理区间重叠,导致副屏截图偏移、
// 选区定位错位、鼠标点击不准。
function physicalOrigin(display: Electron.Display): { x: number; y: number } {
  const primaryScale = electronScreen.getPrimaryDisplay().scaleFactor;
  return {
    x: Math.round(display.bounds.x * primaryScale),
    y: Math.round(display.bounds.y * primaryScale),
  };
}

function physicalRect(display: Electron.Display): { x: number; y: number; width: number; height: number } {
  const origin = physicalOrigin(display);
  const size = physicalSize(display);
  return { x: origin.x, y: origin.y, width: size.width, height: size.height };
}

function displayForRect(rect: Rect): Electron.Display {
  const displays = electronScreen.getAllDisplays();
  return (
    displays.find((d) => {
      const p = physicalRect(d);
      return rect.x >= p.x && rect.x < p.x + p.width && rect.y >= p.y && rect.y < p.y + p.height;
    }) ?? electronScreen.getPrimaryDisplay()
  );
}

async function captureDisplay(display: Electron.Display): Promise<Electron.NativeImage> {
  const size = physicalSize(display);
  // Windows 桌面复制在连续抓取时可能吐出上一帧(消除动画后重扫会拿到
  // 消除前的旧画面):先抓一次预热复制器,取第二帧。
  await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: size,
  });
  const match = sources.find((s) => s.display_id === String(display.id));
  let img = (match ?? sources[0])?.thumbnail;
  if (!img || img.isEmpty()) throw new Error("screen capture 失败(无可用屏幕源)");
  // 某些机器上 desktopCapturer 返回的尺寸 ≠ 请求的物理尺寸(比如返回 DIP 尺寸),
  // 会造成后续 crop 全部错位 —— 强制归一到物理尺寸,保证 1 物理像素 = 1 图像像素
  const actual = img.getSize();
  if (actual.width !== size.width || actual.height !== size.height) {
    logHost(
      "warn",
      `screen capture 尺寸 ${actual.width}x${actual.height} ≠ 请求 ${size.width}x${size.height},已缩放归一`,
    );
    img = img.resize({ width: size.width, height: size.height });
  }
  return img;
}

export const screenApi = {
  async capture(): Promise<{ dataUrl: string; width: number; height: number }> {
    const primary = electronScreen.getPrimaryDisplay();
    const img = await captureDisplay(primary);
    const size = physicalSize(primary);
    return { dataUrl: img.toDataURL(), width: size.width, height: size.height };
  },

  async captureRegion(rect: Rect): Promise<{ dataUrl: string; width: number; height: number }> {
    const display = displayForRect(rect);
    const img = await captureDisplay(display);
    const origin = physicalOrigin(display);
    const rel = img.crop({
      x: Math.round(rect.x - origin.x),
      y: Math.round(rect.y - origin.y),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    });
    const size = rel.getSize();
    return { dataUrl: rel.toDataURL(), width: size.width, height: size.height };
  },

  getMonitors() {
    return electronScreen.getAllDisplays().map((d) => ({
      id: d.id,
      bounds: physicalRect(d),
      scaleFactor: d.scaleFactor,
      isPrimary: d.id === electronScreen.getPrimaryDisplay().id,
    }));
  },

  async selectRegion(): Promise<Rect | null> {
    if (snipBusy) {
      logHost("warn", "selectRegion: 上一次截图选区仍在进行,忽略本次");
      return null;
    }
    snipBusy = true;
    try {
      return await runSnipSelection();
    } finally {
      snipBusy = false;
    }
  },
};

let snipBusy = false;

// 选区 = Windows 自带截图工具(ms-screenclip,即 Win+Shift+S 的框选):
// 用户直接在真实屏幕上框选,宿主不自绘浮层、不贴快照 —— 此前的自绘
// 浮层要把"页面 CSS 坐标"折算回"物理像素",中间隔着客户区/缩放/工作区
// 收缩多层几何,在本机上反复出错。现在框选结果是一张剪贴板位图,把它
// 在各显示器的整屏物理截图里做模板匹配,像素级找回矩形,全程零换算。
async function runSnipSelection(): Promise<Rect | null> {
  const displays = electronScreen.getAllDisplays();
  const screens: { path: string; x: number; y: number }[] = [];
  try {
    // 一次 getSources 抓全部屏幕(旧实现每屏预热+实取共两次调用,4K 多屏
    // 时光截图就占掉 1~2 秒,是"选区弹窗慢"的主要成分);预热照旧防旧帧。
    // 模板匹配必须用弹出截图工具**之前**的屏幕内容 —— 截图工具的遮罩
    // 会改变屏幕,所以先抓屏再 openExternal,这里省下的每 100ms 都直接
    // 决定弹窗延迟。
    const maxSize = displays.reduce(
      (acc, d) => {
        const s = physicalSize(d);
        return { width: Math.max(acc.width, s.width), height: Math.max(acc.height, s.height) };
      },
      { width: 0, height: 0 },
    );
    await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: maxSize });
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: maxSize });
    await Promise.all(
      displays.map(async (d, i) => {
        const size = physicalSize(d);
        const match = sources.find((s) => s.display_id === String(d.id)) ?? sources[i];
        let img = (match ?? sources[0])?.thumbnail;
        if (!img || img.isEmpty()) throw new Error("screen capture 失败(无可用屏幕源)");
        const actual = img.getSize();
        if (actual.width !== size.width || actual.height !== size.height) {
          img = img.resize({ width: size.width, height: size.height });
        }
        const file = path.join(paths.data, `snip-screen-${i}.png`);
        await fs.promises.writeFile(file, img.toPNG());
        const origin = physicalOrigin(d);
        screens.push({ path: file, x: origin.x, y: origin.y });
      }),
    );

    clipboard.clear();
    logHost("info", "selectRegion: 已启动系统截图工具,等待用户框选(完成后自动读剪贴板)");
    await shell.openExternal("ms-screenclip:");

    let clipPng: Buffer | null = null;
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      await delay(300);
      // Electron 44 clipboard API:read() → ClipboardItem[] → getType("image/*")
      try {
        const items = await clipboard.read();
        for (const item of items) {
          const imgType = item.types.find((t) => t.startsWith("image/"));
          if (!imgType) continue;
          const blob = (await item.getType(imgType)) as Blob;
          clipPng = Buffer.from(await blob.arrayBuffer());
          break;
        }
      } catch {
        /* 剪贴板正被写入或不完整 —— 继续轮询 */
      }
      if (clipPng) break;
    }
    if (!clipPng) {
      logHost("info", "selectRegion: 未等到框选结果(用户取消或超时)");
      return null;
    }

    const clipFile = path.join(paths.data, "snip-clip.png");
    fs.writeFileSync(clipFile, clipPng);
    try {
      const located = await locateByTemplate({ screens, clip: clipFile });
      logHost(
        "info",
        `selectRegion: 匹配 score=${located.score} → 物理 (${located.x},${located.y}) ${located.width}x${located.height}`,
      );
      return { x: located.x, y: located.y, width: located.width, height: located.height };
    } finally {
      fs.rmSync(clipFile, { force: true });
    }
  } finally {
    for (const s of screens) fs.rmSync(s.path, { force: true });
  }
}

interface LocatedRect extends Rect {
  score: number;
}

function locateByTemplate(req: {
  screens: { path: string; x: number; y: number }[];
  clip: string;
}): Promise<LocatedRect> {
  return new Promise((resolve, reject) => {
    const p = spawn("python", [paths.locateRegionScript], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error("locate-region 执行超时"));
    }, 30_000);
    p.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr!.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 python(locate-region 需要 python + opencv): ${e.message}`));
    });
    p.on("exit", () => {
      clearTimeout(timer);
      try {
        const res = JSON.parse(out.trim().split("\n").pop()!);
        if (res.found) resolve(res);
        else {
          reject(
            new Error(
              `截图区域定位失败(score=${res.score ?? "?"}):选区应与当前屏幕内容一致,若屏幕已变化请重选`,
            ),
          );
        }
      } catch {
        reject(new Error(`locate-region 输出解析失败: ${(out || err).slice(0, 200)}`));
      }
    });
    p.stdin!.write(JSON.stringify(req));
    p.stdin!.end();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
