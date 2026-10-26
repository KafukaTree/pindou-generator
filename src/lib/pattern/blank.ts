'use client';

/**
 * 空白画布
 * ===============================================================
 * 拼豆不总是"有原图 → 生成图纸"。有一大类真实需求是从零开始：
 *
 *   · 想拼一个自己画的像素小人 / 表情包 / 文字牌，根本没有参考图；
 *   · 想在一片 29×29 的标准板上照着别人的成品复刻；
 *   · 想给孩子拼一块"生日快乐"，只要格子，不要算法掺和。
 *
 * 这些场景下"上传一张纯白图片再让它生成"是很糟糕的兜底：引擎会在白底上
 * 做自动裁背景、超采样、调色板选择，最后给出一张可能被裁得只剩几个像素
 * 的空图纸，颜色也是它自己编的。
 *
 * 所以这里直接给一个"全空"的 PatternResult —— 每格都是 -1（不拼豆），
 * 调色板为空，颗数为 0。用户在编辑模式里一格一格涂，涂什么色、拼多少颗
 * 完全由他自己决定。它与引擎产物共享同一个 `PatternResult` 结构，所以
 * 画布、色号、图例、用料清单、PDF、历史全都不需要第二套代码。
 *
 * 几个关键约定：
 *
 * 1. **cells 全 -1，不是全 0**。0 会指向调色板第 0 色，而空白画布的调色板
 *    是空的 —— 那样画布会崩在一次越界读取上。-1 是引擎既有的"不拼豆"约定。
 *
 * 2. **palette 为空是合法状态**。`applyEdits` 会把用户涂的第一个色号追加进
 *    调色板，所以"空调色板"只是初始态。下游所有读 palette 的地方都必须
 *    容忍空数组（图例直接不渲染、PDF 按钮禁用），这是空白画布能成立的前提。
 *
 * 3. **meta 仍然是完整的**。它记录品牌与参数快照，供 PDF 复现与历史恢复；
 *    空白画布没有"生成参数"这回事，就填当前选项的副本，至少 brand 是对的。
 */

import type { DetailAlgorithm } from './detail';
import { DEFAULT_BEAD_SIZE, type BeadSize } from './board';
import { estimateSizeCm, type GenerateOptions, type PatternResult } from './generate';

/** 空白画布允许的行列范围。上限与引擎的 320 格对齐（见 PatternSettings） */
export const BLANK_MIN = 4;
export const BLANK_MAX = 320;

/**
 * 常用底板尺寸。
 *
 * 这些不是随便取的：拼豆板本身是固定规格，29×29 是最常见的单板，
 * 57×57 是四块板拼起来的方垫，下面几个是手作圈里最常买的挂饰/摆件尺寸。
 * 自己输入行列的入口也留着 —— 复刻别人的图纸时行列数是硬约束。
 */
export const BLANK_PRESETS: readonly { cols: number; rows: number; label: string; note: string }[] = [
  { cols: 15, rows: 15, label: '15 × 15', note: '迷你挂件' },
  { cols: 29, rows: 29, label: '29 × 29', note: '单块标准板' },
  { cols: 36, rows: 36, label: '36 × 36', note: '小摆件' },
  { cols: 57, rows: 57, label: '57 × 57', note: '四板方形垫' },
  { cols: 96, rows: 96, label: '96 × 96', note: '大幅挂画' },
] as const;

export function clampBlank(n: number): number {
  if (!Number.isFinite(n)) return BLANK_MIN;
  return Math.max(BLANK_MIN, Math.min(BLANK_MAX, Math.round(n)));
}

/**
 * 给一块新画布生成身份。
 *
 * 用时间戳 + 随机数而不是纯随机：时间戳让历史按"新建的先后"排起来更自然，
 * 随机后缀防止同一毫秒内连点两次撞车。格式限定 `[\w-]`，这样它能安全地
 * 嵌进 `blank:29x29@<id>` 而被正则稳定解出。
 */
export function makeBlankId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 造一张全空的图纸。
 *
 * @param cols 列数（宽）
 * @param rows 行数（高）
 * @param options 当前参数快照，只取与"能不能拼"相关的字段进 meta
 */
export function makeBlankPattern(
  cols: number,
  rows: number,
  options: GenerateOptions,
): PatternResult {
  const safeCols = clampBlank(cols);
  const safeRows = clampBlank(rows);
  return {
    cols: safeCols,
    rows: safeRows,
    // Int16Array 的默认值就是 0，必须显式填 -1
    cells: new Int16Array(safeCols * safeRows).fill(-1),
    palette: [],
    totalBeads: 0,
    /*
     * 平均色差对空白画布没有意义（没有原图可比）。填 0 而不是 NaN：
     * 页面有一处会 toFixed(3) 显示它，NaN 会渲染成 "NaN"，比显示 0.000 更糟。
     */
    meanDeltaE: 0,
    meta: {
      brand: options.brand,
      beadSize: (options.beadSize ?? DEFAULT_BEAD_SIZE) as BeadSize,
      colorLimit: options.colorLimit,
      fit: options.fit,
      smoothing: options.smoothing ?? 0.6,
      autoCrop: false,
      background: options.background ?? 'keep',
      dither: false,
      chromaBoost: options.chromaBoost ?? 1.1,
      detail: (options.detail ?? 'balanced') as DetailAlgorithm,
      regionAlgorithms: [],
      regionCoverage: 0,
      sizeCm: estimateSizeCm(safeCols, safeRows, options.beadSize ?? DEFAULT_BEAD_SIZE),
    },
  };
}

/**
 * 空白画布在历史记录里的"原图"占位符。
 *
 * `HistoryItem.sourceDataUrl` 必填且上层会拿它做三件事：外层去重、恢复时
 * 判断这是不是空白画布、以及（非空白时）重新解码。所以这串东西有两个
 * 必须同时成立的性质：
 *
 *  1. **永远不会被当成 dataURL 去解码**。前缀 `blank:` 保证它不可能是
 *     `data:` 开头；恢复历史时先 `parseBlankSourceKey` 认出它，根本走不到
 *     `img.src`。
 *
 *  2. **不同的空白画布必须是不同的字符串**。这一点很容易漏：只编尺寸
 *     （`blank:29x29`）时，用户在历史里那套"同 sourceDataUrl 就合并成
 *     一条、参数不同加一个版本"的去重逻辑会把**两块内容完全无关的
 *     29×29 板子并成同一条记录**，后画的那块把先画的顶掉 —— 手工内容
 *     不在版本签名里，所以顶掉就是丢了。
 *
 * 所以带上一个每块画布独有的 `id`。id 由调用方在"新建"那一刻生成一次，
 * 同一块画布后续所有编辑都复用它 —— 于是"一块板子 + 它一路画下来的样子"
 * 正好对应一条历史记录 + 多个版本，语义与图片流程完全一致。
 */
export function blankSourceKey(cols: number, rows: number, id?: string): string {
  const base = `blank:${cols}x${rows}`;
  return id ? `${base}@${id}` : base;
}

/** 反解占位符里的尺寸与画布身份；不是空白画布则返回 null */
export function parseBlankSourceKey(
  key: string,
): { cols: number; rows: number; id?: string } | null {
  const m = /^blank:(\d+)x(\d+)(?:@([\w-]+))?$/.exec(key);
  if (!m) return null;
  const cols = Number(m[1]);
  const rows = Number(m[2]);
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  if (cols < 1 || rows < 1) return null;
  return m[3] ? { cols, rows, id: m[3] } : { cols, rows };
}

/** 空白画布的缩略图（历史列表用）：一张空地板的棋盘格 */
export function blankThumbnail(cols: number, rows: number, size = 132): string | null {
  if (typeof document === 'undefined') return null;
  const cell = Math.max(1, Math.floor(size / Math.max(cols, rows)));
  const w = cols * cell;
  const h = rows * cell;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // 与画布的空白格同款棋盘：一眼能看出"这是张还没画的板子"
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#F3E9D7' : '#FFFBF0';
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  return canvas.toDataURL('image/png');
}
