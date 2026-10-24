/**
 * 熨烫外观预览（视觉近似，不是温度/秒数或材料强度预测）。
 *
 * 独立于量化/编辑：只读 cells 与品牌 HEX，返回可直接 putImageData 的 RGBA。
 * 两面各自具有外缘、孔口与表面状态；透孔取两面孔径的交集。背面按实物镜像。
 * 局部融合与颜色边界只发生在相邻豆体，不对整张图做模糊。
 *
 * 依据与实测限制见交付包 RESEARCH.md。几何系数未以 MARD 实物标定；默认
 * 不按颜色深浅猜测熔化速度。paletteResponse 只供以后传入实测的色号响应。
 */
export type FuseFace = 'front' | 'back';
export type FuseFinish = 'paper' | 'film';
/** 与 PatternResult 结构兼容，也可直接使用独立保存的图纸 JSON。 */
export interface FusePattern {
    cols: number;
    rows: number;
    cells: ArrayLike<number>;
    palette: readonly {
        hex: string;
        code?: string;
    }[];
}
export interface FuseOptions {
    /** 0..1 视觉熔接程度；不对应固定熨斗温度或时间。 */
    frontHeat?: number;
    backHeat?: number;
    face?: FuseFace;
    /** 背面默认水平镜像；false 只用于对齐图纸比较。 */
    mirrorBack?: boolean;
    finish?: FuseFinish;
    /** 未熨烫的内孔直径/外径；默认0.46是可调视觉参数，不是品牌规格。 */
    holeRatio?: number;
    /** 0..1；确定性的局部受热/变形差异，不包含按色相猜测的偏差。 */
    unevenness?: number;
    /** 0..0.4；仅控制已融合接缝的窄带过渡，0仍保留像素抗锯齿。 */
    seamSoftness?: number;
    seed?: number;
    lightAngle?: number;
    /** 可选实测色号响应，0.7..1.3；缺省所有色号均为1。 */
    paletteResponse?: Readonly<Record<string, number>>;
    pixelsPerBead?: number;
    maxEdge?: number;
    padding?: number;
    /** 0..1，关闭后便于比较基础色与几何。 */
    lighting?: number;
    /** 按原图纸坐标截取局部；背面在该区域内镜像，便于高分辨率看细节。 */
    region?: {
        col: number;
        row: number;
        cols: number;
        rows: number;
    };
}
export interface FuseRaster {
    width: number;
    height: number;
    data: Uint8ClampedArray;
    pixelsPerBead: number;
    padding: number;
    offsetX: number;
    offsetY: number;
    region: {
        col: number;
        row: number;
        cols: number;
        rows: number;
    };
    face: FuseFace;
    mirrored: boolean;
    /** 原始格数与用色均不改变；孔口面积是视觉模型的解析量。 */
    metrics: {
        beads: number;
        effectiveHeat: number;
        meanOpeningArea: number;
        meanThroughArea: number;
        closedOpenings: number;
    };
}
interface Bead {
    x: number;
    y: number;
    radius: number;
    square: number;
    hole: number;
    through: number;
    heat: number;
    red: number;
    green: number;
    blue: number;
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finite = (v: number | undefined, fallback: number) => Number.isFinite(v) ? v! : fallback;
const smooth = (a: number, b: number, x: number) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
};
const LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
    const x = i / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
});
const SRGB = Uint8Array.from({ length: 8192 }, (_, i) => {
    const x = i / 8191;
    return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
});
const encode = (x: number) => SRGB[Math.round(clamp(x, 0, 1) * 8191)];
function noise(index: number, seed: number): number {
    let v = Math.imul(index + 1, 0x45d9f3b) ^ seed;
    v = Math.imul(v ^ (v >>> 16), 0x45d9f3b);
    v = Math.imul(v ^ (v >>> 16), 0x45d9f3b);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967295;
}
/** 熔接后外形从圆形向圆角方形过渡；只用乘法/平方根，避免逐像素高次幂。 */
function contour(dx: number, dy: number, square: number): number {
    const x2 = dx * dx, y2 = dy * dy;
    const x4 = x2 * x2, y4 = y2 * y2;
    const round = Math.sqrt(x2 + y2);
    const squircle = Math.sqrt(Math.sqrt(Math.sqrt(x4 * x4 + y4 * y4)));
    return round + (squircle - round) * square;
}
function aperture(heat: number, ratio: number): number {
    return 0.475 * ratio * Math.max(0, 1 - heat / 0.96) ** 0.78;
}
function makeBeads(pattern: FusePattern, options: FuseOptions): (Bead | null)[] {
    const { cols, rows, cells, palette } = pattern;
    const front = clamp(finite(options.frontHeat, 0.28), 0, 1);
    const back = clamp(finite(options.backHeat, 0.6), 0, 1);
    const ratio = clamp(finite(options.holeRatio, 0.46), 0.15, 0.70);
    const uneven = clamp(finite(options.unevenness, 0.18), 0, 1);
    const seed = finite(options.seed, 731) | 0;
    const face = options.face === 'back' ? 'back' : 'front';
    const colors = palette.map((p) => {
        if (!/^#[0-9a-f]{6}$/i.test(p.hex))
            throw new TypeError(`Invalid bead HEX: ${p.hex}`);
        const c = Number.parseInt(p.hex.slice(1), 16);
        return [LINEAR[c >>> 16], LINEAR[(c >>> 8) & 255], LINEAR[c & 255]];
    });
    const filled = (x: number, y: number) => x >= 0 && x < cols && y >= 0 && y < rows &&
        cells[y * cols + x] >= 0 && cells[y * cols + x] < palette.length;
    return Array.from({ length: cols * rows }, (_, i): Bead | null => {
        const color = cells[i];
        if (color < 0 || color >= palette.length || !Number.isInteger(color))
            return null;
        const x = i % cols, y = (i / cols) | 0;
        const response = clamp(finite(options.paletteResponse?.[palette[color].code ?? ''], 1), 0.7, 1.3);
        const field = (Math.sin(x * 0.47 + seed * 0.01) + Math.cos(y * 0.39 - seed * 0.02) +
            (noise(i, seed) - 0.5)) / 2.5;
        const variation = 1 + uneven * 0.24 * field;
        // 另一面受热只少量传到当前表面；系数为可解释的外观近似，未做实物标定。
        const a = clamp((front + 0.10 * back * (1 - front)) * response * variation, 0, 1);
        const b = clamp((back + 0.10 * front * (1 - back)) * response * variation, 0, 1);
        const heat = face === 'front' ? a : b;
        const hole = aperture(heat, ratio);
        const other = aperture(face === 'front' ? b : a, ratio);
        const drift = uneven * 0.026 * heat;
        const freeX = Number(!filled(x + 1, y)) - Number(!filled(x - 1, y));
        const freeY = Number(!filled(x, y + 1)) - Number(!filled(x, y - 1));
        return {
            x: x + 0.5 + drift * (noise(i, seed + 11) - 0.5) + freeX * 0.014 * heat,
            y: y + 0.5 + drift * (noise(i, seed + 29) - 0.5) + freeY * 0.014 * heat,
            radius: 0.475 + 0.09 * (1 - Math.exp(-4 * heat)),
            square: 0.97 * heat ** 0.8,
            hole,
            through: Math.min(hole, other),
            heat,
            red: colors[color][0], green: colors[color][1], blue: colors[color][2],
        };
    });
}
/**
 * 输入输出都可在 Worker 中使用；不读取 document、canvas、全局状态或原图。
 * 结果含透明外部与贯通孔，调用方可在纸色/棋盘底上显示。
 */
export function renderFusePreview(pattern: FusePattern, options: FuseOptions = {}): FuseRaster {
    const { cols, rows } = pattern;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 ||
        cols > 1024 || rows > 1024 || pattern.cells.length < cols * rows) {
        throw new RangeError('Invalid bead pattern dimensions');
    }
    const face: FuseFace = options.face === 'back' ? 'back' : 'front';
    const mirrored = face === 'back' && options.mirrorBack !== false;
    const padding = clamp(finite(options.padding, 0.75), 0.25, 3);
    const maxEdge = clamp(finite(options.maxEdge, 1280), 64, 2048);
    const col = clamp(Math.floor(finite(options.region?.col, 0)), 0, cols - 1);
    const row = clamp(Math.floor(finite(options.region?.row, 0)), 0, rows - 1);
    const region = {
        col, row,
        cols: clamp(Math.floor(finite(options.region?.cols, cols)), 1, cols - col),
        rows: clamp(Math.floor(finite(options.region?.rows, rows)), 1, rows - row),
    };
    const pitch = Math.max(1, Math.min(clamp(finite(options.pixelsPerBead, 18), 1, 128), (maxEdge - 1) / (Math.max(region.cols, region.rows) + padding * 2)));
    const width = Math.ceil((region.cols + padding * 2) * pitch);
    const height = Math.ceil((region.rows + padding * 2) * pitch);
    const offsetX = (width - region.cols * pitch) / 2;
    const offsetY = (height - region.rows * pitch) / 2;
    const data = new Uint8ClampedArray(width * height * 4);
    const beads = makeBeads(pattern, options);
    const film = options.finish === 'film';
    const lighting = clamp(finite(options.lighting, 1), 0, 1);
    const blend = clamp(finite(options.seamSoftness, 0.035), 0, 0.4);
    const angle = finite(options.lightAngle, -135) * Math.PI / 180;
    const lx = Math.cos(angle) * 0.5724, ly = Math.sin(angle) * 0.5724, lz = 0.82;
    const halfNorm = Math.hypot(lx, ly, lz + 1);
    const hx = lx / halfNorm, hy = ly / halfNorm, hz = (lz + 1) / halfNorm;
    const aa = 0.65 / pitch;
    const mirrorSign = mirrored ? -1 : 1;
    let count = 0, heatSum = 0, openingSum = 0, throughSum = 0, closed = 0;
    for (let i = 0; i < beads.length; i++) {
        const b = beads[i];
        if (!b || i % cols < region.col || i % cols >= region.col + region.cols ||
            Math.floor(i / cols) < region.row || Math.floor(i / cols) >= region.row + region.rows)
            continue;
        count++;
        heatSum += b.heat;
        openingSum += Math.PI * b.hole * b.hole;
        throughSum += Math.PI * b.through * b.through;
        if (b.hole < 0.001)
            closed++;
    }
    for (let py = 0; py < height; py++) {
        const sy = region.row + (py + 0.5 - offsetY) / pitch;
        const r0 = Math.floor(sy);
        for (let px = 0; px < width; px++) {
            const viewX = (px + 0.5 - offsetX) / pitch;
            const sx = region.col + (mirrored ? region.cols - viewX : viewX);
            const c0 = Math.floor(sx);
            let outer = 10, owner = -1, second = -1;
            let best = Infinity, next = Infinity, ownerContour = 10, secondContour = 10;
            for (let r = Math.max(0, r0 - 1); r <= Math.min(rows - 1, r0 + 1); r++) {
                for (let c = Math.max(0, c0 - 1); c <= Math.min(cols - 1, c0 + 1); c++) {
                    const i = r * cols + c, bead = beads[i];
                    if (!bead)
                        continue;
                    const dx = sx - bead.x, dy = sy - bead.y;
                    if (Math.abs(dx) > 0.7 || Math.abs(dy) > 0.7)
                        continue;
                    const distance = contour(dx, dy, bead.square) - bead.radius;
                    const k = 0.025 * bead.heat;
                    if (k > 0.0001) {
                        const overlap = Math.max(k - Math.abs(outer - distance), 0) / k;
                        outer = Math.min(outer, distance) - overlap * overlap * k * 0.25;
                    }
                    else
                        outer = Math.min(outer, distance);
                    const metric = (dx * dx + dy * dy) / (bead.radius * bead.radius);
                    if (metric < best) {
                        next = best;
                        second = owner;
                        secondContour = ownerContour;
                        best = metric;
                        owner = i;
                        ownerContour = distance;
                    }
                    else if (metric < next) {
                        next = metric;
                        second = i;
                        secondContour = distance;
                    }
                }
            }
            if (owner < 0 || outer > aa)
                continue;
            const bead = beads[owner]!;
            const dx = sx - bead.x, dy = sy - bead.y;
            const radial = Math.hypot(dx, dy);
            let alpha = 1 - smooth(-aa, aa, outer);
            if (bead.through > 0.00001)
                alpha *= smooth(bead.through - aa, bead.through + aa, radial);
            if (alpha < 0.001)
                continue;
            let red = bead.red, green = bead.green, blue = bead.blue;
            // 只在两个已接触的豆体接缝抗锯齿/窄带过渡；不把颜色扩散进空格或整张图。
            if (second >= 0 && bead.heat > 0.01 && secondContour < aa && ownerContour < aa) {
                const b = beads[second]!;
                const seamWidth = Math.max(4 / pitch, blend * bead.heat);
                const weight = 0.5 + 0.5 * smooth(0, seamWidth, next - best);
                red = red * weight + b.red * (1 - weight);
                green = green * weight + b.green * (1 - weight);
                blue = blue * weight + b.blue * (1 - weight);
            }
            let nx = 0, ny = 0, nz = 1, occlusion = 1;
            const holeDistance = radial - bead.hole;
            if (bead.hole > 0.001 && holeDistance < aa * 0.35) {
                // 另一面封孔时，当前面的孔口仍是凹坑；不是把两面都画成贯通黑洞。
                const wall = smooth(bead.through, bead.hole, radial);
                occlusion = 0.34 + 0.34 * wall;
                const slope = 0.68 * wall;
                nx = -dx / Math.max(radial, 0.0001) * slope;
                ny = -dy / Math.max(radial, 0.0001) * slope;
                nz = Math.sqrt(Math.max(0.05, 1 - nx * nx - ny * ny));
            }
            else {
                const bevel = 0.038 + 0.025 * (1 - bead.heat);
                const outerSlope = (1 - smooth(0, bevel, -outer)) * (0.88 - 0.48 * bead.heat);
                const innerSlope = bead.hole > 0.001 ?
                    (1 - smooth(0, bevel * 0.7, holeDistance)) * 0.62 : 0;
                const slope = outerSlope - innerSlope;
                nx = dx / Math.max(radial, 0.0001) * slope;
                ny = dy / Math.max(radial, 0.0001) * slope;
                nz = Math.sqrt(Math.max(0.05, 1 - nx * nx - ny * ny));
                if (second >= 0 && secondContour < 0.02) {
                    occlusion -= 0.055 * (1 - bead.heat) * (1 - smooth(0, 0.11, next - best));
                }
            }
            nx *= mirrorSign;
            const diffuse = Math.max(0, nx * lx + ny * ly + nz * lz);
            const exponent = film ? 70 : 22;
            const specular = Math.max(0, nx * hx + ny * hy + nz * hz) ** exponent *
                (film ? 0.26 : 0.035) * (0.45 + 0.55 * bead.heat) * occlusion;
            const grain = (noise(((sx * 179) | 0) + ((sy * 173) | 0) * 7321, 119) - 0.5) * (film ? 0.003 : 0.014);
            const shade = 1 + lighting * ((0.64 + 0.4 * diffuse) * occlusion * (1 + grain) - 1);
            const shine = lighting * specular;
            const i = (py * width + px) * 4;
            data[i] = encode(red * shade + shine);
            data[i + 1] = encode(green * shade + shine);
            data[i + 2] = encode(blue * shade + shine);
            data[i + 3] = Math.round(alpha * 255);
        }
    }
    return {
        width, height, data, pixelsPerBead: pitch, padding, offsetX, offsetY, region, face, mirrored,
        metrics: {
            beads: count,
            effectiveHeat: count ? heatSum / count : 0,
            meanOpeningArea: count ? openingSum / count : 0,
            meanThroughArea: count ? throughSum / count : 0,
            closedOpenings: closed,
        },
    };
}
export const FUSE_PRESETS = {
    raw: { frontHeat: 0, backHeat: 0 },
    display: { frontHeat: 0.12, backHeat: 0.62 },
    standard: { frontHeat: 0.38, backHeat: 0.48 },
    flat: { frontHeat: 1, backHeat: 0.58 },
} as const;
