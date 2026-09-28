"""Tile similarity matching (PRD sections 2.D / 16 / 17).

V1 approach: zero-mean normalised cross-correlation (NCC) between 32x32
grayscale templates, combined with an HSV colour histogram similarity:

    score = 0.5 * ncc_similarity + 0.5 * histogram_similarity

NCC replaces the originally suggested pHash: measured on flat game icons,
pHash bits are unstable (low-frequency DCT coefficients hover around the
median, so a 1px shift looks like a different tile), while NCC keeps a wide
margin between re-captures of the same tile and different tiles. Both are
equally simple; only the empirical margin differs.

Tiles are grouped by sequentially comparing each tile against each existing
group representative (plain O(N^2), N is small).
"""
from __future__ import annotations

import cv2
import numpy as np

TEMPLATE_SIZE = 32

NCC_WEIGHT = 0.5
HIST_WEIGHT = 0.5

FEATURE_TEMPLATE = 0
FEATURE_HIST = 1


def _l1_normalize(hist: np.ndarray) -> np.ndarray:
    total = float(hist.sum())
    return hist / total if total > 0 else hist


class TileMatcher:
    def __init__(self, threshold: float = 0.8):
        if not 0.0 < threshold <= 1.0:
            raise ValueError("threshold must be in (0, 1]")
        self.threshold = threshold
        self.last_threshold = threshold

    # -- features ----------------------------------------------------------
    def extract_feature(self, image: np.ndarray) -> tuple:
        """Return (32x32 gray template, HSV hist) for one tile image.

        The tile is first reduced to its icon via Otsu segmentation and
        cropped to the icon's bounding box. This normalises away position
        and scale differences between captures of the same icon (grid
        misalignment, different render states), which otherwise split
        identical tiles into different type ids.
        """
        crop = self._icon_crop(image)

        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        template = cv2.resize(gray, (TEMPLATE_SIZE, TEMPLATE_SIZE),
                              interpolation=cv2.INTER_AREA).astype(np.float32)

        hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1, 2], None, [8, 4, 4],
                            [0, 180, 0, 256, 0, 256])
        cv2.normalize(hist, hist)
        return (template, hist.flatten())

    def _icon_crop(self, image: np.ndarray) -> np.ndarray:
        """Crop to the icon's bounding box; fall back to the full tile when
        segmentation is not confident (icon tone too close to cell bg)."""
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        mask = cv2.threshold(gray, 0, 255,
                             cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
        coverage = float(np.count_nonzero(mask)) / mask.size
        if coverage > 0.5:  # wrong polarity (bg brighter than icon)
            mask = cv2.bitwise_not(mask)
            coverage = 1.0 - coverage
        if coverage < 0.05 or coverage > 0.8:
            return image
        ys, xs = np.where(mask > 0)
        h, w = gray.shape
        pad = 2
        y0, y1 = max(int(ys.min()) - pad, 0), min(int(ys.max()) + pad + 1, h)
        x0, x1 = max(int(xs.min()) - pad, 0), min(int(xs.max()) + pad + 1, w)
        if y1 - y0 < 8 or x1 - x0 < 8:
            return image
        return image[y0:y1, x0:x1]

    # -- similarity ----------------------------------------------------------
    def similarity(self, feature_a: tuple, feature_b: tuple) -> float:
        ncc_sim = self._ncc_similarity(
            feature_a[FEATURE_TEMPLATE], feature_b[FEATURE_TEMPLATE]
        )
        hist_sim = self._hist_similarity(
            feature_a[FEATURE_HIST], feature_b[FEATURE_HIST]
        )
        return NCC_WEIGHT * ncc_sim + HIST_WEIGHT * hist_sim

    @staticmethod
    def _ncc_similarity(template_a: np.ndarray, template_b: np.ndarray) -> float:
        a = template_a - template_a.mean()
        b = template_b - template_b.mean()
        norm = float(np.linalg.norm(a) * np.linalg.norm(b))
        if norm == 0.0:
            return 1.0  # both tiles uniform -> treat as identical
        return float(np.clip((a * b).sum() / norm, 0.0, 1.0))

    @staticmethod
    def _hist_similarity(hist_a: np.ndarray, hist_b: np.ndarray) -> float:
        h_a = hist_a.reshape(8, 4, 4)
        h_b = hist_b.reshape(8, 4, 4)
        distance = cv2.compareHist(h_a, h_b, cv2.HISTCMP_BHATTACHARYYA)
        return 1.0 - float(distance)

    def is_similar(self, feature_a: tuple, feature_b: tuple) -> bool:
        return self.similarity(feature_a, feature_b) >= self.threshold

    # -- classification --------------------------------------------------------
    def classify(self, tiles) -> list[int | None]:
        """Assign type ids (1-based) by sequential clustering.

        Each group's representative is the running MEAN of its members'
        features (averaged template, averaged histogram), not the first
        member — this keeps groups stable when capture order would
        otherwise drift the comparison anchor.

        Empty tiles keep type_id None. Returns one id per input tile,
        aligned with the input order.
        """
        rep_sums: list[list[np.ndarray]] = []  # per group: [template_sum, hist_sum]
        rep_counts: list[int] = []
        ids: list[int | None] = []
        for tile in tiles:
            if tile.empty:
                ids.append(None)
                continue
            tile.feature = self.extract_feature(tile.image)
            assigned = None
            for group_id, rep in enumerate(self._representatives(rep_sums, rep_counts)):
                if self.is_similar(tile.feature, rep):
                    assigned = group_id + 1
                    break
            if assigned is None:
                rep_sums.append([tile.feature[0].copy(), tile.feature[1].copy()])
                rep_counts.append(1)
                assigned = len(rep_sums)
            else:
                sums = rep_sums[assigned - 1]
                sums[0] += tile.feature[0]
                sums[1] += tile.feature[1]
                rep_counts[assigned - 1] += 1
            tile.type_id = assigned
            ids.append(assigned)
        return ids

    @staticmethod
    def _representatives(sums: list, counts: list):
        for i, (template_sum, hist_sum) in enumerate(sums):
            n = max(counts[i], 1)
            yield (template_sum / n, _l1_normalize(hist_sum / n))

    # -- debug helper --------------------------------------------------------
    def similarity_matrix(self, tiles) -> list[list[float | None]]:
        """Pairwise scores between all non-empty tiles (for debug output)."""
        features = [self.extract_feature(t.image) for t in tiles if not t.empty]
        n = len(features)
        matrix: list[list[float | None]] = [[None] * n for _ in range(n)]
        for i in range(n):
            for j in range(n):
                matrix[i][j] = (
                    round(self.similarity(features[i], features[j]), 4)
                    if i != j
                    else 1.0
                )
        return matrix
