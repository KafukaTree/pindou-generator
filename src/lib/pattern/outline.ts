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
    /** 粗细0/1/2：标准、2×2核、3×3核；保留亮特征、色块核心和狭窄空隙。 */
    thickness?: number;
    /** 尚未稳健的同色部件分割实验；默认关闭。 */
    experimentalParts?: boolean;
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
    /** 同色结构的弱分界；只接受两端接上强线/外轮廓的连续段。 */
    occlusionScore?: Float32Array;
    sourceLab: Float32Array;
    sourceAlpha: Float32Array;
    protectedCells: Uint8Array;
}
export interface OutlineResult {
    pattern: PatternResult;
    /** 0无 / 1外轮廓 / 2内部描边。只表示实际改变的格子。 */
    strokes: Uint8Array;
    /** 含原本已经为黑色的轮廓格，供粗细扩张和预览使用。 */
    outlineMask: Uint8Array;
    diagnostics: {
        style: OutlineStyle;
        outerAdded: number;
        outerDarkened: number;
        interiorChanged: number;
        occlusionCandidates: number;
        fragmentsAbsorbed: number;
        acceptedPaths: number;
        rejectedPaths: number;
        thickened: number;
        thickness: number;
        partSeams: number;
        partCoreCells: number;
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
    const magnitude = new Float32Array(w * h), weakMagnitude = new Float32Array(w * h), gx = new Float32Array(w * h), gy = new Float32Array(w * h), darkX = new Float32Array(w * h), darkY = new Float32Array(w * h);
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
            weakMagnitude[i] = Math.min(Math.sqrt(f2), Math.sqrt(c2) * 1.3) * ss;
            const norm = Math.hypot(gx[i], gy[i]);
            const dx = norm ? Math.round(gx[i] / norm * ss) : 0, dy = norm ? Math.round(gy[i] / norm * ss) : 0;
            const a = clamp(y - dy, 0, h - 1) * w + clamp(x - dx, 0, w - 1), b = clamp(y + dy, 0, h - 1) * w + clamp(x + dx, 0, w - 1);
            const chromaJump = Math.hypot(fine[a * 3 + 1] - fine[b * 3 + 1], fine[a * 3 + 2] - fine[b * 3 + 2]);
            const hasDarkSide = Math.min(fine[a * 3], fine[b * 3]) < .40;
            if (chromaJump < .045 && !hasDarkSide)
                continue;
            magnitude[i] = Math.min(Math.sqrt(f2), Math.sqrt(c2) * 1.3) * ss;
        }
    const score = new Float32Array(cols * rows), occlusionScore = new Float32Array(cols * rows), sourceLab = new Float32Array(cols * rows * 3), sourceAlpha = new Float32Array(cols * rows);
    for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
            const i = y * w + x, m = weakMagnitude[i];
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
            if (m < weakMagnitude[i - step] || m < weakMagnitude[i + step])
                continue;
            const norm = Math.hypot(darkX[i], darkY[i]);
            const ox = norm > .005 ? -.20 * darkX[i] / norm : 0, oy = norm > .005 ? -.20 * darkY[i] / norm : 0;
            const cx = clamp(Math.floor((x + .5) / ss + ox), 0, cols - 1), cy = clamp(Math.floor((y + .5) / ss + oy), 0, rows - 1), j = cy * cols + cx;
            score[j] = Math.max(score[j], magnitude[i]);
            occlusionScore[j] = Math.max(occlusionScore[j], m);
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
    return { cols, rows, score, occlusionScore, sourceLab, sourceAlpha, protectedCells };
}
function thin(mask: Uint8Array, w: number, h: number, pins?: Uint8Array): void {
    for (let iter = 0; iter < 24; iter++) {
        let changes = 0;
        for (let pass = 0; pass < 2; pass++) {
            const drop: number[] = [];
            for (let y = 1; y < h - 1; y++)
                for (let x = 1; x < w - 1; x++) {
                    const i = y * w + x;
                    if (!mask[i] || pins?.[i])
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
/** 接续同一方向上、相隔最多两格的弱线端点，缓解网格相位造成的断线。 */
function bridgeWeakEdges(weak: Uint8Array, strong: Uint8Array, forbidden: Uint8Array, silhouette: Uint8Array, cells: Int16Array, cols: number, rows: number): void {
    const n = cols * rows, group = new Int32Array(n).fill(-1), sizes: number[] = [];
    for (let i = 0; i < n; i++)
        if (weak[i] && group[i] < 0) {
            const id = sizes.length, q = [i];
            group[i] = id;
            for (let t = 0; t < q.length; t++) {
                const j = q[t], x = j % cols, y = Math.floor(j / cols);
                for (const [dx, dy] of around) {
                    const nx = x + dx, ny = y + dy, k = ny * cols + nx;
                    if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && weak[k] && group[k] < 0) {
                        group[k] = id;
                        q.push(k);
                    }
                }
            }
            sizes.push(q.length);
        }
    const bridges: number[][] = [];
    const anchored = new Uint8Array(sizes.length);
    for (let i = 0; i < n; i++)
        if (weak[i] && silhouette[i])
            anchored[group[i]] = 1;
    for (let i = 0; i < n; i++)
        if (weak[i] && sizes[group[i]] >= 4 && anchored[group[i]]) {
            const x = i % cols, y = Math.floor(i / cols);
            let count = 0, tx = 0, ty = 0;
            for (const [dx, dy] of around) {
                const nx = x + dx, ny = y + dy;
                if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && weak[ny * cols + nx]) {
                    count++;
                    tx -= dx;
                    ty -= dy;
                }
            }
            const norm = Math.hypot(tx, ty);
            if (!count || count > 2 || norm < .5)
                continue;
            let best = Infinity, bestPath: number[] | null = null;
            for (let dy = -3; dy <= 3; dy++)
                for (let dx = -3; dx <= 3; dx++) {
                    const steps = Math.max(Math.abs(dx), Math.abs(dy)), nx = x + dx, ny = y + dy, j = ny * cols + nx;
                    if (steps < 2 || nx < 0 || ny < 0 || nx >= cols || ny >= rows || !(weak[j] || strong[j]) || group[j] === group[i])
                        continue;
                    const length = Math.hypot(dx, dy), alignment = (dx * tx + dy * ty) / (length * norm);
                    if (alignment < .72)
                        continue;
                    const path: number[] = [];
                    let valid = true;
                    for (let k = 1; k < steps; k++) {
                        const index = Math.round(y + dy * k / steps) * cols + Math.round(x + dx * k / steps);
                        if (cells[index] < 0 || forbidden[index]) {
                            valid = false;
                            break;
                        }
                        path.push(index);
                    }
                    const cost = length * (1.5 - alignment);
                    if (valid && cost < best) {
                        best = cost;
                        bestPath = path;
                    }
                }
            if (bestPath)
                bridges.push(bestPath);
        }
    for (const path of bridges)
        for (const i of path)
            weak[i] = 1;
}
function isNarrowGap(cells: Int16Array, cols: number, rows: number, i: number): boolean {
    const x = i % cols, y = Math.floor(i / cols);
    for (let k = 0; k < 4; k++) {
        const [dx, dy] = around[k], ax = x + dx, ay = y + dy, bx = x - dx, by = y - dy;
        if (ax >= 0 && ay >= 0 && bx >= 0 && by >= 0 && ax < cols && ay < rows && bx < cols && by < rows && cells[ay * cols + ax] >= 0 && cells[by * cols + bx] >= 0)
            return true;
    }
    return false;
}
/**
 * 给已有弱弧补上局部边界端点；必须确实分出一个仍有面积的突出部位才采纳。
 * 只使用前景、源边线、连通性和面积，没有对象名称或坐标规则。
 */
function completePartBoundary(path: number[], cells: Int16Array, exterior: Uint8Array, forbidden: Uint8Array, signal: Float32Array, cols: number, rows: number, total: number): {
    seam: number[];
    part: number[];
    core: number[];
} | null {
    const radius = Math.min(16, Math.max(4, Math.ceil(Math.max(cols, rows) * .14)));
    if (path.length < 4 || path.length > radius * 4 || !path.some(i => exterior[i] === 0))
        return null;
    const originalComponent = new Uint8Array(cells.length), original = [path[0]];
    originalComponent[path[0]] = 1;
    for (let t = 0; t < original.length; t++) {
        const i = original[t], x = i % cols, y = Math.floor(i / cols);
        for (const [dx, dy] of adjacent) {
            const nx = x + dx, ny = y + dy, j = ny * cols + nx;
            if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && cells[j] >= 0 && !originalComponent[j]) {
                originalComponent[j] = 1;
                original.push(j);
            }
        }
    }
    if (path.some(i => !originalComponent[i]))
        return null;
    const extrema = [path.reduce((a, b) => a % cols < b % cols ? a : b), path.reduce((a, b) => a % cols > b % cols ? a : b), path.reduce((a, b) => a < b ? a : b), path.reduce((a, b) => a > b ? a : b)];
    let a = extrema[0], b = extrema[1], far = 0;
    for (const i of extrema)
        for (const j of extrema) {
            const d = Math.hypot(i % cols - j % cols, Math.floor(i / cols) - Math.floor(j / cols));
            if (d > far) {
                far = d;
                a = i;
                b = j;
            }
        }
    if (far < 3)
        return null;
    const onPath = new Set(path);
    const extensions = (end: number, other: number) => {
        const x = end % cols, y = Math.floor(end / cols);
        let tx = 0, ty = 0, count = 0;
        for (const i of path) {
            const dx = i % cols - x, dy = Math.floor(i / cols) - y;
            if ((dx || dy) && Math.hypot(dx, dy) <= 2.2) {
                tx -= dx;
                ty -= dy;
                count++;
            }
        }
        if (!count) {
            tx = x - other % cols;
            ty = y - Math.floor(other / cols);
        }
        const norm = Math.hypot(tx, ty) || 1;
        const options: {
            end: number;
            cells: number[];
            cost: number;
        }[] = [];
        for (let dy = -radius; dy <= radius; dy++)
            for (let dx = -radius; dx <= radius; dx++) {
                const nx = x + dx, ny = y + dy, j = ny * cols + nx, steps = Math.max(Math.abs(dx), Math.abs(dy));
                if (!steps || nx < 0 || ny < 0 || nx >= cols || ny >= rows || !exterior[j])
                    continue;
                const length = Math.hypot(dx, dy), alignment = (dx * tx + dy * ty) / (length * norm);
                if (alignment < .05)
                    continue;
                const q: number[] = [];
                let valid = true, flat = 0;
                for (let t = 1; t < steps; t++) {
                    const k = Math.round(y + dy * t / steps) * cols + Math.round(x + dx * t / steps);
                    if (cells[k] < 0 || forbidden[k] || onPath.has(k)) {
                        valid = false;
                        break;
                    }
                    q.push(k);
                    flat += 1 - Math.min(1, signal[k] / .08);
                }
                if (valid)
                    options.push({ end: j, cells: q, cost: length * (1 + .6 * (1 - alignment)) + .2 * flat });
            }
        options.sort((a, b) => a.cost - b.cost);
        const kept: typeof options = [];
        for (const option of options)
            if (!kept.some(k => Math.hypot(k.end % cols - option.end % cols, Math.floor(k.end / cols) - Math.floor(option.end / cols)) < 2)) {
                kept.push(option);
                if (kept.length === 4)
                    break;
            }
        return kept;
    };
    const area = Math.min(total, original.length), left = extensions(a, b), right = extensions(b, a), minimum = Math.max(3, Math.floor(area * .0025)), maximum = Math.max(minimum + 1, Math.floor(area * .12));
    let best: {
        seam: number[];
        part: number[];
        cost: number;
    } | null = null;
    for (const l of left)
        for (const r of right) {
            if (Math.hypot(l.end % cols - r.end % cols, Math.floor(l.end / cols) - Math.floor(r.end / cols)) < 3)
                continue;
            const seam = [...new Set([...path, ...l.cells, ...r.cells])];
            if (seam.some(i => forbidden[i]))
                continue;
            if (seam.filter(i => signal[i] >= .018).length / seam.length < .40)
                continue;
            const cut = new Set(seam), seen = new Uint8Array(cells.length);
            let part: number[] | null = null, hasMain = false;
            for (const i of seam) {
                const x = i % cols, y = Math.floor(i / cols);
                for (const [dx, dy] of adjacent) {
                    const nx = x + dx, ny = y + dy, start = ny * cols + nx;
                    if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || cells[start] < 0 || cut.has(start) || seen[start])
                        continue;
                    const q = [start];
                    seen[start] = 1;
                    for (let t = 0; t < q.length; t++) {
                        const j = q[t], xx = j % cols, yy = Math.floor(j / cols);
                        for (const [ax, ay] of adjacent) {
                            const cx = xx + ax, cy = yy + ay, k = cy * cols + cx;
                            if (cx >= 0 && cy >= 0 && cx < cols && cy < rows && !seen[k] && cells[k] >= 0 && !cut.has(k)) {
                                seen[k] = 1;
                                q.push(k);
                            }
                        }
                    }
                    if (q.length > maximum)
                        hasMain = true;
                    else if (q.length >= minimum && (!part || q.length > part.length))
                        part = q;
                }
            }
            if (!part || !hasMain || part.length < seam.length * 1.25)
                continue;
            const xs = part.map(i => i % cols), ys = part.map(i => Math.floor(i / cols));
            if (part.length / ((Math.max(...xs) - Math.min(...xs) + 1) * (Math.max(...ys) - Math.min(...ys) + 1)) < .30)
                continue;
            const cost = l.cost + r.cost - .35 * Math.sqrt(part.length);
            if (!best || cost < best.cost)
                best = { seam, part, cost };
        }
    if (!best)
        return null;
    const seam = best.seam, part = best.part;
    // 留住突出部位中距分割线较远的40%，加粗时也不能把整个部位涂黑。
    const ranked = part.map(i => { let distance = Infinity; for (const j of seam)
        distance = Math.min(distance, (i % cols - j % cols) ** 2 + (Math.floor(i / cols) - Math.floor(j / cols)) ** 2); return { i, distance }; });
    const core = ranked.sort((a, b) => b.distance - a.distance).slice(0, Math.max(2, Math.ceil(part.length * .40))).map(p => p.i);
    return { seam, part, core };
}
/** 加粗只作用于轮廓副本。大色块保留核心与至少40%面积；原有小特征由保护区承担。 */
function thickenOutline(pattern: PatternResult, cells: Int16Array, ink: number, mask: Uint8Array, strokes: Uint8Array, protectedZone: Uint8Array, exterior: Uint8Array, lightness: number[], layers: number): {
    empty: number;
    filled: number;
} {
    const { cols, rows } = pattern, n = cols * rows;
    const group = new Int32Array(n).fill(-1), distance = new Int16Array(n).fill(32767);
    const areas: number[] = [], remaining: number[] = [], maxDistance: number[] = [];
    for (let i = 0; i < n; i++)
        if (pattern.cells[i] >= 0 && group[i] < 0) {
            const id = areas.length, color = pattern.cells[i], q = [i];
            group[i] = id;
            let live = 0;
            for (let t = 0; t < q.length; t++) {
                const j = q[t], x = j % cols, y = Math.floor(j / cols);
                if (cells[j] === color)
                    live++;
                for (const [dx, dy] of adjacent) {
                    const nx = x + dx, ny = y + dy, k = ny * cols + nx;
                    if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && group[k] < 0 && pattern.cells[k] === color) {
                        group[k] = id;
                        q.push(k);
                    }
                }
            }
            areas.push(q.length);
            remaining.push(live);
            maxDistance.push(0);
        }
    const queue: number[] = [];
    for (let i = 0; i < n; i++)
        if (group[i] >= 0) {
            const x = i % cols, y = Math.floor(i / cols);
            if (adjacent.some(([dx, dy]) => x + dx < 0 || y + dy < 0 || x + dx >= cols || y + dy >= rows || group[(y + dy) * cols + x + dx] !== group[i])) {
                distance[i] = 0;
                queue.push(i);
            }
        }
    for (let t = 0; t < queue.length; t++) {
        const i = queue[t], x = i % cols, y = Math.floor(i / cols), id = group[i];
        maxDistance[id] = Math.max(maxDistance[id], distance[i]);
        for (const [dx, dy] of adjacent) {
            const nx = x + dx, ny = y + dy, j = ny * cols + nx;
            if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && group[j] === id && distance[j] > distance[i] + 1) {
                distance[j] = distance[i] + 1;
                queue.push(j);
            }
        }
    }
    const core = new Uint8Array(n);
    for (let i = 0; i < n; i++)
        if (group[i] >= 0 && cells[i] === pattern.cells[i] && areas[group[i]] >= 6 && lightness[pattern.cells[i]] >= .42 && distance[i] >= Math.max(1, maxDistance[group[i]]))
            core[i] = 1;
    let empty = 0, filled = 0;
    // 偶数豆宽需要半格相位，先向右下扩成2×2；粗档再补全3×3。
    // 始终围绕原始线扩张一次，避免连续膨胀变成5格宽，也保证粗档包含中档。
    const originalMask = new Uint8Array(mask);
    for (let layer = 0; layer < layers; layer++) {
        const kernel = layer === 0 ? [[-1, 0], [0, -1], [-1, -1]] : around;
        const frontier: number[] = [];
        for (let i = 0; i < n; i++)
            if (!mask[i] && !protectedZone[i] && !core[i]) {
                const x = i % cols, y = Math.floor(i / cols);
                if (!kernel.some(([dx, dy]) => x + dx >= 0 && y + dy >= 0 && x + dx < cols && y + dy < rows && originalMask[(y + dy) * cols + x + dx]))
                    continue;
                if (pattern.cells[i] < 0) {
                    if (!exterior[i])
                        continue;
                    if (isNarrowGap(pattern.cells, cols, rows, i))
                        continue;
                }
                frontier.push(i);
            }
        for (const i of frontier) {
            const id = group[i], original = pattern.cells[i];
            if (original >= 0 && cells[i] === original && lightness[original] >= .42 && remaining[id] <= Math.ceil(areas[id] * .40))
                continue;
            mask[i] = 1;
            if (cells[i] === ink)
                continue;
            if (original >= 0 && cells[i] === original)
                remaining[id]--;
            cells[i] = ink;
            if (original < 0) {
                empty++;
                strokes[i] = 1;
            }
            else {
                filled++;
                strokes[i] = 2;
            }
        }
    }
    return { empty, filled };
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
    const protect = Uint8Array.from(guide.protectedCells, (x, i) => x || options.protectedCells?.[i] ? 1 : 0), strokes = new Uint8Array(n), outlineMask = new Uint8Array(n);
    const thickness = clamp(Math.round(Number.isFinite(options.thickness) ? options.thickness! : 0), 0, 2);
    const diagnostics: OutlineResult['diagnostics'] = { style, outerAdded: 0, outerDarkened: 0, interiorChanged: 0, occlusionCandidates: 0, fragmentsAbsorbed: 0, acceptedPaths: 0, rejectedPaths: 0, thickened: 0, thickness, partSeams: 0, partCoreCells: 0, protectedCells: protect.reduce((a, b) => a + b, 0), protectedOverwritten: 0, strokeCode: null, skippedReason: null, touchesCanvasEdge: false, meanSourceDeltaE: pattern.meanDeltaE };
    if (options.enabled !== true || strength === 0) {
        diagnostics.skippedReason = 'disabled';
        return { pattern, strokes, outlineMask, diagnostics };
    }
    const labs = pattern.palette.map(p => colorLab(p.hex));
    const palette = pattern.palette.map(p => ({ ...p }));
    // 用户选择的是黑线动画感：所有档位统一使用品牌色卡中最深的中性色。
    const chosen = getBrandPalette(pattern.meta.brand).filter(c => Math.hypot(c.lab.a, c.lab.b) < .06).sort((a, b) => a.lab.L - b.lab.L)[0];
    if (!chosen) {
        diagnostics.skippedReason = 'no-brand-stroke-color';
        return { pattern, strokes, outlineMask, diagnostics };
    }
    let ink = palette.findIndex(p => p.code === chosen.code && p.hex === chosen.hex);
    if (ink < 0) {
        if (palette.length >= pattern.meta.colorLimit) {
            diagnostics.skippedReason = 'no-free-color-slot';
            return { pattern, strokes, outlineMask, diagnostics };
        }
        ink = palette.length;
        palette.push({ index: ink, hex: chosen.hex, code: chosen.code, rgb: chosen.rgb, count: 0, ratio: 0 });
        labs.push(chosen.lab);
    }
    diagnostics.strokeCode = palette[ink].code;
    const filled = (i: number) => i >= 0 && i < n && pattern.cells[i] >= 0;
    const exterior = new Uint8Array(n), queue: number[] = [];
    const seed = (i: number) => {
        if (!filled(i) && !exterior[i]) {
            exterior[i] = 1;
            queue.push(i);
        }
    };
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
    const partRegion = new Uint8Array(n), partCore = new Uint8Array(n);
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
        if (guide.occlusionScore) {
            const weak = new Uint8Array(n), threshold = style === 'soft' ? .065 : style === 'ink' ? .028 : .040;
            for (let i = 0; i < n; i++) {
                if (filled(i) && !nearProtected[i] && guide.occlusionScore[i] >= Math.max(.018, threshold * .45) && !candidate[i])
                    weak[i] = 1;
            }
            const bridges: number[] = [];
            for (let y = 1; y < rows - 1; y++)
                for (let x = 1; x < cols - 1; x++) {
                    const i = y * cols + x;
                    if (weak[i] || candidate[i] || !filled(i) || nearProtected[i])
                        continue;
                    for (let k = 0; k < 4; k++) {
                        const [dx, dy] = around[k], a = i + dy * cols + dx, b = i - dy * cols - dx;
                        if (weak[a] && weak[b] && (guide.occlusionScore[i] >= threshold * .25 || Math.min(guide.occlusionScore[a], guide.occlusionScore[b]) > threshold * 1.5)) {
                            bridges.push(i);
                            break;
                        }
                    }
                }
            for (const i of bridges)
                weak[i] = 1;
            const weakPins = new Uint8Array(nearOutside);
            for (let i = 0; i < n; i++)
                if (candidate[i]) {
                    const x = i % cols, y = Math.floor(i / cols);
                    for (const [dx, dy] of around) {
                        const nx = x + dx, ny = y + dy;
                        if (nx >= 0 && ny >= 0 && nx < cols && ny < rows)
                            weakPins[ny * cols + nx] = 1;
                    }
                }
            thin(weak, cols, rows, weakPins);
            bridgeWeakEdges(weak, candidate, nearProtected, nearOutside, pattern.cells, cols, rows);
            const seenWeak = new Uint8Array(n);
            let partAttempts = 0;
            for (let i = 0; i < n; i++)
                if (weak[i] && !seenWeak[i]) {
                    const path = [i], anchors: number[] = [];
                    seenWeak[i] = 1;
                    for (let t = 0; t < path.length; t++) {
                        const j = path[t], x = j % cols, y = Math.floor(j / cols);
                        let anchored = nearOutside[j] > 0;
                        for (const [dx, dy] of around) {
                            const nx = x + dx, ny = y + dy, k = ny * cols + nx;
                            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows)
                                continue;
                            if (candidate[k])
                                anchored = true;
                            if (weak[k] && !seenWeak[k]) {
                                seenWeak[k] = 1;
                                path.push(k);
                            }
                        }
                        if (anchored)
                            anchors.push(j);
                    }
                    // 用分离的端部支撑确认结构弧；无支撑的闭合高光/阴影不画黑。
                    const anchorSet = new Set(anchors), seenAnchor = new Set<number>(), representatives: number[] = [];
                    for (const a of anchors)
                        if (!seenAnchor.has(a)) {
                            representatives.push(a);
                            const q = [a];
                            seenAnchor.add(a);
                            for (let t = 0; t < q.length; t++) {
                                const j = q[t], x = j % cols, y = Math.floor(j / cols);
                                for (const [dx, dy] of around) {
                                    const nx = x + dx, ny = y + dy, k = ny * cols + nx;
                                    if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && anchorSet.has(k) && !seenAnchor.has(k)) {
                                        seenAnchor.add(k);
                                        q.push(k);
                                    }
                                }
                            }
                        }
                    const separated = representatives.some((a, k) => representatives.slice(k + 1).some(b => Math.hypot(a % cols - b % cols, Math.floor(a / cols) - Math.floor(b / cols)) >= 3));
                    const touchesSilhouette = path.some(j => nearOutside[j]);
                    if (path.length >= 4 && separated && touchesSilhouette && path.some(j => guide.occlusionScore![j] >= threshold))
                        for (const j of path) {
                            candidate[j] = 1;
                            diagnostics.occlusionCandidates++;
                        }
                    else if (options.experimentalParts === true && touchesSilhouette && anchors.length && path.length >= 4 && partAttempts < 12 && diagnostics.partSeams < 8 && path.some(j => guide.occlusionScore![j] >= threshold)) {
                        partAttempts++;
                        const part = completePartBoundary(path, pattern.cells, exterior, nearProtected, guide.occlusionScore, cols, rows, pattern.totalBeads);
                        if (part && !part.part.some(j => partRegion[j])) {
                            for (const j of part.seam)
                                candidate[j] = 1;
                            for (const j of part.part)
                                partRegion[j] = 1;
                            for (const j of part.core) {
                                partCore[j] = 1;
                                nearProtected[j] = 1;
                            }
                            diagnostics.partSeams++;
                        }
                    }
                }
            for (let i = 0; i < n; i++)
                if (partCore[i])
                    candidate[i] = 0;
            diagnostics.partCoreCells = partCore.reduce((a, b) => a + b, 0);
            thin(candidate, cols, rows, nearOutside);
        }
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
    const budget = Math.floor(pattern.totalBeads * (style === 'ink' ? .24 : style === 'soft' ? .08 : .16) * strength);
    let changed = 0;
    const componentUpToThree = (data: Int16Array, start: number) => {
        const color = data[start], q = [start], seen = new Set([start]);
        for (let t = 0; t < q.length && q.length < 3; t++) {
            const j = q[t], x = j % cols, y = Math.floor(j / cols);
            for (const [dx, dy] of adjacent) {
                const nx = x + dx, ny = y + dy, k = ny * cols + nx;
                if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && !seen.has(k) && data[k] === color) {
                    seen.add(k);
                    q.push(k);
                }
            }
        }
        return q;
    };
    for (const path of paths) {
        const edits = path.cells.filter(i => labs[cells[i]].L > labs[ink].L + .07);
        if (!edits.length) {
            for (const i of path.cells)
                outlineMask[i] = 1;
            continue;
        }
        if (changed + edits.length > budget) {
            diagnostics.rejectedPaths++;
            continue;
        }
        const previous = edits.map(i => cells[i]);
        for (const i of edits)
            cells[i] = ink;
        let fragments = false;
        const absorbed: number[] = [], absorbedPrevious: number[] = [];
        const repairLimit = Math.max(2, Math.ceil(edits.length * .15));
        const inspection = [...edits];
        for (let t = 0; t < inspection.length; t++) {
            const i = inspection[t];
            const x = i % cols, y = Math.floor(i / cols);
            for (const [dx, dy] of adjacent) {
                const nx = x + dx, ny = y + dy, j = ny * cols + nx;
                if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || cells[j] < 0 || cells[j] === ink)
                    continue;
                const fragment = componentUpToThree(cells, j);
                if (fragment.length < 3 && componentUpToThree(pattern.cells, j).length >= 3) {
                    if (fragment.every(k => partRegion[k]))
                        continue;
                    // 只吸收本条描线新切出的窄缝碎片，不删除原有小结构，也不按整色号清理。
                    if (fragment.some(k => protect[k] || nearProtected[k]) || absorbed.length + fragment.length > repairLimit || changed + edits.length + absorbed.length + fragment.length > budget) {
                        fragments = true;
                        break;
                    }
                    for (const k of fragment) {
                        absorbed.push(k);
                        absorbedPrevious.push(cells[k]);
                        cells[k] = ink;
                        inspection.push(k);
                    }
                }
            }
            if (fragments)
                break;
        }
        if (fragments) {
            edits.forEach((i, k) => { cells[i] = previous[k]; });
            absorbed.forEach((i, k) => { cells[i] = absorbedPrevious[k]; });
            diagnostics.rejectedPaths++;
            continue;
        }
        for (const i of [...edits, ...absorbed])
            strokes[i] = 2;
        for (const i of [...path.cells, ...absorbed])
            outlineMask[i] = 1;
        changed += edits.length + absorbed.length;
        diagnostics.fragmentsAbsorbed += absorbed.length;
        diagnostics.acceptedPaths++;
    }
    diagnostics.interiorChanged = changed;
    if (options.outer !== false) {
        for (let i = 0; i < n; i++)
            if (filled(i) && nearOutside[i] && !protect[i] && labs[cells[i]].L < .42)
                outlineMask[i] = 1;
        for (let i = 0; i < n; i++)
            if (filled(i) && nearOutside[i] && !protect[i] && !strokes[i] && cells[i] !== ink && labs[cells[i]].L < .42) {
                cells[i] = ink;
                strokes[i] = 1;
                diagnostics.outerDarkened++;
            }
        for (let i = 0; i < n; i++)
            if (exterior[i] && !protect[i]) {
                if (isNarrowGap(pattern.cells, cols, rows, i))
                    continue;
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
                    outlineMask[i] = 1;
                    diagnostics.outerAdded++;
                }
            }
    }
    if (thickness > 0) {
        const added = thickenOutline(pattern, cells, ink, outlineMask, strokes, nearProtected, options.outer !== false ? exterior : new Uint8Array(n), labs.map(l => l.L), thickness);
        diagnostics.thickened = added.empty + added.filled;
        diagnostics.outerAdded += added.empty;
        diagnostics.interiorChanged += added.filled;
    }
    if (!diagnostics.outerAdded && !diagnostics.outerDarkened && !diagnostics.interiorChanged)
        return { pattern, strokes, outlineMask, diagnostics };
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
    return { pattern: { ...pattern, cells, palette: used, totalBeads: total, meanDeltaE: diagnostics.meanSourceDeltaE }, strokes, outlineMask, diagnostics };
}
