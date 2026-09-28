"""概率聚类分类器:不依赖任何持久化图库,状态全部来自当前截图。

模型:
  1. 特征 = 先 Otsu 分割出图标主体裁掉背景(图块半透明,背景会随位置
     泄漏进裁剪:既拉低同类的跨背景相似度,又让"浅底居中深色块"的
     不同图案互相撞车),再取 32x32 灰度模板 + HSV 8x4x4 直方图;
     相似度 = 0.5*去均值 NCC + 0.5*(1-Bhattacharyya)。
     颜色通道的依据:本游戏不存在同图不同色的图块,颜色不同必为异类。
  2. 相似度分布 = 同类/异类两分量混合,EM 估计两分量的均值/方差与占比,
     得到 p_same(sim) = P(同类 | 相似度)。
  3. 聚类 = 概率凝聚:每次合并对数似然增益最大的两簇
     Δ = Σ_{a∈A,b∈B} log-odds(p_same) + 奇偶先验
     (合并后簇为偶数 → +λ;为奇数 → −λ;连连看每种图案必成对)。
     Δ ≤ 0 即停止。图案的判定不依赖任何阈值硬切,由似然+成对先验共同决定。

换游戏/换分辨率零迁移:模型每盘从当前截图重建。
"""
from __future__ import annotations

import math

import cv2
import numpy as np

TEMPLATE_SIZE = 32
NCC_WEIGHT = 0.5
HIST_WEIGHT = 0.5


class ProbClassifier:
    def __init__(self, ref: float = 0.75):
        """ref:参考中心 μ0(用户可调);EM 在其附近收敛。"""
        if not 0.0 < ref <= 1.0:
            raise ValueError("ref must be in (0, 1]")
        self.ref = ref
        self.mu = ref
        self.stats = {}

    # -- 特征与相似度 -------------------------------------------------------
    def feature(self, image: np.ndarray) -> tuple:
        """(图标裁剪后的 32x32 灰度模板, 图标像素的归一化 HSV 直方图)。"""
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        mask = cv2.threshold(gray, 0, 255,
                             cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
        coverage = float(np.count_nonzero(mask)) / mask.size
        if coverage > 0.5:  # 极性反了(背景比图标亮)
            mask = cv2.bitwise_not(mask)
            coverage = 1.0 - coverage
        crop = image
        if 0.05 <= coverage <= 0.8:
            ys, xs = np.where(mask > 0)
            h, w = gray.shape
            pad = 2
            y0, y1 = max(int(ys.min()) - pad, 0), min(int(ys.max()) + pad + 1, h)
            x0, x1 = max(int(xs.min()) - pad, 0), min(int(xs.max()) + pad + 1, w)
            if y1 - y0 >= 8 and x1 - x0 >= 8:
                crop = image[y0:y1, x0:x1]
                # 注:直方图统计裁剪区域整体而非仅掩膜内像素 —— 掩膜在
                # 浅色/描边图标上不稳定,逐块抖动反而把同类拆开(实测回退)

        template = cv2.resize(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY),
                              (TEMPLATE_SIZE, TEMPLATE_SIZE),
                              interpolation=cv2.INTER_AREA).astype(np.float32)
        hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1, 2], None, [8, 4, 4],
                            [0, 180, 0, 256, 0, 256])
        cv2.normalize(hist, hist)
        return (template, hist.flatten())

    @staticmethod
    def similarity(a: tuple, b: tuple) -> float:
        ta, tb = a[0], b[0]
        am, bm = float(ta.mean()), float(tb.mean())
        a0, b0 = ta - am, tb - bm
        na, nb = float(np.linalg.norm(a0)), float(np.linalg.norm(b0))
        if na == 0.0 or nb == 0.0:
            # 均匀图块(合成盘的纯色块)NCC 无定义,用亮度差判别
            ncc = 1.0 if abs(am - bm) < 2.0 else 0.0
        else:
            ncc = float(np.clip((a0 * b0).sum() / (na * nb), 0.0, 1.0))
        d = cv2.compareHist(a[1].reshape(8, 4, 4).astype(np.float32),
                            b[1].reshape(8, 4, 4).astype(np.float32),
                            cv2.HISTCMP_BHATTACHARYYA)
        return NCC_WEIGHT * ncc + HIST_WEIGHT * (1.0 - float(d))

    # -- 概率模型 -------------------------------------------------------------
    def _fit_mixture(self, sims: np.ndarray) -> None:
        """两分量高斯 EM:低分量=异类,高分量=同类。

        同类分量中心锚定在参考 μ(用户滑块)附近 ±0.10,不许自由漂移。
        满盘时异类对占绝对多数且挤在 0 附近,无锚定的 EM 会让同类分量
        坍缩到异类主体上(实测 mu1 从 0.9 滑到 0.27)——两个分量一起趴
        在低区,p_same 在中等相似度全面虚高,聚类把大半棋盘并成几类。
        """
        s = np.clip(sims, 0.0, 1.0)
        mu1_floor = max(0.05, self.ref - 0.10)
        mu0, mu1 = max(0.05, self.ref - 0.30), min(0.98, self.ref + 0.10)
        sd0 = sd1 = 0.12
        pi = 0.15
        for _ in range(24):
            p1 = pi * _norm_pdf(s, mu1, sd1) / (
                pi * _norm_pdf(s, mu1, sd1) + (1 - pi) * _norm_pdf(s, mu0, sd0) + 1e-12
            )
            w = float(p1.sum())
            if w < 1e-6:
                break
            mu1 = max(float((p1 * s).sum() / w), mu1_floor)  # 锚定
            sd1 = float(max(0.04, np.sqrt((p1 * (s - mu1) ** 2).sum() / w)))
            rest = max(len(s) - w, 1e-6)
            mu0 = float(((1 - p1) * s).sum() / rest)
            sd0 = float(max(0.05, np.sqrt(((1 - p1) * (s - mu0) ** 2).sum() / rest)))
            # 真实同类对占比 ≈ 1/图案数(满盘 K~25 → ~4%);夹在合理区间,
            # 防止 EM 把同类分量占比挤没(挤没了分量就死了)
            pi = float(min(max(w / len(s), 0.01), 0.35))
            if mu1 <= mu0:  # 秩约束:同类分量必须在异类之上
                mu1, mu0 = max(mu0 + 0.05, mu1), mu0
        self.mu, self.stats = mu1, {
            "mu_same": round(mu1, 3),
            "mu_diff": round(mu0, 3),
            "sd_same": round(sd1, 3),
            "sd_diff": round(sd0, 3),
            "pi_same": round(pi, 3),
        }
        self._mu0, self._sd0, self._sd1, self._pi = mu0, sd0, sd1, max(min(pi, 0.9), 0.02)

    def _p_same(self, s: float) -> float:
        num = self._pi * _norm_pdf(s, self.mu, self._sd1)
        den = num + (1 - self._pi) * _norm_pdf(s, self._mu0, self._sd0) + 1e-12
        return float(min(max(num / den, 1e-4), 1 - 1e-4))

    # -- 分类 -----------------------------------------------------------------
    def classify(self, tiles, ref: float | None = None) -> None:
        """ assigns tile.type_id (1..K) 与 tile.confidence (合并时的 p_same)。"""
        if ref is not None:
            self.ref = ref
        nonempty = [t for t in tiles if not t.empty]
        n = len(nonempty)
        if n == 0:
            return
        feats = [self.feature(t.image) for t in nonempty]
        sims = np.zeros((n, n))
        for i in range(n):
            for j in range(i + 1, n):
                s = self.similarity(feats[i], feats[j])
                sims[i][j] = sims[j][i] = s
        self._fit_mixture(sims[np.triu_indices(n, 1)])

        # 概率凝聚聚类
        clusters: list[list[int]] = [[i] for i in range(n)]
        conf: dict[int, float] = {}
        while len(clusters) > 1:
            best = None  # (delta, ia, ib, p)
            for ia in range(len(clusters)):
                for ib in range(ia + 1, len(clusters)):
                    ps = [self._p_same(sims[i][j]) for i in clusters[ia] for j in clusters[ib]]
                    ll = sum(math.log(p) - math.log(1 - p) for p in ps)
                    size = len(clusters[ia]) + len(clusters[ib])
                    bonus = 0.35 if size % 2 == 0 else -0.35  # 奇偶先验:成对规则
                    delta = ll + bonus
                    p_mean = sum(ps) / len(ps)
                    if best is None or delta > best[0]:
                        best = (delta, ia, ib, p_mean)
            delta, ia, ib, p_mean = best
            if delta <= 0:
                break
            merged = clusters[ia] + clusters[ib]
            for i in merged:
                conf[i] = max(conf.get(i, 0.0), p_mean)
            clusters = [c for k, c in enumerate(clusters) if k not in (ia, ib)] + [merged]

        # 簇按首次出现顺序编号
        remap: dict[int, int] = {}
        for k, t in enumerate(nonempty):
            gid = next(g for g, c in enumerate(clusters) if k in c)
            if gid not in remap:
                remap[gid] = len(remap) + 1
            t.type_id = remap[gid]
            t.confidence = round(conf.get(k, 0.0), 3)
            t.feature = feats[k]


def _norm_pdf(x, mu: float, sd: float):
    z = (x - mu) / sd
    return np.exp(-0.5 * z * z) / (sd * math.sqrt(2 * math.pi))
