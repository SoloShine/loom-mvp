# 在整屏物理截图中定位框选小图(模板匹配),像素级找回其矩形。
# 由 host 的 screen.selectRegion 调用:stdin 进一份 JSON,stdout 出一份 JSON。
# 请求:{"screens": [{"path": "...", "x": int, "y": int}], "clip": "path"}
#   screens 为各显示器的整屏物理截图及其全局物理原点;clip 为用户框选的图。
# 响应:{"found": bool, "x", "y", "width", "height", "score"}(全局物理坐标)
import json
import sys

import cv2


def main() -> int:
    req = json.loads(sys.stdin.read())
    clip = cv2.imread(req["clip"], cv2.IMREAD_COLOR)
    if clip is None:
        print(json.dumps({"found": False, "error": "cannot read clip image"}))
        return 0
    needle = cv2.cvtColor(clip, cv2.COLOR_BGR2GRAY)

    best = None
    for screen in req.get("screens", []):
        hay_img = cv2.imread(screen["path"], cv2.IMREAD_COLOR)
        if hay_img is None:
            continue
        hay = cv2.cvtColor(hay_img, cv2.COLOR_BGR2GRAY)
        if hay.shape[0] < needle.shape[0] or hay.shape[1] < needle.shape[1]:
            continue
        result = cv2.matchTemplate(hay, needle, cv2.TM_CCOEFF_NORMED)
        _, score, _, loc = cv2.minMaxLoc(result)
        cand = {
            "score": round(float(score), 4),
            "x": int(screen["x"]) + int(loc[0]),
            "y": int(screen["y"]) + int(loc[1]),
            "width": int(needle.shape[1]),
            "height": int(needle.shape[0]),
        }
        if best is None or cand["score"] > best["score"]:
            best = cand

    if best is None:
        print(json.dumps({"found": False, "error": "no screens to match"}))
    elif best["score"] < 0.8:
        best["found"] = False
        print(json.dumps(best))
    else:
        best["found"] = True
        print(json.dumps(best))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
