/**
 * 可选卡通描边实验：源图轮廓提炼 → 一格宽路径 → 真色号描边。
 * 不默认接入 generatePattern，不改其签名/返回结构，也不改网页。
 * 不是语义分割；同色、无可见边界的遮挡无法凭空还原。
 */
import { getBrandPalette } from '@/lib/color/palette';
import { rgbToOklab } from '@/lib/color/oklab';
import type { PatternResult } from './generate';
import { buildBackgroundMask, cropImageData, detectSubjectBounds, supersample } from './resample';
import { detectStructuralFeatures, planFeaturePlacement } from './features';
export type OutlineStyle = 'soft' | 'adaptive' | 'ink';
export interface OutlineOptions {
    /** 必须显式开启；渲染样式默认关闭，不写回原图纸。 */
    enabled?: boolean;
    style?: OutlineStyle;
    /** 0 完全关闭；1 使用本档默认阈值。 */
    strength?: number;
    /** 只补外圈时设 false。 */
    internal?: boolean;
    outer?: boolean;
    /** 可选显式保护区；一格一个字节，非零处不允许覆盖。 */
    protectedCells?: ArrayLike<number>;
}
export interface OutlineGuide {
    cols: number;
    rows: number;
    /** 源图两尺度梯度，经非极大值抑制后映射到较暗侧网格。 */
    score: Float32Array;
    sourceLab: Float32Array;
    sourceAlpha: Float32Array;
    protectedCells: Uint8Array;
}
export interface OutlineResult {
    pattern: PatternResult;
    /** 0无 / 1补外圈 / 2内部描边。只表示实际改变的格子。 */
    strokes: Uint8Array;
    diagnostics: {
        style: OutlineStyle;
        outerAdded: number;
        interiorChanged: number;
        protectedCells: number;
        protectedOverwritten: number;
        strokeCode: string | null;
        skippedReason: string | null;
        /** 主体到达画布边界处无法向外扩一格；本版不自动缩小主体。 */
        touchesCanvasEdge: boolean;
        /** 描边有意改变源色；此值只比较原主体，不评价新增外圈。 */
        meanSourceDeltaE: number;
    };
}
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const adjacent = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const around = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
const colorLab = (hex: string) => rgbToOklab(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));
function blur(lab: Float32Array, alpha: Float32Array, w: number, h: number): Float32Array {
    const out = new Float32Array(lab.length);
    const weights = [1, 2, 1];
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (alpha[i] < 0.5)
                continue;
            let sum = 0, L = 0, A = 0, B = 0;
            for (let dy = -1; dy <= 1; dy++)
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = clamp(x + dx, 0, w - 1), ny = clamp(y + dy, 0, h - 1), j = ny * w + nx;
                    const weight = weights[dx + 1] * weights[dy + 1] * alpha[j];
                    sum += weight;
                    L += lab[j * 3] * weight;
                    A += lab[j * 3 + 1] * weight;
                    B += lab[j * 3 + 2] * weight;
                }
            if (sum) {
                out[i * 3] = L / sum;
                out[i * 3 + 1] = A / sum;
                out[i * 3 + 2] = B / sum;
            }
        }
    return out;
}
/** 与当前 generatePattern 相同的裁切、背景与 fit，防止轮廓图错位。 */
export function buildOutlineGuide(image: ImageData, pattern: PatternResult, options: {
    backgroundTolerance?: number;
} = {}): OutlineGuide {
    const { cols, rows, meta } = pattern;
    let src = image;
    if (meta.autoCrop) {
        const b = detectSubjectBounds(image, 0.10);
        if (b && (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) < image.width * image.height * .97)
            src = cropImageData(image, b);
    }
    let mask: Float32Array | null = null;
    if (meta.background === 'ignore') {
        let transparent = false;
        for (let i = 3; i < src.data.length; i += 28)
            if (src.data[i] < 250) {
                transparent = true;
                break;
            }
        if (!transparent)
            mask = buildBackgroundMask(src, options.backgroundTolerance ?? 0.10)?.mask ?? null;
    }
    // 大网格的轮廓副本用2倍采样，避免可选样式挤占原量化流程的性能预算。
    const ss = Math.max(cols, rows) > 128 ? 2 : 3, { gw: w, gh: h, lab, alpha } = supersample(src, cols, rows, meta.fit, ss, mask);
    const fine = blur(lab, alpha, w, h), coarse = blur(fine, alpha, w, h);
    const magnitude = new Float32Array(w * h), gx = new Float32Array(w * h), gy = new Float32Array(w * h), darkX = new Float32Array(w * h), darkY = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            if (alpha[i] < .8 || alpha[i - 1] < .8 || alpha[i + 1] < .8 || alpha[i - w] < .8 || alpha[i + w] < .8)
                continue;
            let f2 = 0, c2 = 0, max = 0;
            for (let k = 0; k < 3; k++) {
                const dx = (fine[(i + 1) * 3 + k] - fine[(i - 1) * 3 + k]) * .5, dy = (fine[(i + w) * 3 + k] - fine[(i - w) * 3 + k]) * .5;
                const cx = (coarse[(i + 1) * 3 + k] - coarse[(i - 1) * 3 + k]) * .5, cy = (coarse[(i + w) * 3 + k] - coarse[(i - w) * 3 + k]) * .5;
                const weight = k === 0 ? .85 : 1.6, v = weight * (dx * dx + dy * dy);
                f2 += v;
                c2 += weight * (cx * cx + cy * cy);
                if (v > max) {
                    max = v;
                    gx[i] = dx;
                    gy[i] = dy;
                }
                if (k === 0) {
                    darkX[i] = dx;
                    darkY[i] = dy;
                }
            }
            // 缓慢的同色阴影坡面不应变成脸上的黑疤；要求局部边界比粗尺度更尖锐。
            const sharpness = Math.sqrt(f2) / Math.max(.0001, Math.sqrt(c2));
            if (sharpness < 1.18)
                continue;
            const norm = Math.hypot(gx[i], gy[i]);
            const dx = norm ? Math.round(gx[i] / norm * ss) : 0, dy = norm ? Math.round(gy[i] / norm * ss) : 0;
            const a = clamp(y - dy, 0, h - 1) * w + clamp(x - dx, 0, w - 1), b = clamp(y + dy, 0, h - 1) * w + clamp(x + dx, 0, w - 1);
            const chromaJump = Math.hypot(fine[a * 3 + 1] - fine[b * 3 + 1], fine[a * 3 + 2] - fine[b * 3 + 2]);
            const hasDarkSide = Math.min(fine[a * 3], fine[b * 3]) < .40;
            if (chromaJump < .045 && !hasDarkSide)
                continue;
            magnitude[i] = Math.min(Math.sqrt(f2), Math.sqrt(c2) * 1.3) * ss;
        }
    const score = new Float32Array(cols * rows), sourceLab = new Float32Array(cols * rows * 3), sourceAlpha = new Float32Array(cols * rows);
    for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
            const i = y * w + x, m = magnitude[i];
            if (m < .018)
                continue;
            const ax = Math.abs(gx[i]), ay = Math.abs(gy[i]);
            let step;
            if (ay < ax * .4142)
                step = 1;
            else if (ax < ay * .4142)
                step = w;
            else
                step = gx[i] * gy[i] >= 0 ? w + 1 : w - 1;
            if (m < magnitude[i - step] || m < magnitude[i + step])
                continue;
            const norm = Math.hypot(darkX[i], darkY[i]);
            const ox = norm > .005 ? -.20 * darkX[i] / norm : 0, oy = norm > .005 ? -.20 * darkY[i] / norm : 0;
            const cx = clamp(Math.floor((x + .5) / ss + ox), 0, cols - 1), cy = clamp(Math.floor((y + .5) / ss + oy), 0, rows - 1), j = cy * cols + cx;
            score[j] = Math.max(score[j], m);
        }
    for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
            const i = y * cols + x;
            let sum = 0;
            for (let dy = 0; dy < ss; dy++)
                for (let dx = 0; dx < ss; dx++) {
                    const j = (y * ss + dy) * w + x * ss + dx, a = alpha[j];
                    sum += a;
                    for (let k = 0; k < 3; k++)
                        sourceLab[i * 3 + k] += lab[j * 3 + k] * a;
                }
            sourceAlpha[i] = sum / (ss * ss);
            if (sum)
                for (let k = 0; k < 3; k++)
                    sourceLab[i * 3 + k] /= sum;
        }
    const candidates = getBrandPalette(meta.brand);
    const features = detectStructuralFeatures(src, mask, { maxAreaFrac: .025 });
    const plan = planFeaturePlacement(features, { cols, rows, srcW: src.width, srcH: src.height, fit: meta.fit,
        lightCandidates: candidates.filter(c => c.lab.L > .86 && Math.hypot(c.lab.a, c.lab.b) < .08),
        darkCandidates: candidates.filter(c => c.lab.L < .36 && Math.hypot(c.lab.a, c.lab.b) < .10) });
    const protectedCells = Uint8Array.from(plan.polarity, x => x === 1 ? 1 : 0);
    // 保住已经存在的小眼白、高光及独立强调色，描边不负责重新安排它们。
    const seen = new Uint8Array(cols * rows), labs = pattern.palette.map(p => colorLab(p.hex));
    for (let i = 0; i < seen.length; i++) {
        if (seen[i] || pattern.cells[i] < 0)
            continue;
        const color = pattern.cells[i], q = [i];
        seen[i] = 1;
        for (let t = 0; t < q.length; t++) {
            const j = q[t], x = j % cols, y = Math.floor(j / cols);
            for (const [dx, dy] of adjacent) {
                const nx = x + dx, ny = y + dy, k = ny * cols + nx;
                if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || seen[k] || pattern.cells[k] !== color)
                    continue;
                seen[k] = 1;
                q.push(k);
            }
        }
        const l = labs[color];
        if (q.length <= 3 || (q.length <= Math.max(8, cols * rows * .03) && l.L > .86 && Math.hypot(l.a, l.b) < .08))
            for (const j of q)
                protectedCells[j] = 1;
    }
    return { cols, rows, score, sourceLab, sourceAlpha, protectedCells };
}
function thin(mask: Uint8Array, w: number, h: number): void {
    for (let iter = 0; iter < 24; iter++) {
        let changes = 0;
        for (let pass = 0; pass < 2; pass++) {
            const drop: number[] = [];
            for (let y = 1; y < h - 1; y++)
                for (let x = 1; x < w - 1; x++) {
                    const i = y * w + x;
                    if (!mask[i])
                        continue;
                    const p = around.map(([dx, dy]) => mask[(y + dy) * w + x + dx]), n = p.reduce((a, b) => a + b, 0);
                    if (n < 2 || n > 6)
                        continue;
                    let transitions = 0;
                    for (let k = 0; k < 8; k++)
                        if (!p[k] && p[(k + 1) % 8])
                            transitions++;
                    if (transitions !== 1)
                        continue;
                    if (pass === 0 ? (p[0] * p[2] * p[4] || p[2] * p[4] * p[6]) : (p[0] * p[2] * p[6] || p[0] * p[4] * p[6]))
                        continue;
                    drop.push(i);
                }
            for (const i of drop)
                mask[i] = 0;
            changes += drop.length;
        }
        if (!changes)
            break;
    }
}
/**
 * 基线图纸不变；返回新的 cells/palette 和独立诊断。背景须已正确分离。
 * 未预留深色且色位已满时明确跳过，不删除眼白/强调色以强行塞入黑色。
 */
export function applyCartoonOutline(pattern: PatternResult, guide: OutlineGuide, options: OutlineOptions = {}): OutlineResult {
    const { cols, rows } = pattern, n = cols * rows;
    if (guide.cols !== cols || guide.rows !== rows || guide.score.length !== n || guide.protectedCells.length !== n || guide.sourceAlpha.length !== n || guide.sourceLab.length !== n * 3)
        throw new RangeError('Outline guide dimensions do not match pattern');
    const style = options.style ?? 'adaptive', strength = clamp(Number.isFinite(options.strength) ? options.strength! : 1, 0, 1);
    const protect = Uint8Array.from(guide.protectedCells, (x, i) => x || options.protectedCells?.[i] ? 1 : 0), strokes = new Uint8Array(n);
    const diagnostics: OutlineResult['diagnostics'] = { style, outerAdded: 0, interiorChanged: 0, protectedCells: protect.reduce((a, b) => a + b, 0), protectedOverwritten: 0, strokeCode: null, skippedReason: null, touchesCanvasEdge: false, meanSourceDeltaE: pattern.meanDeltaE };
    if (options.enabled !== true || strength === 0) {
        diagnostics.skippedReason = 'disabled';
        return { pattern, strokes, diagnostics };
    }
    const labs = pattern.palette.map(p => colorLab(p.hex));
    let ink = labs.reduce((best, l, i) => l.L < labs[best].L ? i : best, 0);
    const palette = pattern.palette.map(p => ({ ...p }));
    if (!labs.length || labs[ink].L > (style === 'soft' ? .42 : .32)) {
        const neutral = getBrandPalette(pattern.meta.brand).filter(c => Math.hypot(c.lab.a, c.lab.b) < .06);
        neutral.sort((a, b) => Math.abs(a.lab.L - (style === 'soft' ? .30 : .20)) - Math.abs(b.lab.L - (style === 'soft' ? .30 : .20)));
        const chosen = neutral[0];
        if (!chosen) {
            diagnostics.skippedReason = 'no-brand-stroke-color';
            return { pattern, strokes, diagnostics };
        }
        ink = palette.findIndex(p => p.code === chosen.code && p.hex === chosen.hex);
        if (ink < 0) {
            if (palette.length >= pattern.meta.colorLimit) {
                diagnostics.skippedReason = 'no-free-color-slot';
                return { pattern, strokes, diagnostics };
            }
            ink = palette.length;
            palette.push({ index: ink, hex: chosen.hex, code: chosen.code, rgb: chosen.rgb, count: 0, ratio: 0 });
            labs.push(chosen.lab);
        }
    }
    diagnostics.strokeCode = palette[ink].code;
    const filled = (i: number) => i >= 0 && i < n && pattern.cells[i] >= 0;
    const exterior = new Uint8Array(n), queue: number[] = [];
    const seed = (i: number) => { if (!filled(i) && !exterior[i]) {
        exterior[i] = 1;
        queue.push(i);
    } };
    for (let x = 0; x < cols; x++) {
        seed(x);
        seed((rows - 1) * cols + x);
    }
    for (let y = 0; y < rows; y++) {
        seed(y * cols);
        seed(y * cols + cols - 1);
    }
    for (let t = 0; t < queue.length; t++) {
        const i = queue[t], x = i % cols, y = Math.floor(i / cols);
        for (const [dx, dy] of adjacent) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < cols && ny < rows)
                seed(ny * cols + nx);
        }
    }
    const nearOutside = new Uint8Array(n);
    for (let i = 0; i < n; i++)
        if (filled(i)) {
            const x = i % cols, y = Math.floor(i / cols);
            if (!x || !y || x === cols - 1 || y === rows - 1)
                diagnostics.touchesCanvasEdge = true;
            for (const [dx, dy] of around) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || !filled(ny * cols + nx)) {
                    nearOutside[i] = 1;
                    break;
                }
            }
        }
    const nearProtected = new Uint8Array(protect);
    for (let i = 0; i < n; i++)
        if (protect[i]) {
            const x = i % cols, y = Math.floor(i / cols);
            for (const [dx, dy] of around) {
                const nx = x + dx, ny = y + dy;
                if (nx >= 0 && ny >= 0 && nx < cols && ny < rows)
                    nearProtected[ny * cols + nx] = 1;
            }
        }
    const candidate = new Uint8Array(n), high = (style === 'soft' ? .19 : style === 'ink' ? .085 : .13) / (.5 + .5 * strength), low = high * .52;
    const edgeQueue: number[] = [];
    if (options.internal !== false) {
        for (let i = 0; i < n; i++)
            if (filled(i) && !nearProtected[i] && !nearOutside[i] && guide.score[i] >= high) {
                candidate[i] = 1;
                edgeQueue.push(i);
            }
        for (let t = 0; t < edgeQueue.length; t++) {
            const i = edgeQueue[t], x = i % cols, y = Math.floor(i / cols);
            for (const [dx, dy] of around) {
                const nx = x + dx, ny = y + dy, j = ny * cols + nx;
                if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || candidate[j] || !filled(j) || nearProtected[j] || nearOutside[j] || guide.score[j] < low)
                    continue;
                candidate[j] = 1;
                edgeQueue.push(j);
            }
        }
        thin(candidate, cols, rows);
        const seen = new Uint8Array(n);
        for (let i = 0; i < n; i++)
            if (candidate[i] && !seen[i]) {
                const q = [i];
                seen[i] = 1;
                for (let t = 0; t < q.length; t++) {
                    const j = q[t], x = j % cols, y = Math.floor(j / cols);
                    for (const [dx, dy] of around) {
                        const nx = x + dx, ny = y + dy, k = ny * cols + nx;
                        if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && candidate[k] && !seen[k]) {
                            seen[k] = 1;
                            q.push(k);
                        }
                    }
                }
                if (q.length < (style === 'ink' ? 2 : 3))
                    for (const j of q)
                        candidate[j] = 0;
            }
    }
    const cells = new Int16Array(pattern.cells);
    // 按整条路径取舍，禁止按分数截断成断续黑点。
    const paths: {
        cells: number[];
        score: number;
    }[] = [], seenPath = new Uint8Array(n);
    for (let i = 0; i < n; i++)
        if (candidate[i] && !seenPath[i]) {
            const q = [i];
            seenPath[i] = 1;
            let score = 0;
            for (let t = 0; t < q.length; t++) {
                const j = q[t], x = j % cols, y = Math.floor(j / cols);
                score += guide.score[j];
                for (const [dx, dy] of around) {
                    const nx = x + dx, ny = y + dy, k = ny * cols + nx;
                    if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && candidate[k] && !seenPath[k]) {
                        seenPath[k] = 1;
                        q.push(k);
                    }
                }
            }
            paths.push({ cells: q, score: score / q.length });
        }
    paths.sort((a, b) => b.score - a.score);
    const budget = Math.floor(pattern.totalBeads * (style === 'ink' ? .12 : style === 'soft' ? .035 : .065) * strength);
    let changed = 0;
    const smallComponent = (data: Int16Array, start: number) => { const color = data[start], q = [start], seen = new Set([start]); for (let t = 0; t < q.length && q.length < 3; t++) {
        const j = q[t], x = j % cols, y = Math.floor(j / cols);
        for (const [dx, dy] of adjacent) {
            const nx = x + dx, ny = y + dy, k = ny * cols + nx;
            if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && !seen.has(k) && data[k] === color) {
                seen.add(k);
                q.push(k);
            }
        }
    } return q.length < 3; };
    for (const path of paths) {
        const edits = path.cells.filter(i => labs[cells[i]].L > labs[ink].L + .07);
        if (!edits.length || changed + edits.length > budget)
            continue;
        const previous = edits.map(i => cells[i]);
        for (const i of edits)
            cells[i] = ink;
        let fragments = false;
        for (const i of edits) {
            const x = i % cols, y = Math.floor(i / cols);
            for (const [dx, dy] of adjacent) {
                const nx = x + dx, ny = y + dy, j = ny * cols + nx;
                if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || cells[j] < 0 || cells[j] === ink)
                    continue;
                if (smallComponent(cells, j) && !smallComponent(pattern.cells, j)) {
                    fragments = true;
                    break;
                }
            }
            if (fragments)
                break;
        }
        if (fragments) {
            edits.forEach((i, k) => { cells[i] = previous[k]; });
            continue;
        }
        for (const i of edits)
            strokes[i] = 2;
        changed += edits.length;
    }
    diagnostics.interiorChanged = changed;
    if (options.outer !== false) {
        for (let i = 0; i < n; i++)
            if (exterior[i] && !protect[i]) {
                const x = i % cols, y = Math.floor(i / cols);
                let light = 0, dark = 0;
                for (const [dx, dy] of around) {
                    const nx = x + dx, ny = y + dy, j = ny * cols + nx;
                    if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && filled(j)) {
                        if (labs[pattern.cells[j]].L < .42)
                            dark++;
                        else
                            light++;
                    }
                }
                // 原图已有深色边的位置不再外扩，避免一圈变两圈。
                if (light > dark && light > 0) {
                    cells[i] = ink;
                    strokes[i] = 1;
                    diagnostics.outerAdded++;
                }
            }
    }
    if (!diagnostics.outerAdded && !diagnostics.interiorChanged)
        return { pattern, strokes, diagnostics };
    let total = 0, error = 0, weight = 0;
    const counts = new Int32Array(palette.length);
    for (let i = 0; i < n; i++) {
        if (cells[i] >= 0) {
            counts[cells[i]]++;
            total++;
        }
        if (protect[i] && cells[i] !== pattern.cells[i])
            diagnostics.protectedOverwritten++;
        if (pattern.cells[i] >= 0 && cells[i] >= 0 && guide.sourceAlpha[i] > .1) {
            const l = labs[cells[i]], dL = l.L - guide.sourceLab[i * 3], dA = l.a - guide.sourceLab[i * 3 + 1], dB = l.b - guide.sourceLab[i * 3 + 2];
            error += Math.hypot(dL, dA, dB) * guide.sourceAlpha[i];
            weight += guide.sourceAlpha[i];
        }
    }
    const remap = new Int16Array(palette.length).fill(-1), used = palette.filter((p, i) => counts[i] > 0).map(p => { const old = p.index, index = counts.slice(0, old).filter(c => c > 0).length; remap[old] = index; return { ...p, index, count: counts[old], ratio: counts[old] / Math.max(1, total) }; });
    for (let i = 0; i < n; i++)
        if (cells[i] >= 0)
            cells[i] = remap[cells[i]];
    diagnostics.meanSourceDeltaE = weight ? error / weight : 0;
    return { pattern: { ...pattern, cells, palette: used, totalBeads: total, meanDeltaE: diagnostics.meanSourceDeltaE }, strokes, diagnostics };
}
