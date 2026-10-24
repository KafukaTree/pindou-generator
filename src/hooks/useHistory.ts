'use client';

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { GenerateOptions, PatternResult } from '@/lib/pattern/generate';
import type { EditMap } from '@/lib/pattern/edits';
import { readStorage, writeRawStorage } from './useLocalStorage';

/**
 * 历史记录 v3
 * ===============================================================
 * v3 相对 v2 的三处结构性改动：
 *
 * **1. 修复"内存 / 磁盘分叉"（P0）**
 * v2 的 `persist()` 内部把列表裁到能写进去为止，但**没法回写调用方的
 * `storeHistory`**（`slice()` 出来的是新数组）。于是配额紧张时会出现：
 *
 * ```
 * 内存 4 条 → UI 显示「历史 4」
 * 磁盘 3 条 → 刷新后只剩 3 条，凭空少一条且无提示
 * ```
 *
 * 这是最难排查的一类 bug：静默丢数据 + 用户以为是自己看错。
 * v3 的 `persist()` **返回真正落盘成功的列表**，调用方以它为准回写，
 * 内存与磁盘永不分叉；彻底写不进时返回 `null`，此时**内存也不改**，
 * 宁可"这次没记上"也不要"看着有、刷新没了"。
 * 同时 `addToHistory` 返回 `'ok' | 'trimmed' | 'rejected'`，让上层能提示。
 *
 * **2. 一张图一条记录，调参结果作为 `versions[]`（P2）**
 * v2 里 `isDuplicate` 只比 `sourceDataUrl`，命中就覆盖 settings——
 * 修好了上一轮"一张图占满 12 条"，但矫枉过正成"只能看到最后一次调参"。
 * v3 把参数不同的多次结果存成版本：外层按原图去重（一张图一条），
 * 内层按参数指纹去重（同一套参数只留一条，只刷新时间）。
 * 原图 `sourceDataUrl` 只存一份（提到主记录上），版本只多存缩略图+参数。
 *
 * **3. `trimHistory` 用 WeakMap 缓存每条字节数（P1）**
 * v2 的 `while (JSON.stringify(list).length > MAX)` 在数据正常时只迭代
 * 0 次，但**病理数据会卡死**：每条 1MB 时单次 trim 实测 267ms（占帧
 * 预算 1600%），且每次 addToHistory 都重跑，形成持续卡顿。
 * 缓存后 trim 是纯 O(n) 加法，0 次 stringify。
 *
 * 约束：因为用对象引用做 WeakMap 键，**所有写入必须换新引用**
 * （`{...item, versions: [...]}`），绝不能 in-place `push`。违反这条
 * 会让字节缓存算错。
 *
 * 另外保留 v2 的几条正确设计：模块级单例 + `useSyncExternalStore`
 * 让所有调用方共享同一份数据；`getServerSnapshot` 返回固定空快照
 * 保证 SSR 一致；所有读写 try/catch，隐私模式退化为内存态。
 */

/* -------------------------------------------------------------------------
 * 类型
 * ---------------------------------------------------------------------- */

/**
 * 一次调参产出的结果快照 —— 不含原图，原图在父级主记录上。
 */
export interface HistoryVersion {
  /** 版本 id，稳定不变，用于 UI key 和"恢复某一版" */
  id: string;
  /** 这一版生成时的时间戳 */
  timestamp: number;
  /** 完整生成参数（决定这一版长什么样） */
  settings: GenerateOptions;

  /** 该版本的图案指标（不重新生成就能显示摘要） */
  cols: number;
  rows: number;
  totalBeads: number;
  colorCount: number;

  /**
   * 该版本的图案缩略图 dataURL。
   * **必须是 PNG**：像素画是大色块 + 硬边，JPEG 的 DCT 要为每个色块
   * 边界编码高频，实测 132px 缩略图 PNG 3.3KB vs JPEG(0.8) 6.1KB，
   * JPEG 还大了一倍并在交界处产生振铃噪点。
   */
  previewUrl: string;

  /**
   * 该版本上的手工编辑覆盖层（稀疏，`格子下标 -> 色号`，空串=擦除）。
   *
   * 为什么必须存进来：手改会改变颗数、色数和用料清单，如果只存"引擎参数"，
   * 恢复历史就等于把用户辛苦涂的一百笔全丢掉，而且列表上显示的颗数也是
   * 改之前的 —— 用户会以为历史坏了。存在版本上（而不是主记录上）是因为
   * 不同参数版本对应不同网格尺寸，格子下标不能跨版本复用。
   *
   * 体积可忽略：一条编辑的 JSON 约 13 字节（`"1234":"A01",`），
   * 涂满 2000 格也才 26KB，相比主记录的 ~58KB 不是量级。
   */
  edits?: EditMap;

  /**
   * 用户手动收藏（钉住），钉住的版本不参与版本裁剪。
   * 本轮只保留字段与裁剪保护，**UI 入口下一轮再做**（范围控制）。
   */
  pinned?: boolean;
}

export interface HistoryItem {
  id: string;
  /** 主记录时间 = 最近一次命中 / 更新的时间（列表排序用） */
  timestamp: number;

  /** 原图，全记录唯一一份，长边 ≤640 的 JPEG(q=0.75) */
  sourceDataUrl: string;
  /** 原图元信息（显示"原图 640×480"、恢复后回填文件名） */
  sourceMeta?: { width: number; height: number; name: string };

  /**
   * 版本列表，**按时间升序**（最旧在前）。数组最后一个是"当前版本"。
   * 不变量：`versions.length >= 1`。
   */
  versions: HistoryVersion[];

  /* ------------- 以下是"当前版本"的冗余投影 -------------
   * 目的：列表项渲染不必遍历 versions，且 v2 时代的上层代码
   * （page.tsx 的 handleRestore 读 item.settings / item.cols）
   * 一行都不用改就能继续工作。
   * 一致性由 withProjection() 单点保证，禁止手改其中一边。 */
  previewUrl: string;
  settings: GenerateOptions;
  cols: number;
  rows: number;
  totalBeads: number;
  colorCount: number;
}

/** 写入结果：让上层能区分"完整写入 / 裁掉了旧记录 / 完全写不进" */
export type HistoryWriteResult = 'ok' | 'trimmed' | 'rejected';

/**
 * `addToHistory` 的入参。
 * 显式列出（而不是 `Omit<HistoryItem, 'id'|'timestamp'|'versions'>`），
 * 这样 page.tsx 不必知道 `versions` / `sourceMeta` 的存在。
 */
export interface HistoryInput {
  previewUrl: string;
  sourceDataUrl: string;
  settings: GenerateOptions;
  cols: number;
  rows: number;
  totalBeads: number;
  colorCount: number;
  sourceMeta?: { width: number; height: number; name: string };
  /** 该版本上的手工编辑覆盖层（没有手改时省略，省字节） */
  edits?: EditMap;
}

export interface UseHistoryResult {
  history: HistoryItem[];
  isLoaded: boolean;
  addToHistory: (item: HistoryInput) => HistoryWriteResult;
  removeFromHistory: (id: string) => void;
  clearHistory: () => void;
}

/* -------------------------------------------------------------------------
 * 常量
 * ---------------------------------------------------------------------- */

/** v3 用新键；v2 **只读不写**，保留可回滚 */
const HISTORY_KEY = 'pindou.history.v3';
const HISTORY_KEY_V2 = 'pindou.history.v2';
/** 一次性迁移标记：迁移过就不再从 v2 读，避免重复迁移堆记录 */
const MIGRATED_FLAG = 'pindou.history.migrated.v3';

const MAX_ITEMS = 12;
/** 4.2MB，给同域其它键（主题、设置草稿）留出余量 */
const MAX_BYTES = 4.2 * 1024 * 1024;
/** 每条记录最多保留的版本数 */
export const MAX_VERSIONS_PER_ITEM = 6;

/**
 * 存储预算（按实测值，每条主记录 ≈58KB，每多一版 ≈5.3KB）：
 *   12 × 1 = 674KB (15.7%)   12 × 3 = 802KB (18.6%)
 *   12 × 6 = 1003KB (23.9%)  12 × 12 = 1376KB (32.0%)
 * 6 版留出 76% 余量，同时不至于存用户根本不会回看的调参中间态。
 */

/**
 * 历史里存的原图副本尺寸。
 *
 * 必须存一份原图，否则"恢复历史"只能还原参数、还原不了图案。
 * 但不能存原样的大 PNG：一张 512×512 PNG 的 dataURL 有 185,670 字符，
 * 12 条就 2.2MB，逼近 5MB 配额。
 *
 * 折中：长边压到 640 后**先试 PNG**（512×512 走这条路直接原样返回），
 * 超过 `SOURCE_PNG_BUDGET` 才退 JPEG 0.75（21–58KB）。缘由见
 * `compressSourceDataUrl` 的注释：JPEG 的有损会在超采样里放大成
 * 真实的色块差异，恢复出来的图纸和刚才不一样。
 */
export const SOURCE_MAX_EDGE = 640;
export const SOURCE_JPEG_QUALITY = 0.75;
/** PNG 超过这个字符数就放弃无损、退 JPEG。单张 150KB ≈ 12 张 1.8MB */
export const SOURCE_PNG_BUDGET = 200_000;
const THUMB_SIZE = 120;

/* -------------------------------------------------------------------------
 * 纯函数：指纹 / 字节 / 裁剪
 * ---------------------------------------------------------------------- */

/**
 * 生成参数指纹。
 * 只纳入**会改变图案**的字段：aspect 由原图决定（同 sourceDataUrl 必然
 * 相同），backgroundTolerance 不暴露在 UI 上，其余全部纳入。
 */
export function settingsSignature(s: GenerateOptions): string {
  const parts = [
    s.gridSize,
    s.colorLimit,
    s.brand,
    s.fit,
    s.dither ? 'd1' : 'd0',
    s.background,
    // 新引擎参数：缺省值与 generate.ts 的默认值保持一致
    (s.smoothing ?? 0.6).toFixed(3),
    s.autoCrop === false ? 'crop0' : 'crop1',
    (s.chromaBoost ?? 1.1).toFixed(3),
    // 精细度会整组换掉超采样/合并门槛/剪枝阈值，属于**强区分**参数。
    // 漏掉它会导致「均衡 → 保细节」被当成同一版本覆盖掉，
    // 用户回头想找原来那版就没了。默认值与 generate.ts 对齐为 balanced。
    s.detail ?? 'balanced',
  ];
  return parts.join('|');
}

/**
 * 单条记录的 JSON 长度缓存。
 *
 * `JSON.stringify(array).length` 的精确公式是
 * `Σ JSON.stringify(item).length + (n-1) 个逗号 + 2 个方括号`，
 * item 全是纯 ASCII（dataURL / 数字 / 英文键名），字符数 = 字节数，
 * 所以**这是精确值，不是估算**（实测 893655 == 893655）。
 *
 * 用 WeakMap 按对象引用缓存：对象被替换（新版 `{...item}`）就自动
 * 失效重算，不会像"手动维护总数计数器"那样一旦漂移就永久算错。
 */
const itemBytes = new WeakMap<HistoryItem, number>();

function bytesOf(item: HistoryItem): number {
  let n = itemBytes.get(item);
  if (n === undefined) {
    try {
      n = JSON.stringify(item).length;
    } catch {
      n = MAX_BYTES + 1; // 序列化不了：当成超大，一定要被裁掉
    }
    itemBytes.set(item, n);
  }
  return n;
}

/**
 * 按条数 + 字节双上限裁剪（从最旧的开始丢，永远保留最新一条）。
 * 正常数据下 `while` 迭代 0 次，只做 O(n) 加法，**0 次 stringify**。
 */
export function trimHistory(items: HistoryItem[]): HistoryItem[] {
  const list = items.slice(0, MAX_ITEMS);
  if (list.length === 0) return list;

  let total = 2; // "[" + "]"
  for (let i = 0; i < list.length; i++) {
    total += bytesOf(list[i]);
    if (i > 0) total += 1; // 逗号
  }

  let end = list.length;
  while (end > 1 && total > MAX_BYTES) {
    total -= bytesOf(list[end - 1]) + 1; // 条目 + 逗号
    end--;
  }
  return end === list.length ? list : list.slice(0, end);
}

/** 与 `JSON.stringify(list)` 逐字节一致，但条目只 stringify 一次 */
function buildHistoryJson(list: HistoryItem[]): string {
  const parts: string[] = new Array(list.length);
  for (let i = 0; i < list.length; i++) parts[i] = JSON.stringify(list[i]);
  return `[${parts.join(',')}]`;
}

/**
 * 版本裁剪：优先保住 pinned，再从最旧的开始丢。
 * 返回**时间升序**的新数组（不 mutate 入参）。
 */
function trimVersions(list: HistoryVersion[], max: number): HistoryVersion[] {
  if (list.length <= max) return list;
  const pinned = list.filter((v) => v.pinned === true);
  const rest = list.filter((v) => v.pinned !== true);
  const keep = Math.max(1, max - pinned.length);
  const kept = [...pinned, ...rest.slice(Math.max(0, rest.length - keep))];
  return kept.sort((a, b) => a.timestamp - b.timestamp);
}

/** 由 versions 推出投影字段 —— 唯一的投影生成入口 */
function withProjection(
  base: Omit<
    HistoryItem,
    'versions' | 'previewUrl' | 'settings' | 'cols' | 'rows' | 'totalBeads' | 'colorCount'
  >,
  versions: HistoryVersion[],
): HistoryItem {
  const head = versions[versions.length - 1];
  return {
    ...base,
    versions,
    previewUrl: head.previewUrl,
    settings: head.settings,
    cols: head.cols,
    rows: head.rows,
    totalBeads: head.totalBeads,
    colorCount: head.colorCount,
  };
}

/**
 * 往主记录里 upsert 一个版本（**换新引用，不 in-place mutate**）。
 * 内层去重用 `settingsSignature`：同一套参数重复生成只刷新时间/缩略图，
 * 不新增版本。裁剪后投影跟着最新版本走。
 *
 * 手工编辑**不进签名**：同一套参数下涂抹一百格不该多出一个版本（否则
 * 调色板里每涂一笔就多一版，把 6 个版本槽瞬间占满）。画笔的落点变化
 * 只覆盖当前版本里的 `edits`，颗粒数/色数随之更新 —— 这正是用户预期的
 * "我在这张图上的成果"。
 */
function upsertVersion(item: HistoryItem, ver: HistoryVersion): HistoryItem {
  const sig = settingsSignature(ver.settings);
  const kept = item.versions.filter((v) => settingsSignature(v.settings) !== sig);
  const versions = trimVersions([...kept, ver], MAX_VERSIONS_PER_ITEM);
  return withProjection({ ...item, timestamp: ver.timestamp }, versions);
}

function makeId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    /* 老浏览器 / 非安全上下文 */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解析失败'));
    img.src = src;
  });
}

/* -------------------------------------------------------------------------
 * 图片工具（导出供上层调用：压原图 / 生成缩略图）
 * ---------------------------------------------------------------------- */

/**
 * 把任意图片 dataURL 压成"可持久化"的版本：长边 ≤ maxEdge。
 * 必须在把图片塞进历史记录之前调用，否则 localStorage 会被原图撑爆。
 * 透明区域铺白底（拼豆图案本来就按白纸处理）。
 *
 * **优先无损**：先试 PNG，只有 PNG 太大（超过 budget 字符）才退到 JPEG。
 *
 * 为什么值得多花这点字节：历史记录存的是"重新生成图案所需的源图"，
 * 用户点恢复会拿它再跑一遍引擎。JPEG 的块效应会在超采样时被放大成
 * 真实的色块差异 —— 实测同一张鸭子图，源图用 512px JPEG(q0.75) 恢复
 * 出来是 1565 颗 / 8 色，而原始 PNG 是 1552 颗 / 9 色。用户看到的是
 * "我恢复出来的图和刚才不一样"，这比多占 100KB 难受得多。
 * 预算也撑得住：一张图的 PNG base64 约 140KB，12 张 1.7MB，
 * 上限是 4.2MB。
 */
export async function compressSourceDataUrl(
  dataUrl: string,
  maxEdge = SOURCE_MAX_EDGE,
  quality = SOURCE_JPEG_QUALITY,
  pngBudget = SOURCE_PNG_BUDGET,
): Promise<string> {
  // 已经是"小图"就不重复编码，避免二次损失
  try {
    const img = await loadImage(dataUrl);
    const long = Math.max(img.naturalWidth, img.naturalHeight);
    if (long <= maxEdge && (dataUrl.startsWith('data:image/jpeg') || dataUrl.startsWith('data:image/png'))) {
      return dataUrl;
    }
    const scale = Math.min(1, maxEdge / long);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    // 无损优先：同一份像素先试 PNG，只在超预算时才接受 JPEG 的有损
    const png = canvas.toDataURL('image/png');
    if (png.length <= pngBudget) return png;
    return canvas.toDataURL('image/jpeg', quality);
  } catch {
    // 压缩失败就用原图（总比没有强，字节裁剪会兜住）
    return dataUrl;
  }
}

/**
 * 从图案结果渲染一张小缩略图（默认 120×120，保持宽高比、透明底）。
 * 这是历史列表里唯一"看得见"的东西，所以按真实 palette 颜色逐格填。
 * 输出 PNG（理由见 `HistoryVersion.previewUrl` 的注释）。
 */
export function renderPatternThumbnail(
  pattern: Pick<PatternResult, 'cells' | 'cols' | 'rows' | 'palette'>,
  maxSize = THUMB_SIZE,
): string {
  const { cols, rows, cells, palette } = pattern;
  if (!cols || !rows) return '';
  const scale = Math.max(1, Math.floor(maxSize / Math.max(cols, rows)));
  // 放大到整数倍像素，保持像素画的硬边
  const w = cols * scale;
  const h = rows * scale;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.imageSmoothingEnabled = false;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = cells[row * cols + col];
      if (idx < 0) continue;
      const color = palette[idx];
      if (!color) continue;
      ctx.fillStyle = color.hex;
      ctx.fillRect(col * scale, row * scale, scale, scale);
    }
  }
  return canvas.toDataURL('image/png');
}

/* -------------------------------------------------------------------------
 * 数据校验 / 迁移
 * ---------------------------------------------------------------------- */

/**
 * 把磁盘上任意形状的 `edits` 洗成可用的 `EditMap`。
 *
 * 为什么要洗：这是会进 localStorage 的字段，可能被手工改过、被旧版本
 * 写成别的形状、或者在配额压力下被截断成半截 JSON。直接信任它会让
 * `applyEdits` 在渲染里抛异常（那是最难查的一类白屏）。
 *
 * 过滤规则与 `applyEdits` 保持一致：
 *  - 键必须是**规范十进制下标**（`"007"` 这种和 `"7"` 不是同一个键，
 *    放进去会变成两个互相覆盖的条目）
 *  - 值必须是字符串色号（空串保留，那代表"擦除成透明格"）
 *  - 同时丢掉越界下标（`>= cols*rows`），否则恢复旧图时会跳到别的格
 */
function sanitizeEdits(raw: unknown, cols: number, rows: number): EditMap | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const limit = cols > 0 && rows > 0 ? cols * rows : Infinity;
  const out: EditMap = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string' || v.length > 16) continue;
    if (!/^(0|[1-9]\d*)$/.test(k)) continue;
    const idx = Number(k);
    if (!Number.isSafeInteger(idx) || idx < 0 || idx >= limit) continue;
    out[idx] = v;
    if (++n >= 200_000) break; // 上限保护：正常图案最多几万格
  }
  return n > 0 ? out : undefined;
}

function normalizeVersion(raw: unknown): HistoryVersion | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.timestamp !== 'number' || !v.settings) return null;
  const cols = typeof v.cols === 'number' ? v.cols : 0;
  const rows = typeof v.rows === 'number' ? v.rows : 0;
  /*
   * 注意这里**必须把 edits 带上**。
   *
   * 曾经的 bug：写入侧把 edits 存进了 localStorage，但读取侧
   * （normalizeVersion）不认识这个字段，刷新一次就被丢掉。表现是
   * "涂完立刻看历史有手改，刷新后恢复回来变空白" —— 而且不报错，
   * 因为两个方向在类型上都合法（可选字段）。只加写入不加读取是最
   * 典型的半截改动。
   */
  const edits = sanitizeEdits(v.edits, cols, rows);
  return {
    id: typeof v.id === 'string' && v.id ? v.id : makeId(),
    timestamp: v.timestamp,
    settings: v.settings as GenerateOptions,
    cols,
    rows,
    totalBeads: typeof v.totalBeads === 'number' ? v.totalBeads : 0,
    colorCount: typeof v.colorCount === 'number' ? v.colorCount : 0,
    previewUrl: typeof v.previewUrl === 'string' ? v.previewUrl : '',
    ...(edits ? { edits } : {}),
    ...(v.pinned === true ? { pinned: true } : {}),
  };
}

/**
 * 把任意形状的一条记录规范化成 v3 形状。
 * 兼容三种输入：
 *  - v3（有 versions 数组）
 *  - v2（扁平字段，无 versions）→ 视为"只有 1 个版本"
 *  - 手工篡改 / 半损坏 → 缺关键字段就返回 null 丢弃
 */
function normalizeItem(raw: unknown): HistoryItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const it = raw as Record<string, unknown>;

  // 没有原图就无法真正还原，直接丢弃（v1→v2 时代同样的约定）
  if (typeof it.sourceDataUrl !== 'string' || !it.sourceDataUrl) return null;
  if (typeof it.timestamp !== 'number' || !it.settings) return null;

  let versions: HistoryVersion[];
  if (Array.isArray(it.versions) && it.versions.length > 0) {
    versions = it.versions
      .map(normalizeVersion)
      .filter((v): v is HistoryVersion => v !== null)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (versions.length === 0) return null;
  } else {
    // v2 形状：本体就是唯一版本
    const single = normalizeVersion(it);
    if (!single) return null;
    versions = [single];
  }

  const meta = it.sourceMeta as HistoryItem['sourceMeta'] | undefined;
  return withProjection(
    {
      id: typeof it.id === 'string' && it.id ? it.id : makeId(),
      timestamp: it.timestamp,
      sourceDataUrl: it.sourceDataUrl,
      ...(meta && typeof meta.width === 'number' && typeof meta.height === 'number'
        ? { sourceMeta: meta }
        : {}),
    },
    trimVersions(versions, MAX_VERSIONS_PER_ITEM),
  );
}

function sanitizeList(raw: unknown): HistoryItem[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryItem[] = [];
  for (const it of raw) {
    const norm = normalizeItem(it);
    if (norm) out.push(norm);
  }
  // 磁盘里的顺序可能被打乱（手工编辑 / 旧版本 bug），统一按时间倒序
  return out.sort((a, b) => b.timestamp - a.timestamp);
}

/* -------------------------------------------------------------------------
 * 模块级共享 store
 * -------------------------------------------------------------------------
 * 历史是**全局唯一**资源，不能按组件复制。v2 之前每个组件各持一份
 * useState，于是 page.tsx 写进 A 的状态、HistoryList 里 B 还看着自己的
 * 空数组 —— 顶栏永远「历史 0」，但 localStorage 里明明有 3 条。
 * 改成模块级单例 + useSyncExternalStore：所有调用方共享同一份数据。
 */

type HistorySnapshot = { history: HistoryItem[]; isLoaded: boolean };

let storeHistory: HistoryItem[] = [];
let storeLoaded = false;
let storeSnapshot: HistorySnapshot = { history: storeHistory, isLoaded: storeLoaded };
const storeListeners = new Set<() => void>();
const SERVER_SNAPSHOT: HistorySnapshot = { history: [], isLoaded: false };

function publish(): void {
  storeSnapshot = { history: storeHistory, isLoaded: storeLoaded };
  for (const notify of storeListeners) notify();
}

/* -------------------------------------------------------------------------
 * 写盘：这是 P0 的核心
 * ---------------------------------------------------------------------- */

interface PersistOutcome {
  /** 真正落盘成功的列表；null = 一条都没写进去，磁盘未变 */
  saved: HistoryItem[] | null;
  /** 是否裁掉了条目（条数上限或字节上限） */
  trimmed: boolean;
  /** 最后一次尝试写入的 JSON 字符数 */
  bytes: number;
  /** 失败时的 DOMException.name（QuotaExceededError / SecurityError…） */
  error?: string;
}

/**
 * 写盘并**返回实际落盘的列表**。
 *
 * 关键点：`trimHistory` 之后如果 localStorage 仍报配额错误（同域别的
 * 键占着空间），继续从最旧的丢，直到写成功或只剩 1 条。
 * 返回 `saved` 让调用方回写内存，**内存与磁盘永不分叉**；
 * 返回 `null` 表示磁盘上什么都没变，调用方应保持内存不动。
 */
function persist(items: HistoryItem[]): PersistOutcome {
  let list = trimHistory(items);
  let trimmed = list.length < items.length;
  let bytes = 0;

  for (;;) {
    const json = buildHistoryJson(list);
    bytes = json.length;
    const res = writeRawStorage(HISTORY_KEY, json);
    if (res.ok) return { saved: list, trimmed, bytes };
    if (list.length <= 1) return { saved: null, trimmed, bytes, error: res.error };
    list = list.slice(0, -1);
    trimmed = true;
  }
}

/**
 * 原子读改写：以后无论多少调用方，都不会交叉丢更新。
 * 返回写入结果，供 `addToHistory` 透传给上层做 UI 提示。
 */
function mutate(fn: (prev: HistoryItem[]) => HistoryItem[]): HistoryWriteResult {
  const next = fn(storeHistory);
  const res = persist(next);

  if (res.saved === null) {
    // 磁盘一条都没写进去：**内存也不改**。
    // 内存有、磁盘没有 = 用户刷新后凭空丢记录，比"这次没记上"难解释得多。
    console.warn(
      `[history] 写入失败（${res.error ?? 'Unknown'}）：${res.bytes} 字符仍装不下，` +
        `本次未记录。内存与磁盘均保持原状，避免分叉。`,
    );
    return 'rejected';
  }

  storeHistory = res.saved;
  publish();

  if (res.trimmed) {
    console.warn(
      `[history] 磁盘紧张，已裁剪旧记录：实际落盘 ${res.saved.length} 条 / ` +
        `${res.bytes} 字符（上限 ${MAX_BYTES} 字符）。`,
    );
    return 'trimmed';
  }
  return 'ok';
}

/* -------------------------------------------------------------------------
 * 加载 / 迁移
 * ---------------------------------------------------------------------- */

let loadStarted = false;

function ensureLoaded(): void {
  if (loadStarted || typeof window === 'undefined') return;
  loadStarted = true;

  // 1) 优先读 v3。注意用 `!== null` 判断"键存在"：
  //    用户清空后 v3 是 "[]"，此时**不能**再回头迁移 v2，
  //    否则清空的历史会被旧数据"复活"。
  const storedV3 = readStorage<unknown>(HISTORY_KEY, null);
  if (storedV3 !== null) {
    storeHistory = trimHistory(sanitizeList(storedV3));
    storeLoaded = true;
    publish();
    return;
  }

  // 2) v3 不存在 → 一次性迁移 v2（v2 只读不写，保留可回滚）
  const migrated = readStorage<boolean>(MIGRATED_FLAG, false);
  const storedV2 = readStorage<unknown>(HISTORY_KEY_V2, null);
  if (!migrated && storedV2 !== null) {
    const items = trimHistory(sanitizeList(storedV2));
    const res = persist(items);
    if (res.saved) {
      storeHistory = res.saved;
      writeRawStorage(MIGRATED_FLAG, 'true');
    } else {
      // 迁移写不进：内存先展示（这些是用户**本来就有**的数据，不是伪造的），
      // 但不写迁移标记，下次刷新会重试迁移。
      storeHistory = items;
    }
    storeLoaded = true;
    publish();
    return;
  }

  // 3) 全新用户
  storeHistory = [];
  storeLoaded = true;
  publish();
}

function subscribe(listener: () => void): () => void {
  storeListeners.add(listener);
  ensureLoaded();
  return () => {
    storeListeners.delete(listener);
  };
}

function getSnapshot(): HistorySnapshot {
  return storeSnapshot;
}

function getServerSnapshot(): HistorySnapshot {
  return SERVER_SNAPSHOT;
}

/* -------------------------------------------------------------------------
 * Hook
 * ---------------------------------------------------------------------- */

export function useHistory(): UseHistoryResult {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const addToHistory = useCallback((item: HistoryInput): HistoryWriteResult => {
    const now = Date.now();
    const ver: HistoryVersion = {
      id: makeId(),
      timestamp: now,
      settings: item.settings,
      cols: item.cols,
      rows: item.rows,
      totalBeads: item.totalBeads,
      colorCount: item.colorCount,
      previewUrl: item.previewUrl,
      // 没有手改时**不写这个键**（而不是写 {}），一条记录能省 10 字节；
      // 数量少但 12 条 × 6 版都带一个空对象也是白占预算
      ...(item.edits && Object.keys(item.edits).length > 0
        ? { edits: item.edits }
        : {}),
    };

    return mutate((prev) => {
      /*
       * 外层去重：同一张原图 → 同一条主记录。
       *
       * 只比 sourceDataUrl，**不比参数指纹**。因为"历史"回答的是
       * "我做过哪些图"，而不是"我在这张图上试过哪些参数"；
       * 参数差异属于**版本**（见下面的 upsertVersion）。
       * 之前两个都比时，拖一次滑杆就多一条记录，12 条被一张图占满
       * （用户原话：「没有一个图往往占用很多历史，直接占满了12个」）。
       */
      const existing = prev.find((p) => p.sourceDataUrl === item.sourceDataUrl);

      if (existing) {
        const updated = upsertVersion(existing, ver);
        return [updated, ...prev.filter((p) => p.id !== existing.id)];
      }

      const created = withProjection(
        {
          id: makeId(),
          timestamp: now,
          sourceDataUrl: item.sourceDataUrl,
          ...(item.sourceMeta ? { sourceMeta: item.sourceMeta } : {}),
        },
        [ver],
      );
      return [created, ...prev];
    });
  }, []);

  const removeFromHistory = useCallback((id: string) => {
    mutate((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const clearHistory = useCallback(() => {
    /*
     * 清空时**写 `[]` 而不是删键**。
     *
     * 删键会让 `ensureLoaded` 的 `storedV3 !== null` 判定失败，于是流程
     * 落到"v3 不存在 → 尝试从 v2 迁移"分支。正常情况下有 MIGRATED_FLAG
     * 挡着，但**如果上次迁移写标记失败**（配额满），标记就是 false，
     * 用户清空的历史会被 v2 的旧数据原地复活 —— 用户会以为清空没生效。
     *
     * 写 `[]` 让"键存在但是空"成为一个明确的墓碑，从根上杜绝复活。
     */
    mutate(() => []);
  }, []);

  // 返回值保持引用稳定，避免上层放进 deps 时反复重渲染
  return useMemo(
    () => ({
      history: snap.history,
      isLoaded: snap.isLoaded,
      addToHistory,
      removeFromHistory,
      clearHistory,
    }),
    [snap, addToHistory, removeFromHistory, clearHistory],
  );
}

export default useHistory;

/* -------------------------------------------------------------------------
 * 调试 / 测试辅助（导出给探针脚本用，业务代码不必调用）
 * ---------------------------------------------------------------------- */

/** 当前列表的精确字节数（与落盘 JSON 长度一致） */
export function historyBytes(items: HistoryItem[]): number {
  return buildHistoryJson(items).length;
}

/** 仅在测试里重置模块级 store（模拟 HMR / 新标签页） */
export function __resetHistoryStoreForTests(): void {
  storeHistory = [];
  storeLoaded = false;
  loadStarted = false;
  storeSnapshot = { history: [], isLoaded: false };
}
