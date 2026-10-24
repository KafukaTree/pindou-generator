/**
 * PDF 图纸导出
 * ---------------------------------------------------------------------------
 * 设计目标（相对旧实现）：
 *
 * 1. **分页图纸**：大网格按页切成 tile，相邻 tile 有 2 行/列重叠，方便对齐；
 *    每页写清 "Tile X / Y, Cols a-b, Rows c-d"。
 * 2. **全局行列标尺**：每 5 格标数字、10 的倍数加粗，数字用全局 1-based 行列号，
 *    跨页连续可对。
 * 3. **色号真的印出来**：字号按实际 cellSize 反算（用 getTextWidth 实测宽度），
 *    最小 3.2pt；放不下时降级成"该色在图例中的序号"，并图例页说明；
 *    字色用 readableInkFor() 的 WCAG 结果。
 * 4. **三级网格线**：1 格细线 / 5 格中线 / 10 格粗线。
 * 5. **封面**：标题、品牌、规格、颜色数、总豆子数、5mm 成品尺寸、日期、
 *    缩略预览、色号速查表。
 * 6. **用料清单**：色块 / 色号 / HEX / 颗数 / 占比 / 建议购买量（+10% 向上取整到 10 的倍数）。
 * 7. **全英文**：jsPDF 内置 helvetica 不含中文字形，任何中文都会变成方块，
 *    因此所有输出字符串都过 toAscii()；品牌名用 ASCII 别名。
 * 8. **性能**：色块填充按"同色横向连续 run"合并 + 按颜色分组减少状态切换；
 *    网格线按 3 个 pass 批量画；文字按 (字号, 字色) 分桶批量画。
 *    单元格数 > 14400 时强制只印图例序号，避免字太长排不下。
 */

import { NextRequest, NextResponse } from 'next/server';
import { jsPDF } from 'jspdf';
import { BRANDS, type Brand } from '@/lib/color/palette';
import { parseHex, readableInkFor, type Rgb } from '@/lib/color/oklab';

export const runtime = 'nodejs';
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// 版面常量（单位 mm，A4 竖版 210 x 297）
// ---------------------------------------------------------------------------

const PAGE_W = 210;
const PAGE_H = 297;
const M = 10; // 外页边距

const HEADER_H = 24; // 页眉区（标题 + 副标题 + tile 小地图）
const TOP_RULER_H = 6; // 顶部标尺带高度
const LEFT_RULER_W = 9; // 左侧标尺带宽度
const BOTTOM_RESERVE = 14; // 页脚预留

const GRID_LEFT = M + LEFT_RULER_W; // 19
const GRID_TOP = M + HEADER_H + TOP_RULER_H; // 40
const AVAIL_W = PAGE_W - GRID_LEFT - M; // 181
const AVAIL_H = PAGE_H - GRID_TOP - BOTTOM_RESERVE; // 243
/**
 * 分页图纸每页底部预留的信息区（本页色号 + 拼接指引 + 注记）。
 * 实测：标题 5 + 4 行邻近块 18.4 + 3 行注记 10.8 + 顶部留白 8 ≈ 42.5，
 * 取 44 可以保证最长的注记也不会撞到页脚。
 */
const INFO_H = 44;
const TILE_AREA_H = AVAIL_H - INFO_H; // 207

const OVERLAP = 2; // 相邻 tile 重叠格数
const TARGET_CELL = 6; // 拆页时希望的单格边长（mm）：页数还有余量时的首选
const MAX_CELL = 9; // 单页渲染时单格上限（mm），避免小图格子巨大
const MIN_SINGLE_CELL = 5.5; // 整图能一页放下且单格 >= 该值才不拆页
const MAX_CELLS_WITH_CODES = 14400; // 超过则只印图例序号
const MIN_LABEL_PT = 3.2; // 色号最小字号（pt）
const PT_PER_MM = 72 / 25.4; // 2.8346

/*
 * 大网格（最长边 320）的配套常量。
 * ---------------------------------------------------------------------------
 * 320 格在 A4 上不可能既 1:1 又页数少：1:1 需要单格 5mm，320x270 就是
 * 9 x 7 = 63 页。所以这里用"页数目标优先"的策略：先按 TARGET_CELL 试，
 * 页数超标就逐档降低期望单格（每页塞更多格），直到页数回到 PAGE_TARGET。
 *
 * - PAGE_TARGET：软目标页数。320x270 -> 24 页 / 单格 3.0mm；
 *   320x320 -> 20 页 / 单格 2.5mm。这个尺寸下色号印不下，会自动降级成
 *   图例序号（4~5pt），仍然可读。
 * - MAX_PAGES：硬上限。软目标达不到时允许的最多页数，再超直接 400。
 * - MIN_TILE_CELL：拆页时单格物理下限，低于它还超页数说明已经没法用了。
 * - MIN_TEXT_CELL_MM：单格小于 1.6mm 时格内**什么都不印**（3.2pt 字高
 *   约 1.13mm，比格子还宽，硬印会糊成墨块），只靠行列标尺定位。
 * - TRUE_SCALE_CELL：单格小于 4mm 时纸面已经不是"照着摆豆子"的尺寸，
 *   封面要给放大打印提示。
 * - MAX_CELLS_WITH_CODES (14400) 对大图依然生效：86400 格必然走序号模式。
 */
const PAGE_TARGET = 24;
const MAX_PAGES = 36;
const MIN_TILE_CELL = 0.42;
/**
 * 逐格印色号的最低单格尺寸。低于它时 4 字符色号只剩 3pt 出头，整页几千个
 * "2 3 8 9"的碎数字让图纸变成噪声 —— 此时改走"大色块一个标记"的模式
 * （见 drawPatternTile 的 B 分支），大块只标一次，看得清也找得到。
 */
const PER_CELL_LABEL_MIN_MM = 4.0;
/** 大色块标注：块边长约等于纸面这么多毫米，块内主导色 >=70% 才标 */
const BLOCK_LABEL_MM = 13;
const BLOCK_MIN_LABEL_PT = 5.2;
/** 大色块标记的字号上限（pt）：再大就会盖过网格本身 */
const BLOCK_MAX_LABEL_PT = 10;
const TRUE_SCALE_CELL = 4.0;
/** 网格边长硬上限（对应 320 格豆板规格） */
const MAX_DIM = 320;

// ---------------------------------------------------------------------------
// 配色
// ---------------------------------------------------------------------------

type RgbTuple = [number, number, number];

/*
 * 配色跟 globals.css 的「奶白 + 浅玫瑰粉」主题对齐。
 * 之前这里是旧的陶土橙（ACCENT 176,90,60 / 纸色 246,242,233），
 * 网页改版后 PDF 还是暖棕色，导出的纸和屏幕像两个产品。
 * 现在 ACCENT = --clay #A94A66、INK = --ink #3A2A30、
 * PAPER_TINT = --paper-sunken #F3EAE9、RULE = --line #E2D5D4。
 */
const INK: RgbTuple = [58, 42, 48];
const INK_SOFT: RgbTuple = [107, 86, 92];
const INK_FAINT: RgbTuple = [156, 134, 140];
const RULE: RgbTuple = [226, 213, 212];
const PAPER_TINT: RgbTuple = [243, 234, 233];
const ACCENT: RgbTuple = [169, 74, 102];
const GRID_THIN: RgbTuple = [156, 134, 140];
const GRID_MID: RgbTuple = [107, 86, 92];
const GRID_BOLD: RgbTuple = [58, 42, 48];
const WHITE: RgbTuple = [255, 255, 255];

const LINE_THIN = 0.08;
const LINE_MID = 0.22;
const LINE_BOLD = 0.5;

/** 标尺刻度间隔（格）。小格子时间距不够放数字，会自适应放大到 10 / 20 */
const RULER_MINOR = 5;
const RULER_MAJOR = 10;

const BRAND_ASCII: Record<Brand, string> = {
  MARD: 'MARD',
  COCO: 'COCO',
  漫漫: 'ManMan',
  盼盼: 'PanPan',
  咪小窝: 'MiXiaoWo',
};

// ---------------------------------------------------------------------------
// 请求校验
// ---------------------------------------------------------------------------

interface IncomingPaletteEntry {
  hex: string;
  code: string;
  count?: number;
  ratio?: number;
}

interface IncomingBody {
  cols?: unknown;
  rows?: unknown;
  brand?: unknown;
  cells?: unknown;
  palette?: unknown;
  totalBeads?: unknown;
  generatedAt?: unknown;
}

interface CleanPaletteEntry {
  index: number;
  hex: string;
  rgb: Rgb;
  code: string;
  count: number;
  ratio: number;
}

interface CleanRequest {
  cols: number;
  rows: number;
  brand: Brand;
  brandLabel: string;
  cells: Int16Array;
  palette: CleanPaletteEntry[];
  totalBeads: number;
  blankCells: number;
  generatedAt: string;
}

function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

function toAscii(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, '?');
}

/** 解析并校验请求体；返回 NextResponse 表示校验失败 */
function validateBody(raw: IncomingBody): CleanRequest | NextResponse {
  const cols = Number(raw.cols);
  const rows = Number(raw.rows);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    return badRequest('cols and rows must be positive integers');
  }
  if (cols > MAX_DIM || rows > MAX_DIM) {
    return badRequest(`cols and rows must be <= ${MAX_DIM}`);
  }

  const brandValue = typeof raw.brand === 'string' ? raw.brand : '';
  if (!(BRANDS as readonly string[]).includes(brandValue)) {
    return badRequest(`brand must be one of: ${BRANDS.join(', ')}`);
  }
  const brand = brandValue as Brand;

  if (!Array.isArray(raw.palette) || raw.palette.length === 0) {
    return badRequest('palette must be a non-empty array');
  }
  if (raw.palette.length > 256) {
    return badRequest('palette must not contain more than 256 colors');
  }

  const palette: CleanPaletteEntry[] = [];
  for (let i = 0; i < raw.palette.length; i++) {
    const entry = raw.palette[i] as IncomingPaletteEntry;
    if (!entry || typeof entry !== 'object') {
      return badRequest(`palette[${i}] must be an object`);
    }
    const rgb = typeof entry.hex === 'string' ? parseHex(entry.hex) : null;
    if (!rgb) {
      return badRequest(`palette[${i}].hex is not a valid #RRGGBB color`);
    }
    const rawCode = typeof entry.code === 'string' ? entry.code : '';
    const code = toAscii(rawCode).trim().slice(0, 8) || `#${i + 1}`;
    palette.push({
      index: i,
      hex: normalizeHex(rgb),
      rgb,
      code,
      count: 0,
      ratio: 0,
    });
  }

  const expected = cols * rows;
  if (!Array.isArray(raw.cells) || raw.cells.length !== expected) {
    return badRequest(`cells length must equal cols * rows (${expected})`);
  }

  const cells = new Int16Array(expected);
  for (let i = 0; i < expected; i++) {
    const value = Number(raw.cells[i]);
    if (!Number.isInteger(value) || value < -1 || value > palette.length - 1) {
      return badRequest(`cells[${i}] must be an integer in [-1, ${palette.length - 1}]`);
    }
    cells[i] = value;
  }

  // 计数以 cells 为唯一真实来源（请求里的 count 只作冗余提示，避免 UI/PDF 对不上）
  let totalBeads = 0;
  let blankCells = 0;
  for (let i = 0; i < expected; i++) {
    const value = cells[i];
    if (value < 0) {
      blankCells++;
    } else {
      palette[value].count++;
      totalBeads++;
    }
  }
  for (const entry of palette) {
    entry.ratio = totalBeads > 0 ? entry.count / totalBeads : 0;
  }

  const generatedAtRaw = typeof raw.generatedAt === 'string' ? raw.generatedAt : '';
  const generatedAt = Number.isNaN(new Date(generatedAtRaw).getTime())
    ? new Date().toISOString()
    : generatedAtRaw;

  return {
    cols,
    rows,
    brand,
    brandLabel: BRAND_ASCII[brand] ?? 'BRAND',
    cells,
    palette,
    totalBeads,
    blankCells,
    generatedAt,
  };
}

function normalizeHex(rgb: Rgb): string {
  const to2 = (v: number) => v.toString(16).padStart(2, '0');
  return `#${to2(rgb.r)}${to2(rgb.g)}${to2(rgb.b)}`.toUpperCase();
}

// ---------------------------------------------------------------------------
// jsPDF 小工具
// ---------------------------------------------------------------------------

type Doc = jsPDF;

function setFill(doc: Doc, c: RgbTuple): void {
  doc.setFillColor(c[0], c[1], c[2]);
}

function setDraw(doc: Doc, c: RgbTuple): void {
  doc.setDrawColor(c[0], c[1], c[2]);
}

function setInk(doc: Doc, c: RgbTuple): void {
  doc.setTextColor(c[0], c[1], c[2]);
}

function inkTuple(hex: '#231A11' | '#FFFDF6'): RgbTuple {
  return hex === '#231A11' ? [35, 26, 17] : [255, 253, 246];
}

function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'n/a';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())} UTC`;
}

function rule(
  doc: Doc,
  x1: number,
  y: number,
  x2: number,
  color: RgbTuple = RULE,
  width = 0.25,
): void {
  setDraw(doc, color);
  doc.setLineWidth(width);
  doc.line(x1, y, x2, y);
}

/** 页眉：左侧强调竖条 + 标题 + 副标题 */
function drawPageHeader(doc: Doc, title: string, subtitle: string, accent = true): void {
  if (accent) {
    setFill(doc, ACCENT);
    doc.rect(M, 13, 2.6, 13, 'F');
  }
  setInk(doc, INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(toAscii(title), M + 6, 21.5);
  setInk(doc, INK_SOFT);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text(toAscii(subtitle), M + 6, 27.5);
}

// ---------------------------------------------------------------------------
// 分页规划
// ---------------------------------------------------------------------------

interface TileSpec {
  tx: number;
  ty: number;
  colStart: number;
  rowStart: number;
  cols: number;
  rows: number;
}

interface PagePlan {
  tiles: TileSpec[];
  tilesX: number;
  tilesY: number;
  cell: number;
  /** 实际相邻块重叠列数（最后一个接缝可能更大，所以是下界） */
  overlapX: number;
  overlapY: number;
  /** 按 1:1（5 mm 豆）打印需要的页数；和 tiles.length 不同时说明被缩放了 */
  pagesAtTrueScale: number;
}

/** 图纸大到连最小单格都排不下时抛这个，POST 里转成 400 */
class PagePlanError extends Error {}

function tileCount(n: number, maxTile: number, overlap: number): number {
  if (n <= maxTile) return 1;
  return Math.max(1, Math.ceil((n - overlap) / (maxTile - overlap)));
}

function tileSpan(n: number, maxTile: number, overlap: number): number {
  const count = tileCount(n, maxTile, overlap);
  if (count === 1) return n;
  return Math.ceil((n + (count - 1) * overlap) / count);
}

/**
 * 起始位置 = i * (span - overlap)，保证相邻块**至少**重叠 overlap 格；
 * 最后一块夹到 n - span 避免越界（因此最后一个接缝的重叠可能更多）。
 */
function tileStarts(n: number, count: number, span: number, overlap: number): number[] {
  if (count === 1) return [0];
  const step = span - overlap;
  const starts: number[] = [];
  for (let i = 0; i < count; i++) {
    starts.push(Math.max(0, Math.min(n - span, i * step)));
  }
  starts[0] = 0;
  return starts;
}

/**
 * 给定"期望单格边长"，铺一套 tile。
 * 真正的 cell 由可用宽高反算（可能略大于期望值），但绝不会大于 MAX_CELL。
 */
function layoutAt(cols: number, rows: number, preferredCell: number): PagePlan {
  const maxCols = Math.max(1, Math.floor(AVAIL_W / preferredCell));
  const maxRows = Math.max(1, Math.floor(TILE_AREA_H / preferredCell));

  const countX = tileCount(cols, maxCols, OVERLAP);
  const countY = tileCount(rows, maxRows, OVERLAP);
  const spanX = tileSpan(cols, maxCols, OVERLAP);
  const spanY = tileSpan(rows, maxRows, OVERLAP);
  const startsX = tileStarts(cols, countX, spanX, OVERLAP);
  const startsY = tileStarts(rows, countY, spanY, OVERLAP);

  const cell = Math.min(AVAIL_W / spanX, TILE_AREA_H / spanY, MAX_CELL);

  // 实际重叠 = span - step；取所有接缝的最小值（最后一个接缝可能更宽）
  const overlapX = countX > 1 ? spanX - (startsX[1] - startsX[0]) : 0;
  const overlapY = countY > 1 ? spanY - (startsY[1] - startsY[0]) : 0;

  const tiles: TileSpec[] = [];
  for (let ty = 0; ty < countY; ty++) {
    for (let tx = 0; tx < countX; tx++) {
      tiles.push({
        tx,
        ty,
        colStart: startsX[tx],
        rowStart: startsY[ty],
        cols: spanX,
        rows: spanY,
      });
    }
  }

  return {
    tiles,
    tilesX: countX,
    tilesY: countY,
    cell,
    overlapX,
    overlapY,
    pagesAtTrueScale: countX * countY,
  };
}

/**
 * 分页规划。
 *
 * 1. 小图（整图一页且单格 >= MIN_SINGLE_CELL）：一页搞定，行为和以前完全一致。
 * 2. 其余：先按 TARGET_CELL 铺。页数 <= PAGE_TARGET 时**原样返回** —— 这保证
 *    120x120 及以下的老行为一个字节都不变（120x120 是 20 页）。
 * 3. 页数超标（最长边到 320 就会）：逐档降低期望单格，让每页容纳更多格，
 *    直到页数回落到 PAGE_TARGET 以内。320x270 落在 24 页 / 3.0mm 单格。
 * 4. 降到 MIN_TILE_CELL 仍然超过 MAX_PAGES：抛 PagePlanError -> 400。
 *    与其生成一份 100 多页、几十 MB 的 PDF，不如明确告诉用户换个网格。
 */
function planPages(cols: number, rows: number): PagePlan {
  const wholeCell = Math.min(AVAIL_W / cols, AVAIL_H / rows);

  if (wholeCell >= MIN_SINGLE_CELL) {
    // 小图：一页放下，单格再大也不超过 MAX_CELL
    const cell = Math.min(wholeCell, MAX_CELL);
    return {
      tiles: [{ tx: 0, ty: 0, colStart: 0, rowStart: 0, cols, rows }],
      tilesX: 1,
      tilesY: 1,
      cell,
      overlapX: 0,
      overlapY: 0,
      pagesAtTrueScale: 1,
    };
  }

  // 1:1 需要的页数（纯信息，给封面用）
  const trueScale = layoutAt(cols, rows, 5);

  let preferred = TARGET_CELL;
  let plan = layoutAt(cols, rows, preferred);

  while (plan.tiles.length > PAGE_TARGET && preferred > MIN_TILE_CELL) {
    preferred = Math.max(MIN_TILE_CELL, Math.round((preferred - 0.25) * 100) / 100);
    plan = layoutAt(cols, rows, preferred);
    if (preferred === MIN_TILE_CELL) break;
  }

  if (plan.tiles.length > MAX_PAGES) {
    throw new PagePlanError(
      `Pattern too large for PDF: ${cols}x${rows} needs more than ${MAX_PAGES} pages at ` +
        `minimum cell size. Try 200 grid or smaller, or export a PNG preview.`,
    );
  }

  return { ...plan, pagesAtTrueScale: trueScale.tiles.length };
}

// ---------------------------------------------------------------------------
// 每色标签规格（色号 / 图例序号），按 cellSize 反算字号
// ---------------------------------------------------------------------------

interface LabelSpec {
  text: string;
  fontPt: number;
  ink: RgbTuple;
}

function buildLabelSpecs(
  doc: Doc,
  palette: CleanPaletteEntry[],
  cell: number,
  forceIndexOnly: boolean,
): Array<LabelSpec | null> {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  const refWidths = palette.map((entry) => ({
    code: Math.max(0.1, doc.getTextWidth(toAscii(entry.code))),
    index: Math.max(0.1, doc.getTextWidth(String(entry.index + 1))),
  }));

  const heightCap = cell * PT_PER_MM * 0.56; // 字高不超过格高 56%
  // 左右各留 9% 的呼吸位：色号正好顶满格宽时，相邻两格的字母会视觉粘连
  const usableWidth = Math.max(0.4, cell - Math.max(0.8, cell * 0.18));

  const specs: Array<LabelSpec | null> = [];
  for (let i = 0; i < palette.length; i++) {
    const entry = palette[i];
    const ref = refWidths[i];
    const candidates: Array<{ text: string; widthAt10: number }> = forceIndexOnly
      ? [{ text: String(entry.index + 1), widthAt10: ref.index }]
      : [
          { text: toAscii(entry.code), widthAt10: ref.code },
          { text: String(entry.index + 1), widthAt10: ref.index },
        ];

    let chosen: LabelSpec | null = null;
    for (const candidate of candidates) {
      const fsByWidth = (usableWidth * 10) / candidate.widthAt10;
      const fs = Math.min(fsByWidth, heightCap);
      if (fs >= MIN_LABEL_PT) {
        chosen = {
          text: candidate.text,
          fontPt: Math.floor(fs * 10) / 10,
          ink: inkTuple(readableInkFor(entry.rgb)),
        };
        break;
      }
    }
    specs.push(chosen);
  }
  return specs;
}

// ---------------------------------------------------------------------------
// 图案页
// ---------------------------------------------------------------------------

function drawTileMiniMap(
  doc: Doc,
  plan: PagePlan,
  tile: TileSpec,
  rightX: number,
  topY: number,
): void {
  const size = plan.tilesX > 3 || plan.tilesY > 3 ? 3 : 4;
  const gap = 0.9;
  const cols = plan.tilesX;
  const rows = plan.tilesY;
  const totalW = cols * size + (cols - 1) * gap;
  const totalH = rows * size + (rows - 1) * gap;
  const x0 = rightX - totalW;
  const y0 = topY + (14 - totalH) / 2;

  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const isCurrent = tx === tile.tx && ty === tile.ty;
      const x = x0 + tx * (size + gap);
      const y = y0 + ty * (size + gap);
      setFill(doc, isCurrent ? INK : PAPER_TINT);
      doc.rect(x, y, size, size, 'F');
      setDraw(doc, isCurrent ? INK : RULE);
      doc.setLineWidth(0.15);
      doc.rect(x, y, size, size, 'S');
    }
  }

  setInk(doc, INK_SOFT);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(5.5);
  doc.text(`${plan.tiles.length} TILES`, rightX, y0 + totalH + 3.4, { align: 'right' });
}

function drawPatternTile(
  doc: Doc,
  req: CleanRequest,
  plan: PagePlan,
  tile: TileSpec,
  tileIndex: number,
  labelSpecs: Array<LabelSpec | null>,
  forceIndexOnly: boolean,
): void {
  const { cols, cells, palette } = req;
  const tileTotal = plan.tiles.length;
  const cell = plan.cell;
  const gridW = tile.cols * cell;
  const gridH = tile.rows * cell;

  const gx = GRID_LEFT + Math.max(0, (AVAIL_W - gridW) / 2);
  const gy = GRID_TOP;

  // ---- 页眉 ----
  const colA = tile.colStart + 1;
  const colB = tile.colStart + tile.cols;
  const rowA = tile.rowStart + 1;
  const rowB = tile.rowStart + tile.rows;

  drawPageHeader(
    doc,
    tileTotal > 1 ? `PATTERN - TILE ${tileIndex + 1} / ${tileTotal}` : 'PATTERN',
    `Cols ${colA}-${colB}  |  Rows ${rowA}-${rowB}  |  Grid ${cols} x ${req.rows}  |  Brand ${req.brandLabel}`,
  );

  if (tileTotal > 1) {
    drawTileMiniMap(doc, plan, tile, PAGE_W - M, 13);
  }

  // 副标题下方只有一行空位（再下面就是 COLS / ROWS 轴标题），所以两条提示
  // 只能二选一：大图先讲"怎么读这一页"，小图讲"这几页怎么拼"。
  const blockLabels = cell < PER_CELL_LABEL_MIN_MM;
  if (blockLabels) {
    setInk(doc, ACCENT);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.8);
    doc.text(
      forceIndexOnly
        ? 'One number per color block = COLOR LEGEND index. Dashed line = overlap.'
        : 'One code per color block. Use the Col / Row rulers for exact position.',
      GRID_LEFT,
      gy - 9.6,
    );
  } else if (tileTotal > 1) {
    setInk(doc, INK_SOFT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.8);
    doc.text('Overlapping tiles - see ASSEMBLY GUIDE at the bottom of this sheet.', GRID_LEFT, gy - 9.6);
  }

  // ---- 单元格填充（同色横向 run 合并 + 按颜色分组） ----
  interface Run {
    x: number;
    y: number;
    w: number;
    h: number;
  }
  const runsByColor = new Map<number, Run[]>();
  const blankRuns: Run[] = [];

  for (let lr = 0; lr < tile.rows; lr++) {
    const rowBase = (tile.rowStart + lr) * cols;
    let runStart = 0;
    let runIdx = cells[rowBase + tile.colStart];

    for (let lc = 1; lc <= tile.cols; lc++) {
      const nextIdx = lc < tile.cols ? cells[rowBase + tile.colStart + lc] : -2;
      if (nextIdx !== runIdx) {
        const run = {
          x: gx + runStart * cell,
          y: gy + lr * cell,
          w: (lc - runStart) * cell,
          h: cell,
        };
        if (runIdx >= 0) {
          let list = runsByColor.get(runIdx);
          if (!list) {
            list = [];
            runsByColor.set(runIdx, list);
          }
          list.push(run);
        } else if (runIdx < 0) {
          blankRuns.push(run);
        }
        runStart = lc;
        runIdx = nextIdx;
      }
    }
  }

  // 空白格先铺白底，便于和"浅色豆子"区分（空白格中心还会点一个小圆点）
  if (blankRuns.length > 0) {
    setFill(doc, WHITE);
    for (const run of blankRuns) doc.rect(run.x, run.y, run.w, run.h, 'F');
  }

  // 按调色板顺序画，减少 setFillColor 切换次数
  for (const entry of palette) {
    const runs = runsByColor.get(entry.index);
    if (!runs || runs.length === 0) continue;
    setFill(doc, [entry.rgb.r, entry.rgb.g, entry.rgb.b]);
    for (const run of runs) {
      doc.rect(run.x, run.y, run.w, run.h, 'F');
    }
  }

  // ---- 三级网格线：先细线，再 5，再 10（后者盖住前者） ----
  const boundaryWeight = (globalIndex: number): number => {
    if (globalIndex % RULER_MAJOR === 0) return 3;
    if (globalIndex % RULER_MINOR === 0) return 2;
    return 1;
  };

  // 线宽跟着 cell 缩放：0.5mm 的粗线在 0.6mm 的格子上会糊死整张图
  const lineScale = Math.max(0.14, Math.min(1, cell / 3.0));

  for (let pass = 1; pass <= 3; pass++) {
    if (pass === 1) {
      setDraw(doc, GRID_THIN);
      doc.setLineWidth(LINE_THIN * lineScale);
    } else if (pass === 2) {
      setDraw(doc, GRID_MID);
      doc.setLineWidth(LINE_MID * lineScale);
    } else {
      setDraw(doc, GRID_BOLD);
      doc.setLineWidth(LINE_BOLD * lineScale);
    }

    for (let lc = 0; lc <= tile.cols; lc++) {
      if (boundaryWeight(tile.colStart + lc) !== pass) continue;
      const x = gx + lc * cell;
      doc.line(x, gy, x, gy + gridH);
    }
    for (let lr = 0; lr <= tile.rows; lr++) {
      if (boundaryWeight(tile.rowStart + lr) !== pass) continue;
      const y = gy + lr * cell;
      doc.line(gx, y, gx + gridW, y);
    }
  }

  // 外框
  setDraw(doc, GRID_BOLD);
  doc.setLineWidth(Math.max(0.2, 0.55 * lineScale));
  doc.rect(gx, gy, gridW, gridH, 'S');

  // ---- 空白格中心点（"这里不放豆子"） ----
  if (blankRuns.length > 0) {
    setFill(doc, INK_FAINT);
    // 点半径不能超过格子的 1/4，否则细格子里会连成一片点阵
    const dotR = Math.min(cell * 0.25, Math.max(0.22, cell * 0.045));
    for (const run of blankRuns) {
      const count = Math.max(1, Math.round(run.w / cell));
      for (let k = 0; k < count; k++) {
        const cx = run.x + (k + 0.5) * cell;
        const cy = run.y + cell / 2;
        doc.circle(cx, cy, dotR, 'F');
      }
    }
  }

  // ---- 标尺带底色 ----
  setFill(doc, PAPER_TINT);
  doc.rect(gx, gy - TOP_RULER_H + 0.8, gridW, TOP_RULER_H - 0.8, 'F');
  doc.rect(gx - LEFT_RULER_W + 0.8, gy, LEFT_RULER_W - 0.8, gridH, 'F');

  // ---- 行列标尺（全局 1-based 边界号：刻度画在格线上，数字骑在刻度线上） ----
  // 约定：边界 g 表示"这条线左侧/上方共有 g 列/行"（g=10 的粗线左边正好是第 1-10 列），
  // 这样跨页时用户可以直接按数字对位，且数字与 10 格粗线严格重合。
  //
  // 稠密网格（cell 很小）时 5 格间距只有 2~3mm，6pt 的数字会互相压住，
  // 所以刻度步长自适应：保证相邻两个刻度至少留出 STEP_MIN_MM 的横向空间，
  // 步长只允许是 5 的倍数（5 -> 10 -> 20 -> 50），保证仍与 10 格粗线对齐。
  const rulerStep = (() => {
    const majorPt = 6.6;
    const minorPt = 5.8;
    const needMajor = (majorPt / PT_PER_MM) * 2.6; // "320" 这种 3 位数的最宽估计
    const needMinor = (minorPt / PT_PER_MM) * 1.7;
    for (const step of [5, 10, 20, 50]) {
      const gapMm = step * cell;
      if (gapMm >= (step % 10 === 0 ? needMajor : needMinor)) return step;
    }
    return 50;
  })();
  const rulerMajor = rulerStep * (rulerStep % 10 === 0 ? 1 : 2);

  for (let lc = 0; lc <= tile.cols; lc++) {
    const boundary = tile.colStart + lc; // 0-based 边界序号 = 左侧列数
    if (boundary === 0 || boundary % rulerStep !== 0) continue;
    const isMajor = boundary % rulerMajor === 0;
    const x = gx + lc * cell;
    // 刻度只画在标尺带内（不侵入格子，避免压住色号文字）
    setDraw(doc, isMajor ? GRID_BOLD : GRID_MID);
    doc.setLineWidth(isMajor ? 0.34 : 0.2);
    doc.line(x, gy - 2.6, x, gy - 0.15);
    setInk(doc, isMajor ? INK : INK_SOFT);
    doc.setFont('helvetica', isMajor ? 'bold' : 'normal');
    doc.setFontSize(isMajor ? 6.6 : 5.8);
    const align = lc === 0 ? 'left' : lc === tile.cols ? 'right' : 'center';
    const tx = lc === 0 ? x + 0.7 : lc === tile.cols ? x - 0.7 : x;
    doc.text(String(boundary), tx, gy - 3.0, { align, baseline: 'bottom' });
  }
  for (let lr = 0; lr <= tile.rows; lr++) {
    const boundary = tile.rowStart + lr;
    if (boundary === 0 || boundary % rulerStep !== 0) continue;
    const isMajor = boundary % rulerMajor === 0;
    const y = gy + lr * cell;
    setDraw(doc, isMajor ? GRID_BOLD : GRID_MID);
    doc.setLineWidth(isMajor ? 0.34 : 0.2);
    doc.line(gx - 2.8, y, gx - 0.15, y);
    setInk(doc, isMajor ? INK : INK_SOFT);
    doc.setFont('helvetica', isMajor ? 'bold' : 'normal');
    doc.setFontSize(isMajor ? 6.6 : 5.8);
    let baseline: 'top' | 'bottom' | 'middle' = 'middle';
    if (lr === 0) baseline = 'top';
    else if (lr === tile.rows) baseline = 'bottom';
    doc.text(String(boundary), gx - 3.4, y, { align: 'right', baseline });
  }

  // 标尺轴标题：贴在两条标尺带外侧的页眉空档，不压数字
  setInk(doc, INK_FAINT);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(5.2);
  doc.text('COLS', gx + gridW, gy - TOP_RULER_H - 1.0, { align: 'right' });
  doc.text('ROWS', gx - 0.8, gy - TOP_RULER_H - 1.0, { align: 'right' });

  // ---- 色号标注 ----
  //
  // 两种模式，按单格实际尺寸切换：
  //
  // A. 常规网格（cell >= MIN_TEXT_CELL_MM）：**逐格**印色号，字号按格宽反算，
  //    这是最精确的读图方式（50x50 / 100x100 走这条路）。
  // B. 稠密网格（cell < MIN_TEXT_CELL_MM，"大色块"模式）：一格只有 0.5~1.5mm，
  //    3.2pt 的字比格子还宽，逐格硬印只会糊成墨块。改为**按块标注**——把
  //    图纸切成约 13mm 见方的标注块，每块只挑"绝对主导色"印一个色号：
  //    大色块 = 一个标记，看得清、找得到；细碎区域本来就无法靠纸面标注，
  //    交给单独的 PATTERN OVERVIEW 总览页 + COLOR LEGEND。
  const perCellLabels = cell >= PER_CELL_LABEL_MIN_MM;

  interface TextBucket {
    fontPt: number;
    ink: RgbTuple;
    items: Array<{ text: string; x: number; y: number }>;
  }
  const buckets = new Map<string, TextBucket>();
  const pushLabel = (spec: LabelSpec, x: number, y: number): void => {
    const key = `${spec.fontPt}|${spec.ink.join(',')}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { fontPt: spec.fontPt, ink: spec.ink, items: [] };
      buckets.set(key, bucket);
    }
    bucket.items.push({ text: spec.text, x, y });
  };

  if (perCellLabels) {
    for (let lr = 0; lr < tile.rows; lr++) {
      const rowBase = (tile.rowStart + lr) * cols;
      for (let lc = 0; lc < tile.cols; lc++) {
        const idx = cells[rowBase + tile.colStart + lc];
        if (idx < 0) continue;
        // spec 为 null 时兜底印图例序号：绝不允许"色号印不出来"
        const spec = labelSpecs[idx] ?? {
          text: String(idx + 1),
          fontPt: MIN_LABEL_PT,
          ink: inkTuple(readableInkFor(palette[idx].rgb)),
        };
        pushLabel(spec, gx + (lc + 0.5) * cell, gy + (lr + 0.5) * cell);
      }
    }
  } else {
    // 大色块模式：标注块边长按"纸面约 13mm"取整数格，块内主导色占比够高才标
    const blockCells = Math.max(3, Math.min(14, Math.round(BLOCK_LABEL_MM / cell)));
    const blockMm = blockCells * cell;
    const blockSpecs = buildLabelSpecs(doc, palette, blockMm, forceIndexOnly);

    for (let br = 0; br < tile.rows; br += blockCells) {
      for (let bc = 0; bc < tile.cols; bc += blockCells) {
        const rEnd = Math.min(tile.rows, br + blockCells);
        const cEnd = Math.min(tile.cols, bc + blockCells);
        const tally = new Map<number, number>();
        let filled = 0;
        for (let lr = br; lr < rEnd; lr++) {
          const rowBase = (tile.rowStart + lr) * cols;
          for (let lc = bc; lc < cEnd; lc++) {
            const idx = cells[rowBase + tile.colStart + lc];
            if (idx < 0) continue;
            filled++;
            tally.set(idx, (tally.get(idx) ?? 0) + 1);
          }
        }
        const area = (rEnd - br) * (cEnd - bc);
        if (filled < area * 0.55) continue; // 空白太多的块不标，避免"标注里全是空白"
        let bestIdx = -1;
        let bestCount = 0;
        for (const [idx, count] of tally) {
          if (count > bestCount) {
            bestCount = count;
            bestIdx = idx;
          }
        }
        if (bestIdx < 0 || bestCount < filled * 0.7) continue; // 不够"大色块"，不标

        const baseSpec = blockSpecs[bestIdx] ?? {
          text: String(bestIdx + 1),
          fontPt: BLOCK_MIN_LABEL_PT,
          ink: inkTuple(readableInkFor(palette[bestIdx].rgb)),
        };
        // 按块边长算出来的字号会到 20pt+，在密网格上比 5 个格子还宽，
        // 看着像整页大字报。封顶 10pt：仍然是大色块里清晰可读的标记，
        // 但不会盖过"格子本身"这个主体信息。
        pushLabel(
          { ...baseSpec, fontPt: Math.min(baseSpec.fontPt, BLOCK_MAX_LABEL_PT) },
          gx + (bc + (cEnd - bc) / 2) * cell,
          gy + (br + (rEnd - br) / 2) * cell,
        );
      }
    }
  }

  for (const bucket of buckets.values()) {
    setInk(doc, bucket.ink);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(bucket.fontPt);
    for (const item of bucket.items) {
      doc.text(item.text, item.x, item.y, { align: 'center', baseline: 'middle' });
    }
  }

  // ---- 重叠区提示：非末块在重叠带画虚线 ----
  if (tileTotal > 1) {
    doc.setLineDashPattern([1.1, 0.9], 0);
    setDraw(doc, ACCENT);
    doc.setLineWidth(0.28);
    if (tile.tx !== plan.tilesX - 1) {
      const x = gx + (tile.cols - plan.overlapX) * cell;
      doc.line(x, gy, x, gy + gridH);
    }
    if (tile.ty !== plan.tilesY - 1) {
      const y = gy + (tile.rows - plan.overlapY) * cell;
      doc.line(gx, y, gx + gridW, y);
    }
    doc.setLineDashPattern([], 0);
  }

  // ---- 页面底部：左侧本页色号、右侧拼接指引 ----
  const used = new Set<number>();
  for (let lr = 0; lr < tile.rows; lr++) {
    const rowBase = (tile.rowStart + lr) * cols;
    for (let lc = 0; lc < tile.cols; lc++) {
      const idx = cells[rowBase + tile.colStart + lc];
      if (idx >= 0) used.add(idx);
    }
  }

  const bottomSpace = PAGE_H - BOTTOM_RESERVE - (gy + gridH);
  if (bottomSpace >= 24) {
    const list = palette.filter((entry) => entry.count > 0 && used.has(entry.index));

    const startY = gy + gridH + 8;
    setInk(doc, INK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.6);
    doc.text('COLORS ON THIS TILE', GRID_LEFT, startY);
    setInk(doc, INK_FAINT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(5.8);
    doc.text(`${list.length} of ${req.palette.filter((e) => e.count > 0).length} colors`, GRID_LEFT + 34, startY);

    // 底部左侧区块：只占 ASSEMBLY GUIDE 左边的宽度，绝不越界压到右侧文字
    const badgeX = 116;
    const chipsRight = badgeX - 5;
    const chipsAvailW = chipsRight - GRID_LEFT;
    const chipsAvailH = bottomSpace - 12;

    // 自适应：先按行算，再按列收窄 chip 宽度；颜色多时字号同步缩小
    let chipH = 4.6;
    let rowStep = chipH + 1.6;
    let maxRows = Math.max(1, Math.floor(chipsAvailH / rowStep));
    let chipW = 22;
    let chipFs = 6.2;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const colsNeeded = Math.max(1, Math.ceil(list.length / maxRows));
      const neededW = colsNeeded * chipW;
      if (neededW <= chipsAvailW) break;
      // 收窄单个 chip，行高不变；仍不够就减小行高多塞几行
      chipW = Math.max(14, chipsAvailW / colsNeeded);
      chipFs = Math.max(5.2, Math.min(6.2, chipW * 0.28));
      if (chipW === 14 && attempt >= 1) {
        chipH = Math.max(3.4, chipH - 0.4);
        rowStep = chipH + 1.2;
        maxRows = Math.max(1, Math.floor(chipsAvailH / rowStep));
      }
    }

    list.forEach((entry, i) => {
      const col = Math.floor(i / maxRows);
      const row = i % maxRows;
      const cx = GRID_LEFT + col * chipW;
      const cy = startY + 3.4 + row * rowStep;
      // 双重保险：横向或纵向越界就停，宁可少印也不许压到别的区块
      if (cx + chipW > chipsRight + 0.5) return;
      if (cy + chipH > PAGE_H - BOTTOM_RESERVE) return;
      setFill(doc, [entry.rgb.r, entry.rgb.g, entry.rgb.b]);
      doc.rect(cx, cy, chipH, chipH, 'F');
      setDraw(doc, RULE);
      doc.setLineWidth(0.15);
      doc.rect(cx, cy, chipH, chipH, 'S');
      setInk(doc, INK);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(chipFs);
      doc.text(toAscii(entry.code), cx + chipH + 1.0, cy + chipH * 0.68);
    });

    // 右侧拼接指引：相邻块编号（行优先顺序）
    const badgeY = startY;
    setInk(doc, INK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.6);
    doc.text('ASSEMBLY GUIDE', badgeX, badgeY);

    const nbr = (tx: number, ty: number) =>
      ty * plan.tilesX + tx + 1 >= 1 &&
      tx >= 0 &&
      ty >= 0 &&
      tx < plan.tilesX &&
      ty < plan.tilesY
        ? String(ty * plan.tilesX + tx + 1)
        : '-';

    const guide: Array<[string, string]> = [
      ['Above', nbr(tile.tx, tile.ty - 1)],
      ['Below', nbr(tile.tx, tile.ty + 1)],
      ['Left', nbr(tile.tx - 1, tile.ty)],
      ['Right', nbr(tile.tx + 1, tile.ty)],
    ];

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.6);
    guide.forEach(([label, value], i) => {
      const gyy = badgeY + 5 + i * 4.6;
      setInk(doc, INK_SOFT);
      doc.text(`${label}:`, badgeX, gyy);
      setInk(doc, INK);
      doc.setFont('helvetica', 'bold');
      doc.text(value === '-' ? 'edge' : `Tile ${value}`, badgeX + 12, gyy);
      doc.setFont('helvetica', 'normal');
    });

    // 注记：从下往上排，保证最后一行的基线始终在页脚之上，绝不压页脚
    const notes: string[] = ['Count cells from the bold 10-lines.'];
    if (tileTotal > 1) {
      notes.unshift(
        `Neighbours share at least ${plan.overlapX} cols / ${plan.overlapY} rows.`,
      );
    }
    notes.unshift('Dashed line = overlapping strip.');

    const noteFs = 5.6;
    const noteStep = 3.6;
    const noteLimit = PAGE_H - BOTTOM_RESERVE - 1.5;
    let noteY = Math.min(
      badgeY + 5 + guide.length * 4.6 + noteStep,
      noteLimit - (notes.length - 1) * noteStep,
    );

    setInk(doc, INK_FAINT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(noteFs);
    for (const note of notes) {
      if (noteY > noteLimit) break;
      doc.text(note, badgeX, noteY);
      noteY += noteStep;
    }
  }
}

// ---------------------------------------------------------------------------
// 整图总览页
// ---------------------------------------------------------------------------

/**
 * 密集网格（cell 小于 MIN_TEXT_CELL_MM）时，"每格一个色号"在纸面上不成立，
 * 于是补一页 **PATTERN OVERVIEW**：
 *
 * - 整张图案按 tile 分区画成一张概览图（每个 tile 用细框 + 编号标出），
 *   用户先在这一页看清"哪块是大面积北色、哪块是背景"，再去各 tile 页施工；
 * - 图纸页会画虚线框 + 编号，与这一页一一对应；
 * - 每个图例色也给一个小色块 + 序号，方便对照。
 *
 * 只有需要拆页的大图才画这一页（小图本身就能一页看清，不需要）。
 */
function drawPatternOverview(doc: Doc, req: CleanRequest, plan: PagePlan): void {
  const { cols, rows, cells, palette } = req;

  drawPageHeader(
    doc,
    'PATTERN OVERVIEW',
    `Grid ${cols} x ${rows}  |  Brand ${req.brandLabel}  |  ${plan.tiles.length} tiles  |  overview only - build from the tile pages`,
  );

  // 布局：上半张概览图，下半张"色号索引 + 各 tile 行列范围表"。
  // 宽幅图案（320x270）按宽度铺满后高度有富余，正好用来放这两块内容，
  // 否则一页会空掉四分之一。
  const INFO_BLOCK_H = 52;
  const top = GRID_TOP - 2;
  const availW = PAGE_W - 2 * M;
  const availH = PAGE_H - top - BOTTOM_RESERVE - INFO_BLOCK_H;
  const scale = Math.min(availW / cols, availH / rows);
  const mapW = cols * scale;
  const mapH = rows * scale;
  const mx = M + (availW - mapW) / 2;
  // 图贴顶排：宽幅图案受宽度约束时高度必然有富余，那份空白交给下方索引区
  // 用自适应行高吃掉，而不是在页眉和图之间留一条 15mm 的沟。
  const my = top + 1;

  // 图案本体：逐行同色 run 合并后一次性填充
  for (let r = 0; r < rows; r++) {
    const rowBase = r * cols;
    let runStart = 0;
    let runIdx = cells[rowBase];
    for (let c = 1; c <= cols; c++) {
      const nextIdx = c < cols ? cells[rowBase + c] : -2;
      if (nextIdx !== runIdx) {
        if (runIdx >= 0) {
          const entry = palette[runIdx];
          if (entry) {
            setFill(doc, [entry.rgb.r, entry.rgb.g, entry.rgb.b]);
            doc.rect(mx + runStart * scale, my + r * scale, (c - runStart) * scale, scale, 'F');
          }
        }
        runStart = c;
        runIdx = nextIdx;
      }
    }
  }

  // tile 分区虚线 + 编号，直接对上后面的图纸页
  doc.setLineDashPattern([1.4, 1.0], 0);
  plan.tiles.forEach((tile, index) => {
    const tx = mx + tile.colStart * scale;
    const ty = my + tile.rowStart * scale;
    const tw = tile.cols * scale;
    const th = tile.rows * scale;
    setDraw(doc, WHITE);
    doc.setLineWidth(0.7);
    doc.rect(tx, ty, tw, th, 'S');
    setDraw(doc, INK);
    doc.setLineWidth(0.25);
    doc.rect(tx, ty, tw, th, 'S');

    // 编号贴左上角，白底黑字保证在任何底色上都读得出来
    const label = String(index + 1);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.4);
    const lw = Math.max(doc.getTextWidth(label) + 1.4, 4.2);
    setFill(doc, WHITE);
    doc.rect(tx + 0.5, ty + 0.5, lw, 3.6, 'F');
    setInk(doc, INK);
    doc.text(label, tx + 0.5 + lw / 2, ty + 0.5 + 2.6, { align: 'center' });
  });
  doc.setLineDashPattern([], 0);

  // ---- 图下方信息区 ----
  let y = my + mapH + 7;

  setInk(doc, INK_SOFT);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.8);
  const notes = [
    'Overview only - the numbered tiles below are what you build from. Each tile page reprints',
    'that area at a readable scale with global Cols / Rows rulers and one code per color block.',
  ];
  for (const note of notes) {
    if (y > PAGE_H - BOTTOM_RESERVE - 2) break;
    doc.text(note, M, y);
    y += 3.6;
  }

  // 左半：色号索引（带图例序号 + 色号 + 颗数）
  rule(doc, M, y + 1.4, PAGE_W - M, RULE, 0.3);
  y += 6;

  const used = palette.filter((entry) => entry.count > 0);
  const leftW = 96;
  const midX = M + leftW + 8;

  setInk(doc, INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.0);
  doc.text('COLOR INDEX', M, y);
  setInk(doc, INK_FAINT);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(5.6);
  doc.text('numbers match the legend page', M + 21, y);

  setInk(doc, INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.0);
  doc.text('TILE INDEX', midX, y);

  const cy = y + 5.4;
  const chipH = 3.0;
  const stepX = 31.5;
  const perRow = Math.max(1, Math.floor(leftW / stepX));
  // 行高自适应：把图下方剩余的高度摊给索引行，页面下半部分才不会空着
  const indexRows = Math.max(
    Math.ceil(used.length / perRow),
    Math.ceil(plan.tiles.length / Math.ceil(plan.tiles.length > 12 ? 3 : 2)),
  );
  const spare = PAGE_H - BOTTOM_RESERVE - 2 - cy;
  const rowStep = Math.max(3.4, Math.min(6.4, spare / Math.max(1, indexRows)));
  used.forEach((entry, i) => {
    const cx = M + (i % perRow) * stepX;
    const rowY = cy + Math.floor(i / perRow) * rowStep;
    if (rowY > PAGE_H - BOTTOM_RESERVE - 1) return;
    setFill(doc, [entry.rgb.r, entry.rgb.g, entry.rgb.b]);
    doc.rect(cx, rowY - 2.4, chipH, chipH, 'F');
    setDraw(doc, RULE);
    doc.setLineWidth(0.12);
    doc.rect(cx, rowY - 2.4, chipH, chipH, 'S');
    setInk(doc, INK_SOFT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(5.4);
    doc.text(`${entry.index + 1}`, cx + chipH + 0.8, rowY);
    setInk(doc, INK);
    doc.setFont('helvetica', 'bold');
    doc.text(toAscii(entry.code), cx + chipH + 4.2, rowY);
    setInk(doc, INK_FAINT);
    doc.setFont('helvetica', 'normal');
    doc.text(`x${entry.count}`, cx + stepX - 1.6, rowY, { align: 'right' });
  });

  // 右半：各 tile 的全局行列范围，施工时按它挑纸
  const tileCols = plan.tiles.length > 12 ? 3 : 2;
  const tileColW = (PAGE_W - M - midX) / tileCols;
  plan.tiles.forEach((tile, index) => {
    const col = Math.floor(index / Math.ceil(plan.tiles.length / tileCols));
    const row = index % Math.ceil(plan.tiles.length / tileCols);
    const tx = midX + col * tileColW;
    const ty = cy + row * rowStep;
    if (ty > PAGE_H - BOTTOM_RESERVE - 1) return;
    setInk(doc, INK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(5.4);
    doc.text(`${index + 1}`, tx, ty);
    setInk(doc, INK_SOFT);
    doc.setFont('helvetica', 'normal');
    doc.text(
      `C${tile.colStart + 1}-${tile.colStart + tile.cols} R${tile.rowStart + 1}-${tile.rowStart + tile.rows}`,
      tx + 4.6,
      ty,
    );
  });
}

// ---------------------------------------------------------------------------
// 封面
// ---------------------------------------------------------------------------

/**
 * 封面右侧"一览"面板：把大块统计信息竖排，填掉预览旁的空档。
 * 内容刻意包含"怎么买豆/怎么看图纸"最关键的几个数。
 */
function drawCoverGlance(
  doc: Doc,
  req: CleanRequest,
  plan: PagePlan,
  x: number,
  top: number,
  width: number,
): void {
  const { cols, rows, palette, totalBeads, blankCells } = req;
  const used = palette.filter((entry) => entry.count > 0);
  const buyTotal = used.reduce((sum, entry) => sum + Math.ceil((entry.count * 1.1) / 10) * 10, 0);
  const heaviest = [...used].sort((a, b) => b.count - a.count).slice(0, 3);

  setInk(doc, INK_SOFT);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.text('AT A GLANCE', x, top - 5);

  setDraw(doc, RULE);
  doc.setLineWidth(0.3);
  doc.rect(x, top, width, 82, 'S');

  const lines: Array<[string, string]> = [
    ['Tiles to print', String(plan.tiles.length)],
    ['Cell size on paper', `${plan.cell.toFixed(1)} mm`],
    ['Cell size (px @300dpi)', `${Math.round((plan.cell / 25.4) * 300)} px`],
    ['Grid', `${cols} x ${rows}`],
    ['Beads needed', String(totalBeads)],
    ['Buy (with 10% buffer)', String(buyTotal)],
    ['Blank cells', String(blankCells)],
    ['Colors', String(used.length)],
  ];

  let y = top + 6.5;
  for (const [label, value] of lines) {
    setInk(doc, INK_FAINT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.2);
    doc.text(label, x + 3, y);
    setInk(doc, INK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.4);
    doc.text(value, x + width - 3, y, { align: 'right' });
    setDraw(doc, PAPER_TINT);
    doc.setLineWidth(0.2);
    doc.line(x + 3, y + 1.8, x + width - 3, y + 1.8);
    y += 6.0;
  }

  // 用量最大的 3 个色：买豆时最影响手感/库存
  setInk(doc, INK_SOFT);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.2);
  doc.text('TOP 3 COLORS', x + 3, y + 2.2);

  let ty = y + 7;
  heaviest.forEach((entry) => {
    setFill(doc, [entry.rgb.r, entry.rgb.g, entry.rgb.b]);
    doc.rect(x + 3, ty - 2.6, 3.6, 3.6, 'F');
    setDraw(doc, RULE);
    doc.setLineWidth(0.12);
    doc.rect(x + 3, ty - 2.6, 3.6, 3.6, 'S');
    setInk(doc, INK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.4);
    doc.text(toAscii(entry.code), x + 8, ty);
    setInk(doc, INK_SOFT);
    doc.setFont('helvetica', 'normal');
    doc.text(`x${entry.count}`, x + width - 3, ty, { align: 'right' });
    ty += 4.6;
  });
}

function drawCover(doc: Doc, req: CleanRequest, plan: PagePlan): void {
  const { cols, rows, palette, totalBeads, blankCells, brandLabel } = req;
  const totalTiles = plan.tiles.length;

  // 顶部色带
  setFill(doc, ACCENT);
  doc.rect(0, 0, PAGE_W, 5, 'F');

  setInk(doc, INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(25);
  doc.text('PERLER BEAD PATTERN', M, 30);

  setInk(doc, INK_SOFT);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  doc.text('Printable pattern sheet - cover, tiled pattern, bill of materials', M, 38);

  rule(doc, M, 43.5, PAGE_W - M, RULE, 0.4);

  // 规格表
  const finishedW = ((cols * 5) / 10).toFixed(1);
  const finishedH = ((rows * 5) / 10).toFixed(1);
  const trueScalePages = plan.pagesAtTrueScale;
  const scaledDown = plan.cell < TRUE_SCALE_CELL;

  const rowsData: Array<[string, string]> = [
    ['Brand', brandLabel],
    ['Grid', `${cols} cols x ${rows} rows  (${cols * rows} cells)`],
    ['Colors used', `${palette.filter((entry) => entry.count > 0).length}`],
    ['Total beads', `${totalBeads}`],
    ['Blank cells', `${blankCells}  (no bead)`],
    ['Finished size', `approx. ${finishedW} x ${finishedH} cm  (5 mm beads)`],
    [
      'Pattern pages',
      totalTiles === 1
        ? '1 sheet (A4)'
        : `${totalTiles} tiles on A4, overlap ${OVERLAP} rows/cols`,
    ],
    ['Generated', formatUtc(req.generatedAt)],
  ];

  // 只有"纸面已经缩到非 1:1"的大图才追加这两行 —— 50x50 / 100x100
  // 的封面必须和验收时逐字节一致，不能因为新需求多出一行而整体位移。
  if (scaledDown) {
    rowsData.splice(rowsData.length - 1, 0, [
      'Pages at 100%',
      `${trueScalePages} sheets at 5.00 mm/cell (true 1:1) - not used`,
    ]);
  }

  // 宽值行缩字号适配：320 格的 "approx. 160.0 x 135.0 cm (5 mm beads)"
  // 比 50 格长一倍多，固定 9.5pt 会顶到页边。
  const valueX = M + 52;
  const valueMaxW = PAGE_W - M - valueX;

  let y = 55;
  rowsData.forEach(([label, value], i) => {
    if (i % 2 === 0) {
      setFill(doc, PAPER_TINT);
      doc.rect(M, y - 5.2, PAGE_W - 2 * M, 7.4, 'F');
    }
    setInk(doc, INK_SOFT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.text(label.toUpperCase(), M + 3, y);
    setInk(doc, INK);
    doc.setFont('helvetica', 'bold');
    const text = toAscii(value);
    let fs = 9.5;
    doc.setFontSize(fs);
    while (fs > 6.5 && doc.getTextWidth(text) > valueMaxW) {
      fs -= 0.25;
      doc.setFontSize(fs);
    }
    doc.text(text, valueX, y);
    y += 7.4;
  });

  // 缩放警告：纸面已经不是 1:1 时单独成条，避免被规格表淹掉
  if (scaledDown) {
    const bandTop = y - 2.4;
    const bandH = 13.5;
    setFill(doc, PAPER_TINT);
    doc.rect(M, bandTop, PAGE_W - 2 * M, bandH, 'F');
    setFill(doc, ACCENT);
    doc.rect(M, bandTop, 1.6, bandH, 'F');

    setInk(doc, ACCENT);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.6);
    doc.text('SCALE HINT', M + 4.4, bandTop + 4.6);

    setInk(doc, INK);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.6);
    const hint = toAscii(
      `This pattern needs ${totalTiles} pages at ${plan.cell.toFixed(2)} mm/cell. ` +
        `For a 1:1 build, print at 200% on 4 sheets or follow the digital view.`,
    );
    const wrapped = doc.splitTextToSize(hint, PAGE_W - 2 * M - 9) as string[];
    let hy = bandTop + 8.4;
    for (const part of wrapped.slice(0, 2)) {
      if (hy > bandTop + bandH - 1.2) break;
      doc.text(part, M + 4.4, hy);
      hy += 3.4;
    }
    y = bandTop + bandH + 4;
  }

  // 缩略预览 + 右侧"一览"面板：预览框按图aspect收缩，右侧栏填统计信息
  const previewTop = y + 4;
  const previewH = 70;
  const aspect = cols / rows;
  const maxPreviewW = 118;
  const previewW = Math.min(maxPreviewW, previewH * aspect);

  setInk(doc, INK_SOFT);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.text('PREVIEW', M, previewTop);

  const boxTop = previewTop + 3;
  setDraw(doc, RULE);
  doc.setLineWidth(0.3);
  doc.rect(M, boxTop, previewW, previewH, 'S');

  // 右侧一览面板
  drawCoverGlance(doc, req, plan, M + previewW + 7, boxTop, PAGE_W - M - (M + previewW + 7));

  const previewCell = Math.min((previewW - 6) / cols, (previewH - 6) / rows);
  const px0 = M + (previewW - cols * previewCell) / 2;
  const py0 = boxTop + (previewH - rows * previewCell) / 2;

  setFill(doc, WHITE);
  doc.rect(px0, py0, cols * previewCell, rows * previewCell, 'F');

  // 缩略图填充：按颜色分组 + 横向 run 合并
  const runsByColor = new Map<number, Array<{ x: number; y: number; w: number }>>();
  for (let r = 0; r < rows; r++) {
    let runStart = 0;
    let runIdx = req.cells[r * cols];
    for (let c = 1; c <= cols; c++) {
      const nextIdx = c < cols ? req.cells[r * cols + c] : -2;
      if (nextIdx !== runIdx) {
        if (runIdx >= 0) {
          let list = runsByColor.get(runIdx);
          if (!list) {
            list = [];
            runsByColor.set(runIdx, list);
          }
          list.push({
            x: px0 + runStart * previewCell,
            y: py0 + r * previewCell,
            w: (c - runStart) * previewCell,
          });
        }
        runStart = c;
        runIdx = nextIdx;
      }
    }
  }
  for (const entry of palette) {
    const runs = runsByColor.get(entry.index);
    if (!runs) continue;
    setFill(doc, [entry.rgb.r, entry.rgb.g, entry.rgb.b]);
    for (const run of runs) doc.rect(run.x, run.y, run.w, previewCell, 'F');
  }
  // 缩略图每 10 格辅助线
  setDraw(doc, GRID_THIN);
  doc.setLineWidth(0.1);
  for (let c = 0; c <= cols; c += 10) {
    const x = px0 + c * previewCell;
    doc.line(x, py0, x, py0 + rows * previewCell);
  }
  for (let r = 0; r <= rows; r += 10) {
    const yy = py0 + r * previewCell;
    doc.line(px0, yy, px0 + cols * previewCell, yy);
  }

  // 色号速查表
  const quickTop = boxTop + previewH + 9;
  setInk(doc, INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.text('COLOR QUICK REFERENCE', M, quickTop);
  setInk(doc, INK_FAINT);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.6);
  doc.text('Full quantities: Bill of Materials  |  Index numbers: Color Legend', M, quickTop + 4);

  const itemW = 29;
  const itemH = 5.0;
  const colsPerRow = Math.max(1, Math.floor((PAGE_W - 2 * M) / itemW));
  const rowsPerCol = Math.max(
    1,
    Math.floor((PAGE_H - BOTTOM_RESERVE - (quickTop + 8)) / itemH),
  );
  const capacity = colsPerRow * rowsPerCol;
  const shown = palette.slice(0, capacity);

  shown.forEach((entry, i) => {
    const cx = M + (i % colsPerRow) * itemW;
    const cy = quickTop + 8 + Math.floor(i / colsPerRow) * itemH;
    setInk(doc, INK_FAINT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6);
    doc.text(String(entry.index + 1), cx, cy + 2.6);
    setFill(doc, [entry.rgb.r, entry.rgb.g, entry.rgb.b]);
    doc.rect(cx + 4.6, cy + 0.3, 3.8, 3.8, 'F');
    setDraw(doc, RULE);
    doc.setLineWidth(0.12);
    doc.rect(cx + 4.6, cy + 0.3, 3.8, 3.8, 'S');
    setInk(doc, INK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.text(toAscii(entry.code), cx + 9.4, cy + 3.3);
  });

  if (palette.length > shown.length) {
    setInk(doc, INK_FAINT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.text(
      `+${palette.length - shown.length} more colors - see Color Legend page`,
      M,
      PAGE_H - BOTTOM_RESERVE - 2,
    );
  }

  // ---- 使用说明：把封面下半部分填满，并解释三条"看图纸"的关键规则 ----
  const usedRows = Math.ceil(shown.length / colsPerRow);
  const howTop = Math.max(quickTop + 8 + usedRows * itemH + 7, boxTop + previewH + 32);
  finishCoverWithHowTo(doc, howTop, totalTiles);
}

/** 封面收尾：使用说明 + 关键规则。独立成函数方便控制 Y 位置。 */
function finishCoverWithHowTo(doc: Doc, top: number, tileTotal: number): void {
  const limit = PAGE_H - BOTTOM_RESERVE - 4;
  if (top > limit - 14) return; // 空间不足就干脆不画，绝不压页脚

  rule(doc, M, top - 3.4, PAGE_W - M, RULE, 0.3);

  setInk(doc, INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.text('HOW TO USE THIS SHEET', M, top + 2);

  // 先用 getTextWidth 实测完整版需要多高：放得下就走完整版（小/中图封面靠它填满），
  // 放不下才退化成"每页一行"的紧凑版。不能用固定阈值猜——100x100 和 320x270
  // 的可用高度只差几毫米，猜错一边就会留下大片空白。
  const fullItems: Array<[string, ...string[]]> = [
    [
      '1. Print at 100% (no "fit to page") so 1 grid cell keeps the same size on paper.',
      'Use A4 portrait, single-sided. Check the ruler on the next pages matches your print.',
    ],
    [
      '2. Each pattern page covers one tile and prints its global Cols / Rows range.',
      'Neighbouring tiles share a 2-cell strip so you can line them up; the dashed line',
      'marks the overlap. Numbers on the rulers are global (1..N), never local to a page.',
    ],
    [
      '3. Cell text is the brand color code (e.g. A01). If a code does not fit, the cell',
      'prints a legend index number instead - look that number up on the Color Legend page.',
      'A small dot in a cell means "leave empty, no bead".',
    ],
  ];
  const fullW = PAGE_W - 2 * M - 4;
  let fullNeed = 8; // 标题占位
  for (const [, ...rest] of fullItems) {
    fullNeed += 4.2;
    for (const line of rest) {
      fullNeed += (doc.splitTextToSize(line, fullW) as string[]).length * 3.3;
    }
    fullNeed += 2;
  }

  if (top + fullNeed > limit) {
    const compact: string[] = [
      `Print at 100% on A4 portrait. ${tileTotal} pattern pages follow, each with global Col / Row rulers.`,
      'Codes or legend numbers are printed per color block on large patterns; dashed line = overlap strip.',
      'A dot in a cell means no bead. Quantities and buy amounts are on the last pages.',
    ];
    let cy = top + 7.5;
    setInk(doc, INK_SOFT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.8);
    for (const line of compact) {
      if (cy > limit) return;
      const wrapped = doc.splitTextToSize(line, PAGE_W - 2 * M - 2) as string[];
      for (const part of wrapped) {
        if (cy > limit) return;
        doc.text(part, M + 1, cy);
        cy += 3.3;
      }
    }
    return;
  }

  const textW = fullW;
  let y = top + 8;
  for (const [head, ...rest] of fullItems) {
    if (y > limit) return;
    setInk(doc, INK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.2);
    doc.text(head, M + 1, y);
    y += 4.2;
    setInk(doc, INK_SOFT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.8);
    for (const line of rest) {
      if (y > limit) return;
      const wrapped = doc.splitTextToSize(line, textW) as string[];
      for (const part of wrapped) {
        if (y > limit) return;
        doc.text(part, M + 4, y);
        y += 3.3;
      }
    }
    y += 2;
  }
}

// ---------------------------------------------------------------------------
// 用料清单
// ---------------------------------------------------------------------------

function drawMaterialsPages(doc: Doc, req: CleanRequest): void {
  const { palette, totalBeads, brandLabel, cols, rows } = req;

  const rowH = 6.4;
  const bodyTop = 50;
  const tableLeft = 12;
  const tableRight = PAGE_W - 12;
  const rowsPerPage = Math.floor((PAGE_H - 22 - bodyTop) / rowH);

  // 列 x 坐标
  const colNo = tableLeft + 2;
  const colSwatch = tableLeft + 13;
  const colCode = tableLeft + 24;
  const colHex = tableLeft + 56;
  const colBeads = tableLeft + 120; // 右对齐
  const colShare = tableLeft + 146; // 右对齐
  const colBuy = tableRight - 2; // 右对齐

  const buyFor = (count: number) => Math.ceil((count * 1.1) / 10) * 10;
  const totalBuy = palette.reduce((sum, entry) => sum + buyFor(entry.count), 0);
  const usedColors = palette.filter((entry) => entry.count > 0);

  const chunks: CleanPaletteEntry[][] = [];
  for (let i = 0; i < usedColors.length; i += rowsPerPage) {
    chunks.push(usedColors.slice(i, i + rowsPerPage));
  }
  if (chunks.length === 0) chunks.push([]);

  chunks.forEach((chunk, chunkIndex) => {
    if (chunkIndex > 0) doc.addPage();

    drawPageHeader(
      doc,
      chunkIndex === 0 ? 'BILL OF MATERIALS' : 'BILL OF MATERIALS (CONT.)',
      `Brand ${brandLabel}  |  Grid ${cols} x ${rows}  |  ${usedColors.length} colors  |  ${totalBeads} beads`,
    );

    // 表头
    setInk(doc, INK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.6);
    doc.text('NO.', colNo, bodyTop - 4);
    doc.text('COLOR', colSwatch, bodyTop - 4);
    doc.text('CODE', colCode, bodyTop - 4);
    doc.text('HEX', colHex, bodyTop - 4);
    doc.text('BEADS', colBeads, bodyTop - 4, { align: 'right' });
    doc.text('SHARE', colShare, bodyTop - 4, { align: 'right' });
    doc.text('BUY (pcs)', colBuy, bodyTop - 4, { align: 'right' });
    rule(doc, tableLeft, bodyTop - 2, tableRight, RULE, 0.35);

    chunk.forEach((entry, i) => {
      const y = bodyTop + i * rowH + 3.4;
      if (i % 2 === 0) {
        setFill(doc, PAPER_TINT);
        doc.rect(tableLeft, bodyTop + i * rowH, tableRight - tableLeft, rowH, 'F');
      }

      setInk(doc, INK_SOFT);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.2);
      doc.text(String(entry.index + 1), colNo, y);

      setFill(doc, [entry.rgb.r, entry.rgb.g, entry.rgb.b]);
      doc.rect(colSwatch, y - 3.6, 4.6, 4.6, 'F');
      setDraw(doc, RULE);
      doc.setLineWidth(0.12);
      doc.rect(colSwatch, y - 3.6, 4.6, 4.6, 'S');

      setInk(doc, INK);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.2);
      doc.text(toAscii(entry.code), colCode, y);

      setInk(doc, INK_SOFT);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.4);
      doc.text(entry.hex, colHex, y, { charSpace: 0.12 });

      setInk(doc, INK);
      doc.setFontSize(8);
      doc.text(String(entry.count), colBeads, y, { align: 'right' });
      doc.text(`${(entry.ratio * 100).toFixed(1)}%`, colShare, y, { align: 'right' });

      setInk(doc, ACCENT);
      doc.setFont('helvetica', 'bold');
      doc.text(String(buyFor(entry.count)), colBuy, y, { align: 'right' });
    });

    // 合计（只在最后一段）
    if (chunkIndex === chunks.length - 1) {
      const yTotal = bodyTop + chunk.length * rowH + 5;
      rule(doc, tableLeft, yTotal - 4, tableRight, INK, 0.5);
      setInk(doc, INK);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.text('TOTAL', colNo, yTotal);
      doc.text(String(usedColors.length), colCode, yTotal);
      doc.text(String(totalBeads), colBeads, yTotal, { align: 'right' });
      doc.text('100.0%', colShare, yTotal, { align: 'right' });
      doc.text(String(totalBuy), colBuy, yTotal, { align: 'right' });

      setInk(doc, INK_FAINT);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.8);
      doc.text(
        'BUY = beads + 10% buffer, rounded up to the next multiple of 10.',
        tableLeft,
        yTotal + 6,
      );
      doc.text(
        'BEADS = beads actually needed (no buffer). SHARE = portion of all beads.',
        tableLeft,
        yTotal + 10,
      );

      // 采购汇总卡片：把页面下半部分的空白变成能直接带去店里用的信息
      drawShoppingSummary(doc, req, yTotal + 16);
    }
  });
}

/**
 * 用料清单页尾的采购汇总：打印规格 / 拼装尺寸 / 分页数 / 建议收纳。
 * 目的是让这一页单独拿出去就能买豆，而不是只有一张表。
 */
function drawShoppingSummary(doc: Doc, req: CleanRequest, top: number): void {
  const { cols, rows, palette, totalBeads } = req;
  const limit = PAGE_H - BOTTOM_RESERVE - 2;
  if (top > limit - 30) return;

  const used = palette.filter((entry) => entry.count > 0);
  const buyFor = (count: number) => Math.ceil((count * 1.1) / 10) * 10;
  const totalBuy = used.reduce((sum, entry) => sum + buyFor(entry.count), 0);

  setInk(doc, INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.text('SHOPPING SUMMARY', M, top);

  const cards: Array<[string, string, string]> = [
    ['TOTAL PACKS', `${used.length}`, 'distinct colors to buy'],
    ['TOTAL PIECES', `${totalBuy}`, `covers ${totalBeads} beads + 10%`],
    ['FINISHED SIZE', `${((cols * 5) / 10).toFixed(1)} x ${((rows * 5) / 10).toFixed(1)} cm`, '5 mm midi beads'],
    ['PEGBOARDS', `${Math.ceil(cols / 29)} x ${Math.ceil(rows / 29)}`, '29 x 29 peg large boards'],
  ];

  const gap = 3;
  const cardW = (PAGE_W - 2 * M - gap * (cards.length - 1)) / cards.length;
  const cardH = 20;
  cards.forEach(([label, value, note], i) => {
    const x = M + i * (cardW + gap);
    setFill(doc, PAPER_TINT);
    doc.rect(x, top + 4, cardW, cardH, 'F');
    setFill(doc, ACCENT);
    doc.rect(x, top + 4, 1.4, cardH, 'F');

    setInk(doc, INK_FAINT);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(5.8);
    doc.text(label, x + 3.4, top + 9);

    setInk(doc, INK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(value, x + 3.4, top + 15.4);

    setInk(doc, INK_FAINT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(5.6);
    doc.text(note, x + 3.4, top + 20.2);
  });

  // 最省事的替代采购提示
  setInk(doc, INK_SOFT);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.8);
  doc.text(
    'Tip: bead bags are usually sold in 100 or 500 pcs. Round BUY up to the nearest bag size when ordering.',
    M,
    top + 30,
  );
  doc.text(
    'Quantities already include a 10% buffer for dropped or damaged beads during ironing.',
    M,
    top + 34,
  );

  // 色彩构成条：一眼看出"谁是主色/谁是背景"，同时把页面下部最后那段空白吃掉。
  // 版面预算很紧（TOTAL 之后只剩 ~57mm），所以这里精确算好每段高度再决定画不画，
  // 不靠"大概够吧"——之前那版就是因为 offset 差 3mm 被整体丢掉。
  const barY = top + 40;
  const barH = 8;
  const chipsTop = barY + barH + 2.4;
  if (chipsTop + 4 > limit) return;

  rule(doc, M, barY - 4.6, PAGE_W - M, RULE, 0.3);
  setInk(doc, INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.0);
  doc.text('COLOR MIX', M, barY - 1.0);
  setInk(doc, INK_FAINT);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.2);
  doc.text('share of all beads - widest bar = most used color', M + 22, barY - 1.0);

  const barW = PAGE_W - 2 * M;
  const big = used.filter((entry) => entry.ratio >= 0.007);
  const totalRatio = big.reduce((sum, entry) => sum + entry.ratio, 0) || 1;
  let bx = M;
  big.forEach((entry) => {
    const w = (entry.ratio / totalRatio) * barW;
    setFill(doc, [entry.rgb.r, entry.rgb.g, entry.rgb.b]);
    doc.rect(bx, barY, w + 0.15, barH, 'F');
    // 条内只标放得下的色号（>9mm 才写，否则交给下面的 chip 行）
    if (w > 9) {
      setInk(doc, inkTuple(readableInkFor(entry.rgb)));
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(5.2);
      doc.text(toAscii(entry.code), bx + w / 2, barY + barH / 2 + 0.6, { align: 'center' });
    }
    bx += w;
  });
  setDraw(doc, WHITE);
  doc.setLineWidth(0.2);
  doc.rect(M, barY, barW, barH, 'S');

  // 条下方：每个色一个 "色块 色号 占比%" 的小 chip，横向铺两行
  const chipStep = barW / Math.max(big.length, 1);
  const chipFs = Math.max(4.6, Math.min(5.6, chipStep * 0.42));
  big.forEach((entry, i) => {
    const cx = M + i * chipStep;
    setFill(doc, [entry.rgb.r, entry.rgb.g, entry.rgb.b]);
    doc.rect(cx, chipsTop, 2.4, 2.4, 'F');
    setDraw(doc, RULE);
    doc.setLineWidth(0.1);
    doc.rect(cx, chipsTop, 2.4, 2.4, 'S');
    setInk(doc, INK_SOFT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(chipFs);
    doc.text(toAscii(entry.code), cx + 3.2, chipsTop + 2.1);
  });
}

// ---------------------------------------------------------------------------
// 色号图例
// ---------------------------------------------------------------------------

function drawLegendPages(doc: Doc, req: CleanRequest): void {
  const { palette, totalBeads, brandLabel, cols, rows } = req;
  const usedColors = palette.filter((entry) => entry.count > 0);

  const gridTop = 52;
  const gridBottom = PAGE_H - 26 - 34; // 底部留给脚注
  const availH = gridBottom - gridTop;
  const availW = PAGE_W - 2 * M;

  const gapX = 2.8;
  const gapY = 2.5;
  const baseW = 29;
  const baseH = 20;

  /**
   * 选一个统一缩放系数 s：卡片等比放大，列数随宽度重算。
   * 优先保证"本页能装下全部颜色"（不留大片空白），装不下就用 s=1 分页。
   */
  const layoutFor = (scale: number) => {
    const cardW = baseW * scale;
    const cardH = baseH * scale;
    const colsPerRow = Math.max(1, Math.floor((availW + gapX) / (cardW + gapX)));
    const rowsPerPage = Math.max(1, Math.floor((availH + gapY) / (cardH + gapY)));
    return { cardW, cardH, colsPerRow, rowsPerPage, perPage: colsPerRow * rowsPerPage };
  };

  let scale = 1;
  if (usedColors.length > 0) {
    for (let candidate = 1.7; candidate >= 1; candidate -= 0.05) {
      if (layoutFor(candidate).perPage >= usedColors.length) {
        scale = candidate;
        break;
      }
    }
  }

  const { cardW, cardH, colsPerRow, rowsPerPage } = layoutFor(scale);
  const perPage = colsPerRow * rowsPerPage;
  const sc = scale; // 字号/色块的统一缩放

  const chunks: CleanPaletteEntry[][] = [];
  for (let i = 0; i < usedColors.length; i += perPage) {
    chunks.push(usedColors.slice(i, i + perPage));
  }
  if (chunks.length === 0) chunks.push([]);

  chunks.forEach((chunk, chunkIndex) => {
    if (chunkIndex > 0) doc.addPage();

    drawPageHeader(
      doc,
      chunkIndex === 0 ? 'COLOR LEGEND' : 'COLOR LEGEND (CONT.)',
      `Brand ${brandLabel}  |  Grid ${cols} x ${rows}  |  ${usedColors.length} colors  |  ${totalBeads} beads`,
    );

    if (chunkIndex === 0) {
      setInk(doc, INK_SOFT);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.6);
      doc.text(
        'Grid cells show the brand color code (e.g. A01). When a code is too long for a cell,',
        M,
        gridTop - 9,
      );
      doc.text(
        'a legend index number (1, 2, 3 ...) is printed instead - match it to the NO. on this page.',
        M,
        gridTop - 5,
      );
    }

    // 卡片内部等比缩放；色块不能吃掉右侧文本所需的宽度
    const swatch = Math.min(cardH - 4 * sc, 13 * sc, cardW - 16 * sc);
    const badgeR = Math.max(2.2, swatch * 0.2);
    const padX = 1.6 * sc;

    chunk.forEach((entry, i) => {
      const cx = M + (i % colsPerRow) * (cardW + gapX);
      const cy = gridTop + Math.floor(i / colsPerRow) * (cardH + gapY);
      const sx = cx + padX;
      const sy = cy + (cardH - swatch) / 2;

      setFill(doc, [entry.rgb.r, entry.rgb.g, entry.rgb.b]);
      doc.rect(sx, sy, swatch, swatch, 'F');
      setDraw(doc, INK);
      doc.setLineWidth(0.2);
      doc.rect(sx, sy, swatch, swatch, 'S');

      // 序号徽章（压在色块右上角）
      const bx = sx + swatch - badgeR * 0.85;
      const by = sy + badgeR * 0.85;
      setFill(doc, INK);
      doc.circle(bx, by, badgeR, 'F');
      setInk(doc, WHITE);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(Math.max(5.4, 5.6 * sc));
      doc.text(String(entry.index + 1), bx, by + 0.08, {
        align: 'center',
        baseline: 'middle',
      });

      const tx = sx + swatch + 2.0 * sc;
      const lineH = Math.min((cardH - 3) / 5, 6.2 * sc);
      setInk(doc, INK);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(Math.max(7.4, 8.6 * sc));
      doc.text(toAscii(entry.code), tx, cy + 1.6 + lineH);

      setInk(doc, INK_SOFT);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(Math.max(5.8, 6.4 * sc));
      doc.text(entry.hex, tx, cy + 1.6 + lineH * 2);

      setInk(doc, INK);
      doc.setFontSize(Math.max(6.0, 6.8 * sc));
      doc.text(`x${entry.count}`, tx, cy + 1.6 + lineH * 3);

      setInk(doc, INK_FAINT);
      doc.setFontSize(Math.max(5.4, 5.8 * sc));
      doc.text(`${(entry.ratio * 100).toFixed(1)}%`, tx, cy + 1.6 + lineH * 4);
    });

    // 最后一屏底部补"怎么读图例"的说明，避免整页下半空白
    if (chunkIndex === chunks.length - 1) {
      const usedRowCount = Math.ceil(chunk.length / colsPerRow);
      const footTop = gridTop + usedRowCount * (cardH + gapY) + 6;
      drawLegendNotes(doc, req, footTop);
    }
  });
}

/**
 * 图例页脚注：把"色号 vs 图例序号 vs 空白点"三件事一次讲清，
 * 也顺带说明如何在页面上定位（全局标尺）。
 */
function drawLegendNotes(doc: Doc, req: CleanRequest, top: number): void {
  const limit = PAGE_H - BOTTOM_RESERVE - 2;
  if (top > limit - 26) return;

  rule(doc, M, top, PAGE_W - M, RULE, 0.3);

  setInk(doc, INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.text('READING THE PATTERN PAGES', M, top + 5.5);

  const notes: Array<[string, string]> = [
    ['COLOR CODE', 'Cell text such as "A01" is the brand color code - buy exactly this code.'],
    ['INDEX NUMBER', 'If the code does not fit, the cell shows this page NO. (1, 2, 3 ...) instead.'],
    ['BLANK CELL', 'A small centre dot means no bead there - leave the peg empty.'],
    ['POSITION', 'Ruler numbers are global: Cols 1..N, Rows 1..N. Bold lines every 10 cells.'],
  ];

  let y = top + 11;
  for (const [label, text] of notes) {
    if (y > limit) return;
    setFill(doc, PAPER_TINT);
    doc.rect(M, y - 3.2, 34, 6.4, 'F');
    setInk(doc, INK_SOFT);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.2);
    doc.text(label, M + 2.4, y + 0.4);

    setInk(doc, INK);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.8);
    doc.text(text, M + 38, y + 0.4);
    y += 7.4;
  }

  // 深色底上的白字说明：怕用户以为印错了
  if (y <= limit - 8) {
    setInk(doc, INK_FAINT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.4);
    doc.text(
      'On dark beads the label is printed in light ink, and on light beads in dark ink, so both stay readable.',
      M,
      y + 2,
    );
  }
}

// ---------------------------------------------------------------------------
// 页脚
// ---------------------------------------------------------------------------

function stampFooters(doc: Doc, req: CleanRequest): void {
  const total = doc.getNumberOfPages();
  for (let page = 1; page <= total; page++) {
    doc.setPage(page);
    setDraw(doc, RULE);
    doc.setLineWidth(0.2);
    doc.line(M, PAGE_H - 11, PAGE_W - M, PAGE_H - 11);
    setInk(doc, INK_FAINT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.8);
    doc.text(
      `Perler Bead Pattern  |  ${req.cols} x ${req.rows}  |  Brand ${req.brandLabel}`,
      M,
      PAGE_H - 6.5,
    );
    doc.text(`Page ${page} / ${total}`, PAGE_W - M, PAGE_H - 6.5, { align: 'right' });
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  let raw: IncomingBody;
  try {
    raw = (await request.json()) as IncomingBody;
  } catch {
    return badRequest('Request body must be valid JSON');
  }

  const validated = validateBody(raw);
  if (validated instanceof NextResponse) return validated;
  const req = validated;

  try {
    let plan: PagePlan;
    try {
      plan = planPages(req.cols, req.rows);
    } catch (error) {
      // 图太大排不下：明确 400，而不是生成一份几十页/几十 MB 的无用 PDF
      if (error instanceof PagePlanError) return badRequest(error.message);
      throw error;
    }
    const forceIndexOnly = req.cols * req.rows > MAX_CELLS_WITH_CODES;

    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
      compress: true,
    });
    doc.setProperties({
      title: toAscii(`Perler Bead Pattern ${req.cols}x${req.rows} - ${req.brandLabel}`),
      subject: 'Tiled perler bead pattern sheet',
      creator: 'Perler Bead Generator',
    });

    // 封面
    drawCover(doc, req, plan);

    // 整图总览：需要拆页的大图才有意义（小图一页就看全了）
    if (plan.tiles.length > 1) {
      doc.addPage();
      drawPatternOverview(doc, req, plan);
    }

    // 图纸
    const labelSpecs = buildLabelSpecs(doc, req.palette, plan.cell, forceIndexOnly);
    plan.tiles.forEach((tile, index) => {
      doc.addPage();
      drawPatternTile(doc, req, plan, tile, index, labelSpecs, forceIndexOnly);
    });

    // 用料清单
    doc.addPage();
    drawMaterialsPages(doc, req);

    // 图例
    doc.addPage();
    drawLegendPages(doc, req);

    stampFooters(doc, req);

    const buffer = Buffer.from(doc.output('arraybuffer'));
    const filename = `perler-pattern-${req.brandLabel.toLowerCase()}-${req.cols}x${req.rows}.pdf`;

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(buffer.byteLength),
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('PDF generation error:', error);
    return NextResponse.json({ error: 'Failed to generate PDF' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'POST a pattern payload to generate the PDF sheet.',
    body: {
      cols: `integer 1-${MAX_DIM}`,
      rows: `integer 1-${MAX_DIM}`,
      brand: BRANDS,
      cells: 'number[] length cols*rows, palette index or -1 for blank',
      palette: '[{ hex: "#RRGGBB", code: "A01", count: number, ratio: number }]',
      totalBeads: 'number (informational; recomputed from cells)',
      generatedAt: 'ISO date string',
    },
    output: 'Tiled A4 PDF: cover, pattern tiles, bill of materials, color legend',
  });
}
