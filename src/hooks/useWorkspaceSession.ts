'use client';

import type { DetailBrush } from '@/lib/pattern/regions';
import type { EditMap } from '@/lib/pattern/edits';
import type { PatternResult } from '@/lib/pattern/generate';
import { readStorage, writeStorageDetailed } from '@/hooks/useLocalStorage';

/**
 * 工作区会话持久化
 * ===============================================================
 * 解决的问题（用户原话）：「现在刷新就把工作区的东西清除了，没保存状态，
 * 不太对，虽然能看到历史记录」。
 *
 * 刷新前页面上有这些东西，刷新前只有一部分被存了下来：
 *
 *   已存  参数（OPTIONS_KEY）、主题、左栏折叠、画布偏好、历史记录
 *   丢失  当前图片本身、当前空白画布、手绘改动（edits）、区域笔刷
 *
 * 历史记录能救回"图"，但历史是一个**列表**：刷新后落回空态，用户得自己
 * 想起来去点历史里的第一条，而且恢复出来的东西跟刷新前那一版未必一致
 * （历史按参数分版本）。做成"会话"之后，刷新就是**回到刚才那一屏**。
 *
 * ## 和历史的边界
 *
 * - 历史 = 用户做过的所有图，跨天、可浏览、有版本（`pindou.history.v3`）
 * - 会话 = 现在屏幕上这一张，只有一个，随改随写（`pindou.session.v1`）
 *
 * 两者存的图片格式必须**一致**（都走 `compressSourceDataUrl`），否则同一张
 * 图在"刷新"与"从历史恢复"两条路径上会被去重逻辑判成两条记录。
 *
 * ## 为什么存压缩后的图，而不是原图
 *
 * 原图 dataURL 可能是 4–11MB 的手机照片，localStorage 总共只有 5MB。
 * `compressSourceDataUrl` 对**小图原本就原样返回**（长边 ≤640 的 PNG/JPEG
 * 直接 `return dataUrl`），所以 512×512 这种测试图刷新前后逐字节相同、
 * 生成的图纸也完全相同；只有大照片会被压到 640px —— 而那条路径历史记录
 * 本来就一直在用，行为一致。
 *
 * ## 为什么不存参数（options）
 *
 * 参数本来就有自己的 `pindou.options.v1`（`page.tsx` 里那个 effect 每次
 * 变动都写）。会话再存一份就是同一份真相两个副本：两边写入时机不同，
 * 一旦一边失败，刷新后会出现"图是新的、参数是旧的"这种谁都没见过的组合。
 * 会话只负责**参数之外**的东西 —— 也就是现在刷新真正会丢的那部分。
 *
 * ## 为什么不存生成结果，只存"输入"
 *
 * `pattern`（cells + palette）不存。它是 `sourceDataUrl × options` 的纯函数
 * 输出，存了就是同一份真相有两个副本：用户改参数后若写入失败，屏幕上还是
 * 旧图，刷新后却是新图，比"重算一下"难解释得多。
 *
 * 唯一的例外是空白画布 —— 它的 cells 全是 -1，`makeBlankPattern` 是纯函数，
 * 一条 `{cols, rows, id}` 就够，不用存 8 万个格子。
 */

const SESSION_KEY = 'pindou.session.v1';

export interface WorkspaceImageInfo {
  width: number;
  height: number;
  name: string;
}

export interface WorkspaceBlankCanvas {
  cols: number;
  rows: number;
  id: string;
}

export interface WorkspaceSession {
  version: 1;
  savedAt: number;
  /** 压缩后的源图 dataURL；空白画布时为 null */
  sourceDataUrl: string | null;
  imageInfo: WorkspaceImageInfo | null;
  blankCanvas: WorkspaceBlankCanvas | null;
  /** 手绘覆盖层：`{ 格子下标: 色号 }` */
  edits: EditMap;
  /**
   * 保存时图纸的行列数。
   *
   * 覆盖层按**格子下标**存，只有行列数一致时下标才指向同一批位置。
   * 恢复后引擎会用压缩图重算一遍，理论上行列数必然相同；但不校验就
   * 把用户涂的几百格套到一张 29×29 的图上，会得到一堆错位色块 ——
   * 这种"恢复出一个乱七八糟的图"比"恢复成没涂过的样子"糟得多。
   */
  patternCols: number | null;
  patternRows: number | null;
  /** 局部精细度笔刷（归一化坐标，与图源同代） */
  brushes: DetailBrush[];
  regionFeather: number;
  /**
   * 上次算好的图纸快照。
   *
   * 有它 = 刷新后第一帧就能画出图纸，不用等引擎重算（实测省 500ms，
   * 也是"刷新时那段动画"的真正来源）。没有也能用，只是会看到空态闪一下。
   */
  snapshot: PatternSnapshot | null;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function sanitizeImageInfo(v: unknown): WorkspaceImageInfo | null {
  if (!isRecord(v)) return null;
  const width = asFiniteNumber(v.width);
  const height = asFiniteNumber(v.height);
  if (width === null || height === null) return null;
  return { width, height, name: typeof v.name === 'string' ? v.name : '' };
}

function sanitizeBlankCanvas(v: unknown): WorkspaceBlankCanvas | null {
  if (!isRecord(v)) return null;
  const cols = asFiniteNumber(v.cols);
  const rows = asFiniteNumber(v.rows);
  const id = typeof v.id === 'string' ? v.id : '';
  if (cols === null || rows === null || !id) return null;
  if (cols < 1 || rows < 1 || cols > 400 || rows > 400) return null;
  return { cols: Math.round(cols), rows: Math.round(rows), id };
}

/**
 * 覆盖层校验：只留"规范数字下标 → 非空字符串色号"的项。
 *
 * 与 `applyEdits` 保持同一套判据（那里也是 `Number(key)` 后必须仍是整数、
 * 越界忽略）。这里更要小心：脏数据留在 localStorage 里会在**每次刷新**
 * 时重新污染，所以宁可丢掉可疑项，也不要让它进内存。
 */
function sanitizeEdits(v: unknown): EditMap {
  if (!isRecord(v)) return {};
  const out: Record<number, string> = {};
  for (const key of Object.keys(v)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) continue;
    // 防止 "1.0" 与 "1" 这类等价键在对象里各占一份
    if (String(index) !== key) continue;
    const code = v[key];
    if (typeof code !== 'string' || !code) continue;
    out[index] = code;
  }
  return out;
}

function sanitizeBrushes(v: unknown): DetailBrush[] {
  if (!Array.isArray(v)) return [];
  const out: DetailBrush[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    const x = asFiniteNumber(item.x);
    const y = asFiniteNumber(item.y);
    const radius = asFiniteNumber(item.radius);
    if (x === null || y === null || radius === null) continue;
    if (x < 0 || x > 1 || y < 0 || y > 1 || radius <= 0) continue;
    const algorithm = item.algorithm;
    if (typeof algorithm !== 'string') continue;
    out.push({
      x,
      y,
      radius,
      algorithm: algorithm as DetailBrush['algorithm'],
    });
  }
  return out;
}

/**
 * 读取会话。任何一环不合法就整体返回 null（当作"没有会话"）。
 *
 * 不做部分恢复：半张图 + 半套参数比空态更让人困惑，而且 sourceDataUrl
 * 与 options 是一起产生的一代数据，混代恢复出来的图谁都没见过。
 */
export function readWorkspaceSession(): WorkspaceSession | null {
  if (typeof window === 'undefined') return null;
  const raw = readStorage<unknown>(SESSION_KEY, null);
  if (!isRecord(raw)) return null;
  if (raw.version !== 1) return null;

  const sourceDataUrl =
    typeof raw.sourceDataUrl === 'string' && raw.sourceDataUrl
      ? raw.sourceDataUrl
      : null;
  const blankCanvas = sanitizeBlankCanvas(raw.blankCanvas);
  const imageInfo = sanitizeImageInfo(raw.imageInfo);

  /*
   * 必须有且只有一种来源。两种都没有 = 空会话（等同于没存过）；
   * 两种都有 = 状态机被写坏了，宁可回空态也不猜。
   */
  if (!sourceDataUrl && !blankCanvas) return null;
  if (sourceDataUrl && blankCanvas) return null;

  const savedAt = asFiniteNumber(raw.savedAt) ?? 0;
  const regionFeather = asFiniteNumber(raw.regionFeather);
  const patternCols = asFiniteNumber(raw.patternCols);
  const patternRows = asFiniteNumber(raw.patternRows);

  return {
    version: 1,
    savedAt,
    sourceDataUrl,
    imageInfo,
    blankCanvas,
    edits: sanitizeEdits(raw.edits),
    patternCols: patternCols !== null && patternCols > 0 ? Math.round(patternCols) : null,
    patternRows: patternRows !== null && patternRows > 0 ? Math.round(patternRows) : null,
    brushes: sanitizeBrushes(raw.brushes),
    regionFeather:
      regionFeather !== null && regionFeather >= 0.1 && regionFeather <= 2
        ? regionFeather
        : 0.55,
    /*
     * 快照解码要注意：`decodePatternSnapshot` 需要 `parseHex`，但它住在
     * lib/color/oklab 里。这里不直接 import 是为了让本文件保持"零业务
     * 依赖"（它也被 Node 侧脚本用过），所以快照原样带出去、由 page.tsx
     * 在恢复时解码 —— 解码失败就当没有快照，不影响其余恢复。
     */
    snapshot: isRecord(raw.snapshot) ? (raw.snapshot as unknown as PatternSnapshot) : null,
  };
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

let lastError: string | null = null;

export interface SaveResult {
  ok: boolean;
  /** 序列化后的字符数，用于诊断"是不是太大装不下" */
  bytes: number;
  error?: string;
}

/**
 * 写入会话。
 *
 * 失败**不弹 toast**：会话是"顺手存的一份"而不是用户主动发起的操作，
 * 存储满了的时候每画一笔弹一次红框属于骚扰。失败只在 console 里报一次
 * （同样的错连续出现不重复刷屏），用户真正的兜底是历史记录那条路径，
 * 那边有明确的 trimmed / rejected 提示。
 */
export function writeWorkspaceSession(session: WorkspaceSession): SaveResult {
  if (typeof window === 'undefined') return { ok: false, bytes: 0, error: 'NoWindow' };
  const result = writeStorageDetailed(SESSION_KEY, session);
  if (!result.ok) {
    if (lastError !== result.error) {
      lastError = result.error;
      console.warn(
        `[session] 工作区暂存失败（${result.error}）：刷新后将无法恢复当前这一屏。` +
          '历史记录不受影响。',
      );
    }
    return { ok: false, bytes: 0, error: result.error };
  }
  lastError = null;
  return { ok: true, bytes: 0 };
}

export function clearWorkspaceSession(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(SESSION_KEY);
  } catch {
    /* 隐私模式：删不掉也无所谓，下次写入会覆盖 */
  }
}

export const SESSION_STORAGE_KEY = SESSION_KEY;

/* -------------------------------------------------------------------------
 * 图纸快照：让刷新后**第一帧**就有图，而不是等引擎重算
 * ---------------------------------------------------------------------- */

/**
 * 刷新后为什么要连图纸一起存。
 *
 * 只存"输入"（图 + 参数）的话，刷新后必须重新跑一遍引擎才能画出图纸：
 * 实测 production 下 DOM 30ms 就有了，但画布要到 **515ms** —— 中间这段时间
 * 04 面板只能显示空态。用户看到的就是先闪「还没有图纸」、再闪「还没有
 * 生成图案」、然后才出图，像是一段多余的入场动画。
 *
 * 引擎本身 340ms 很难再压缩（320 格时是 1.7s），所以换个思路：把上次算好的
 * 图纸**原样存下来**，刷新后立刻画出来，引擎在后台算完再无缝换掉。用户看到
 * 的是"刷新即复原"，重算成了纯粹的兜底。
 *
 * ## 体积
 *
 * cells 是 Int16Array，按 palette 下标存。直接 base64 的话 3328 格 ≈ 4.4KB
 * （320 格图 8.7 万格 ≈ 113KB）。**但绝大多数格子的下标都 < 48**（色数上限
 * 就是 48），所以按 UTF-16 字符编码可以直接塞进普通字符串：
 *
 *   - 每格一个字符，`String.fromCharCode(index + 1)`（+1 让 -1 变 0，
 *     避开 NUL —— JSON 里 `\u0000` 是合法但很多地方会被当成截断符）
 *   - 4 万格以内体积 ≈ 格数 × 1 字符，再被 JSON 编码成 `\uXXXX` 的话膨胀 6 倍
 *
 * 所以这里用 **base36 分段 + 一位一码**太小；直接每个格子 2 个字符的
 * 十六进制（`hex[i] = index+1` 转 2 位）更简单，膨胀只有 2 倍且全是 ASCII
 * —— JSON 里不需要转义。3328 格 = 6.7KB，8.7 万格 = 174KB，可接受。
 *
 * 空位（-1）编成 `00`。调色板只存 `{hex, code}`，其余字段恢复时重算。
 */
export interface PatternSnapshot {
  cols: number;
  rows: number;
  /** 每格 2 位十六进制，`00` = 空白，其余 = 调色板下标 + 1 */
  cells: string;
  /** 紧凑调色板，顺序即 cells 里的下标 */
  palette: { hex: string; code: string }[];
  totalBeads: number;
  meanDeltaE: number;
  meta: PatternSnapshotMeta;
}

/**
 * 直接复用引擎的 meta 类型。
 *
 * 不自己再写一份结构：`brand` / `fit` / `background` / `detail` 都是
 * 联合类型字面量（如 `'MARD' | 'COCO' | …`），手抄一遍会退化成 `string`，
 * 解码出来的对象就再也塞不回 `PatternResult` 了。
 */
type PatternSnapshotMeta = PatternResult['meta'];

/** 单条快照的字符上限：超过就不存（宁可不闪，也不要把 localStorage 撑爆） */
const SNAPSHOT_MAX_CHARS = 400_000;

export function encodePatternSnapshot(pattern: PatternResult): PatternSnapshot | null {
  const { cols, rows, cells } = pattern;
  if (!cols || !rows || cells.length !== cols * rows) return null;
  /*
   * 下标必须 < 256 才能装进 2 位十六进制。色数上限 48，
   * 但引擎内部在剪枝前会短暂超员（colorLimit + 20%），留足余量。
   * 超了就不存快照 —— 只是少一次"秒开"，不影响正确性。
   */
  let maxIndex = -1;
  for (let i = 0; i < cells.length; i++) if (cells[i] > maxIndex) maxIndex = cells[i];
  if (maxIndex > 254) return null;
  if (pattern.palette.length > 255) return null;

  const chars: string[] = [];
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i] + 1;
    chars.push(v.toString(16).padStart(2, '0'));
  }
  const encoded = chars.join('');
  if (encoded.length > SNAPSHOT_MAX_CHARS) return null;

  return {
    cols,
    rows,
    cells: encoded,
    palette: pattern.palette.map((p) => ({ hex: p.hex, code: p.code })),
    totalBeads: pattern.totalBeads,
    meanDeltaE: pattern.meanDeltaE,
    meta: pattern.meta,
  };
}

/**
 * 解码快照。任何不合法就返回 null。
 *
 * 注意恢复出来的 `cells` 是 Int16Array、`palette` 的 `count/ratio/index`
 * 是按 cells 重新统计的 —— 直接信任存下来的统计值会让"UI 显示 1552 颗、
 * 画布上却有 1600 格"这种不一致有机会出现。
 */
export function decodePatternSnapshot(
  snap: unknown,
  parseHex: (hex: string) => { r: number; g: number; b: number } | null,
): PatternResult | null {
  if (!isRecord(snap)) return null;
  const cols = asFiniteNumber(snap.cols);
  const rows = asFiniteNumber(snap.rows);
  const encoded = snap.cells;
  if (cols === null || rows === null || typeof encoded !== 'string') return null;
  const c = Math.round(cols);
  const r = Math.round(rows);
  if (c < 1 || r < 1 || c > 400 || r > 400) return null;
  if (encoded.length !== c * r * 2) return null;
  if (!Array.isArray(snap.palette) || snap.palette.length === 0) return null;

  const codes: string[] = [];
  const hexes: string[] = [];
  for (const item of snap.palette) {
    if (!isRecord(item) || typeof item.hex !== 'string' || typeof item.code !== 'string') return null;
    codes.push(item.code);
    hexes.push(item.hex);
  }

  const cells = new Int16Array(c * r);
  const counts = new Array<number>(hexes.length).fill(0);
  let total = 0;
  for (let i = 0; i < cells.length; i++) {
    const v = parseInt(encoded.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(v)) return null;
    const idx = v - 1;
    if (idx < -1 || idx >= hexes.length) return null;
    cells[i] = idx;
    if (idx >= 0) {
      counts[idx]++;
      total++;
    }
  }

  const palette = hexes.map((hex, index) => {
    const rgb = parseHex(hex) ?? { r: 0, g: 0, b: 0 };
    return {
      index,
      hex,
      rgb,
      code: codes[index],
      count: counts[index],
      ratio: total ? counts[index] / total : 0,
    };
  });

  const meanDeltaE = asFiniteNumber(snap.meanDeltaE) ?? 0;
  const meta = sanitizeMeta(snap.meta);
  if (!meta) return null;

  return {
    cols: c,
    rows: r,
    cells,
    palette,
    totalBeads: total,
    meanDeltaE,
    meta,
  };
}

function sanitizeMeta(v: unknown): PatternSnapshotMeta | null {
  if (!isRecord(v)) return null;
  const sizeCm = isRecord(v.sizeCm) ? v.sizeCm : null;
  const w = sizeCm ? asFiniteNumber(sizeCm.w) : null;
  const h = sizeCm ? asFiniteNumber(sizeCm.h) : null;
  if (w === null || h === null) return null;
  /*
   * 联合类型字段（brand/fit/…）这里是"信任存档"的写法：值不在枚举里时
   * 退回默认值。逐字段展开 switch 会让这段膨胀三倍，而这些字段只在
   * 导出/描边时被读一次，给了合法值就够用。
   */
  const brand = (typeof v.brand === 'string' ? v.brand : 'MARD') as PatternSnapshotMeta['brand'];
  /*
   * 旧快照没有 beadSize。退回默认档而不是丢弃整份快照 —— 丢快照等于
   * 用户辛苦做的图纸没了，而豆径只影响尺寸文案，猜错代价极小。
   */
  const beadSizeRaw = v.beadSize;
  const beadSize = (beadSizeRaw === 'mini' || beadSizeRaw === 'midi'
    ? beadSizeRaw
    : 'midi') as PatternSnapshotMeta['beadSize'];
  const fit = (typeof v.fit === 'string' ? v.fit : 'contain') as PatternSnapshotMeta['fit'];
  const background = (typeof v.background === 'string'
    ? v.background
    : 'ignore') as PatternSnapshotMeta['background'];
  const detail = (typeof v.detail === 'string'
    ? v.detail
    : 'balanced') as PatternSnapshotMeta['detail'];
  return {
    brand,
    beadSize,
    colorLimit: asFiniteNumber(v.colorLimit) ?? 16,
    fit,
    smoothing: asFiniteNumber(v.smoothing) ?? 0.6,
    autoCrop: v.autoCrop !== false,
    background,
    dither: v.dither === true,
    chromaBoost: asFiniteNumber(v.chromaBoost) ?? 1.1,
    detail,
    regionAlgorithms: (Array.isArray(v.regionAlgorithms) ? v.regionAlgorithms : []).filter(
      (x): x is string => typeof x === 'string',
    ) as PatternSnapshotMeta['regionAlgorithms'],
    regionCoverage: asFiniteNumber(v.regionCoverage) ?? 0,
    sizeCm: { w, h },
  };
}
