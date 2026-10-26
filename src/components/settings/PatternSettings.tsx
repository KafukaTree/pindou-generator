'use client';

import { useCallback, useMemo, type ReactNode } from 'react';
import { AlignCenter, Grid2x2, Maximize2, SlidersHorizontal } from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { getBrandPalette, BRANDS, BRAND_META, type Brand } from '@/lib/color/palette';
import type { GenerateOptions, PatternResult } from '@/lib/pattern/generate';
import {
  DETAIL_ALGORITHMS,
  DETAIL_META,
  type DetailAlgorithm,
} from '@/lib/pattern/detail';
import {
  LINES_META,
  THICKNESS_META,
  type OutlineSettings,
} from '@/lib/pattern/outline-settings';
import {
  DEFAULT_MARGIN,
  MARGIN_META,
  type MarginMode,
} from '@/lib/pattern/margin';
import {
  BEAD_SIZES,
  BEAD_SPECS,
  DEFAULT_BEAD_SIZE,
  boardSummary,
  finishedSizeCm,
  planBoards,
  type BeadSize,
} from '@/lib/pattern/board';
import { cn } from '@/lib/utils';

/**
 * 拼豆生成参数
 * ===============================================================
 * 这替代了原来散落在 page.tsx 里的"三个滑杆 + 一个 Apply 按钮"。
 *
 * **为什么去掉 Apply**：原来必须点 Apply 才重算，用户滑完滑杆看不到结果，
 * 也不知道"我还没生效"，于是反复点、历史记录被刷屏。现在参数一变就
 * onChange 出去，由父组件 debounce 后重算；`isWorking` 只做一个不阻塞
 * 交互的轻提示（滑杆不会被禁用，可以连续拖）。
 *
 * **为什么每个滑杆都写一句人话解释**：gridSize 120 格不等于"高清"，
 * 而是"能拼得动的极限"；dither 不是"更专业"，而是"颗粒更多、色号更多"。
 * 参数名本身对新手没有意义，解释性副标题才是这个面板的价值。
 */

export interface PatternSettingsProps {
  value: GenerateOptions;
  onChange: (next: GenerateOptions) => void;
  disabled?: boolean;
  /** 当前图案实际列数（非正方形图 rows ≠ cols） */
  actualCols?: number;
  /** 当前图案实际行数 */
  actualRows?: number;
  /** 引擎给出的成品尺寸（按当前豆径，熨烫前，cm）；不传则按行列数与豆径估算 */
  sizeCm?: { w: number; h: number } | null;
  /**
   * 引擎写下的"短边对齐到整块板"痕迹。没对齐时不传。
   *
   * 必须由引擎提供而不是组件自算，原因见 alignedNote 里的注释。
   */
  patternAlign?: PatternResult['meta']['boardAlign'];
  /** 父组件正在重算（debounce 中 / 同步计算中），显示轻提示但不阻塞操作 */
  isWorking?: boolean;
  /**
   * 卡通黑边设置。
   *
   * 为什么不塞进 `value: GenerateOptions`：那是量化配方，会被原样交给
   * `generatePattern`。描边是量化**之后**的渲染层改动，用的是另一套
   * 数据（源图梯度 + 轮廓路径）。混在一起会让"改粗细"触发整条量化
   * 重跑（320 格要 1 秒），而实际只需要重算描边那一步。
   */
  outline?: OutlineSettings;
  onOutlineChange?: (next: OutlineSettings) => void;
  /** 描边当前算不出来的原因（色位满 / 主体贴边等），显示在开关下方 */
  outlineNote?: string | null;
  /**
   * 画布边距策略。
   *
   * 它决定黑边有没有地方长：占原边（黑边可能被切）/ 缩小留边（内容变小）/
   * 扩大画布（成品变大）。三种都是取舍，没有"更好的那个"，所以按用户要求
   * 摆成三选一让他自己挑，而不是替他选一个。
   *
   * 只有开了黑边才有意义 —— 没黑边时留边只是白白浪费画布。
   */
  margin?: MarginMode;
  onMarginChange?: (next: MarginMode) => void;
  /**
   * 画板校准两个动作：居中（纯平移）与放大约到边（整数倍重采样）。
   * 不传时不渲染这一块 —— 组件在图片还没生成好时不该出现空按钮。
   */
  onCenter?: () => void;
  onScaleToFit?: () => void;
  className?: string;
}

/**
 * 常用档位：小挂件 / 常规 / 桌面摆件 / 大图 / 超大 / 超大幅。
 *
 * 上限从 120 提到 320，理由：120 格（60cm）看着不少，但用户拿手机
 * 原图（4000×3000）想拼一幅 1 米宽的挂画时，120 格意味着每颗豆要
 * 装下 33×33 个源像素 —— 五官、花纹全糊成一团色块。320 格才是
 * 5mm 豆的"海报尺寸"档位（320 格 = 160cm 宽）。
 *
 * 引擎实测（源图放大到 2048 模拟手机原图）：
 *   120 格 → 12,240 格 / 5,231 颗 / 341ms
 *   200 格 → 33,800 格 / 14,583 颗 / 565ms
 *   320 格 → 75,900 格 / 32,778 颗 / 1,068ms
 * 320 格约 1 秒，还能接受（有 debounce 且有 isWorking 提示）。
 *
 * 档位不再等距：小尺寸密集（手作挂件主要落在这里），大尺寸稀疏
 * （320 格和 200 格的差别是"再多 2 千颗豆"，不是审美选择）。
 */
const GRID_PRESETS = [32, 48, 64, 96, 160, 320] as const;

const GRID_MIN = 16;
const GRID_MAX = 320;
const COLOR_MIN = 4;
const COLOR_MAX = 48;

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

/**
 * 成品尺寸文案。**必须带豆径** —— 同样是 64 格，5mm 是 32cm、2.6mm 是
 * 16.6cm，差将近一倍。旧版这里写死 0.5cm/格。
 */
function formatCm(cols: number, rows: number, beadSize: BeadSize): string {
  const { w, h } = finishedSizeCm(cols, rows, beadSize);
  return `约 ${w} × ${h} cm`;
}

/**
 * 像素滑杆的样式修正
 * ===============================================================
 * globals.css 里 `.px-slider [data-slot=slider-track]` 等规则写在
 * `@layer components`，而 Tailwind 的 utilities 层在它**之后**才输出，
 * 所以 shadcn Slider 自带的 `h-1.5` / `rounded-full` / `bg-white`
 * 会把这些像素风规则整条盖掉（实测：轨道高度只剩 6px、thumb 变成圆的白点，
 * 跟整套方角硬投影完全不是一回事）。
 *
 * globals.css 不在我的修改范围内，所以在组件里用任意变体 + `!important`
 * 把像素风抢回来：方角轨道、方角拨片、clay 填充、硬投影。
 */
const SLIDER_CLASSES = cn(
  'px-slider',
  // 轨道：方角、8px、2px 硬边、凹陷底
  '[&_[data-slot=slider-track]]:!h-2 [&_[data-slot=slider-track]]:!rounded-none',
  '[&_[data-slot=slider-track]]:!border-2 [&_[data-slot=slider-track]]:!border-[var(--line-strong)]',
  '[&_[data-slot=slider-track]]:!bg-[var(--paper-sunken)]',
  // 已选区间：clay 实色
  '[&_[data-slot=slider-range]]:!bg-[var(--clay)]',
  // 拨片：16×20 方角，纸面色 + 硬投影
  '[&_[data-slot=slider-thumb]]:!h-5 [&_[data-slot=slider-thumb]]:!w-4',
  '[&_[data-slot=slider-thumb]]:!rounded-none [&_[data-slot=slider-thumb]]:!border-2',
  '[&_[data-slot=slider-thumb]]:!border-[var(--line-strong)] [&_[data-slot=slider-thumb]]:!bg-[var(--paper-hi)]',
  '[&_[data-slot=slider-thumb]]:!shadow-[0_3px_0_0_var(--line-strong)]',
  '[&_[data-slot=slider-thumb]]:hover:!bg-[var(--clay)]',
  'dark:[&_[data-slot=slider-thumb]]:!shadow-[0_3px_0_0_var(--line-strong)]',
  'dark:[&_[data-slot=slider-thumb]]:!bg-[var(--paper-hi)]',
  // 键盘聚焦也必须是方角
  '[&_[data-slot=slider-thumb]]:!outline-none [&_[data-slot=slider-thumb]]:!ring-0',
  '[&_[data-slot=slider-thumb]]:focus-visible:!border-[var(--clay)]',
  '[&_[data-slot=slider-thumb]]:focus-visible:!bg-[var(--clay)]',
  // 禁用态：别让整条滑杆淡到看不清
  'data-[disabled]:!opacity-70',
);

const BRAND_SHORT: Record<Brand, string> = {
  MARD: 'MARD',
  COCO: 'COCO',
  漫漫: '漫漫',
  盼盼: '盼盼',
  咪小窝: '咪小窝',
};

export function PatternSettings({
  value,
  onChange,
  disabled = false,
  actualCols,
  actualRows,
  patternAlign,
  sizeCm = null,
  isWorking = false,
  outline,
  onOutlineChange,
  outlineNote = null,
  margin = DEFAULT_MARGIN,
  onMarginChange,
  onCenter,
  onScaleToFit,
  className,
}: PatternSettingsProps) {
  const patch = useCallback(
    (next: Partial<GenerateOptions>) => onChange({ ...value, ...next }),
    [onChange, value],
  );

  // 色卡总数只跟品牌有关，别每次渲染都重建（291 色 × 5 品牌不算贵，但没必要）
  const brandCounts = useMemo(() => {
    const map = {} as Record<Brand, number>;
    for (const b of BRANDS) map[b] = getBrandPalette(b).length;
    return map;
  }, []);

  const cols = actualCols ?? 0;
  const rows = actualRows ?? 0;
  const hasActual = cols > 0 && rows > 0;
  const beadSize = value.beadSize ?? DEFAULT_BEAD_SIZE;
  /*
   * 短边对齐默认**开**（见 `GenerateOptions.boardAlign` 的注释）。
   * `value.boardAlign` 是 undefined 时算开 —— 不能写 `?? true` 了事，
   * 因为要给"用户显式关掉"留出 false 这个值，两者必须区分开。
   */
  const boardAlignOn = value.boardAlign !== false;
  const plateValue = value.boardPlate ?? BEAD_SPECS[beadSize].commonPlate;
  const cmText = hasActual
    ? sizeCm
      ? `约 ${sizeCm.w.toFixed(1)} × ${sizeCm.h.toFixed(1)} cm`
      : formatCm(cols, rows, beadSize)
    : null;
  /*
   * 板子方案。只在有真实行列时算 —— 还没选图时 cols/rows 是 0，
   * 算出来会是「1 块 14×14 板」这种毫无意义的结论。
   *
   * 用 useMemo 是因为它要打断板目录的排序，而这段在滑杆拖动时每帧都在
   * 渲染（父组件每次 setState 都重算一次）。
   */
  const boardPlate = boardAlignOn ? value.boardPlate : undefined;
  const boardPlan = useMemo(
    () => (hasActual ? planBoards(cols, rows, beadSize, boardPlate) : null),
    [hasActual, cols, rows, beadSize, boardPlate],
  );
  const boardText = boardPlan ? boardSummary(boardPlan) : null;
  /*
   * 对齐说明：只有"真的补了格"才写，且要说清补了几格、补在哪。
   * 用户把 64×54 看成 64×58 时必须知道多出来的 4 行是空白格 ——
   * 否则他会以为工具擅自改了他的图。
   */
  /*
   * 对齐说明直接读引擎写进 `pattern.meta.boardAlign` 的 before/after。
   *
   * 曾经试过在组件里用 `value.aspect` 反推（因为 cols/rows 已经是补齐后
   * 的值，反推不出来）—— 但 `options.aspect` 只是原图比例的缓存，引擎
   * 实际用的是**裁掉背景之后**的比例，两者可能完全不同。实测就出过
   * "短边按比例是 64 行，已补到 87 行"这种荒唐文案。引擎是唯一知道
   * 补之前是多少的地方，就该让它写出来。
   */
  const alignedNote = (() => {
    const align = patternAlign;
    if (!hasActual || !boardAlignOn || !align) return null;
    const axisName = align.axis === 'rows' ? '行' : '列';
    return `短边按比例是 ${align.before} ${axisName}，已补到 ${align.after} ${axisName}对齐整块板（${align.grown} ${axisName}是空白格）`;
  })();

  return (
    <div className={cn('space-y-3.5', disabled && 'opacity-[0.82]', className)}>
      {/* 头部：标题 + 重算提示（不阻塞） */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="px-section-title">图案参数</h3>
        </div>
        <span
          className={cn(
            // 这里是中文，不能挂 .px-label（那会让它落到像素字体的 CJK 兜底，
            // 又小又带 0.08em 字距，10px 下几乎糊成一团）。用正文字体 + 正常字号。
            'inline-flex items-center text-[11px] leading-none tracking-normal text-[var(--ink-2)] transition-opacity duration-150',
            isWorking ? 'opacity-100' : 'opacity-0',
          )}
          aria-live="polite"
        >
          <span
            aria-hidden
            className="mr-1.5 inline-block h-1.5 w-1.5 bg-[var(--clay)] align-middle px-blink"
          />
          重算中
        </span>
      </div>

      <div className="px-rule" />

      {/* ---------------- 网格密度 ---------------- */}
      <Field
        label="网格密度"
        hint="数字越大越精细，但颗数呈平方增长、越难拼"
        readout={
          <span className="flex items-baseline gap-1">
            {/* 主数值用 UI 字体 + tabular-nums：Silkscreen 的 "4" 字形是填实方块，
                13px 下 "64" 会被读成 "6▮"，不能用来显示用户要精确读的参数。
                像素字体保留给色号/品牌名这类短码。 */}
            <span className="text-[14px] font-semibold tabular-nums text-[var(--ink)]">
              {value.gridSize}
            </span>
            <span className="text-[11px] leading-none text-[var(--ink-2)]">格/长边</span>
          </span>
        }
        disabled={disabled}
      >
        <div className={SLIDER_CLASSES}>
          <Slider
            value={[value.gridSize]}
            min={GRID_MIN}
            max={GRID_MAX}
            step={1}
            disabled={disabled}
            onValueChange={([n]) => patch({ gridSize: clamp(n, GRID_MIN, GRID_MAX) })}
            aria-label="网格密度（长边格数）"
          />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {GRID_PRESETS.map((preset) => {
            const active = value.gridSize === preset;
            return (
              <button
                key={preset}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                onClick={() => patch({ gridSize: preset })}
                className={cn(
                  'px-btn px-btn-sm !px-2 !py-1 !text-[11.5px]',
                  active && 'px-btn-on',
                )}
              >
                {preset}
              </button>
            );
          })}
          <span className="ml-auto text-[11px] tabular-nums leading-none text-[var(--ink-2)]">
            {GRID_MIN}–{GRID_MAX}
          </span>
        </div>

        {hasActual ? (
          <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-[11px] leading-none text-[var(--ink-2)]">实际</span>
            <span className="text-[12.5px] font-semibold tabular-nums text-[var(--ink-2)]">
              {cols} × {rows}
            </span>
            <span className="text-[11.5px] text-[var(--ink-2)]">{cmText}</span>
          </div>
        ) : (
          <p className="mt-2 text-[11.5px] text-[var(--ink-2)]">
            选好图片后这里会显示实际行列与成品尺寸
          </p>
        )}
      </Field>

      {onCenter && onScaleToFit ? (
        <CanvasCalibrateRow onCenter={onCenter} onScaleToFit={onScaleToFit} disabled={disabled} />
      ) : null}

      <div className="px-rule" />

      {/* ---------------- 颜色数量 ---------------- */}
      <Field
        label="颜色数量"
        hint="越少越好拼；颜色太少会让明暗过渡变硬"
        readout={
          <span className="flex items-baseline gap-1">
            <span className="text-[14px] font-semibold tabular-nums text-[var(--ink)]">
              {value.colorLimit}
            </span>
            <span className="text-[11px] leading-none text-[var(--ink-2)]">色</span>
          </span>
        }
        disabled={disabled}
      >
        <div className={SLIDER_CLASSES}>
          <Slider
            value={[value.colorLimit]}
            min={COLOR_MIN}
            max={COLOR_MAX}
            step={1}
            disabled={disabled}
            onValueChange={([n]) => patch({ colorLimit: clamp(n, COLOR_MIN, COLOR_MAX) })}
            aria-label="最多使用的颜色数量"
          />
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="text-[11px] tabular-nums leading-none text-[var(--ink-2)]">
            {COLOR_MIN}–{COLOR_MAX}
          </span>
          <span className="flex items-baseline gap-1 text-[11px] leading-none text-[var(--ink-2)]">
            <span className="px-label text-[11px] tracking-normal text-[var(--ink-2)]">
              {BRAND_SHORT[value.brand]}
            </span>
            <span>共</span>
            <span className="font-semibold tabular-nums">{brandCounts[value.brand]}</span>
            <span>色可选</span>
          </span>
        </div>
      </Field>

      <div className="px-rule" />

      {/* ---------------- 品牌 ---------------- */}
      <Section
        label="品牌"
        hint={BRAND_META[value.brand].note}
        disabled={disabled}
      >
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5" role="group" aria-label="豆子品牌">
          {BRANDS.map((brand) => {
            const active = value.brand === brand;
            return (
              <button
                key={brand}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                onClick={() => patch({ brand })}
                className={cn(
                  'flex flex-col items-center justify-center gap-0.5 border-2 px-1 py-1.5 transition-[background-color,box-shadow,transform] duration-75',
                  active
                    ? // 选中：clay 底 + 内阴影下沉（看起来被按进去了）
                      // 选中态也要有悬停反应：默认选中的那一个（MARD）如果不动，
                      // 用户会以为整排"坏了"。加深一档实底即可，不加位移。
                      'border-[var(--clay-deep)] bg-[var(--clay)] text-[var(--on-clay)] shadow-[inset_0_2px_0_0_rgba(0,0,0,0.22)] hover:bg-[var(--clay-deep)]'
                    : 'border-[var(--line-strong)] bg-[var(--paper-raised)] text-[var(--ink)] shadow-[0_2px_0_0_var(--line-strong)] hover:border-[var(--clay)] hover:bg-[var(--paper-hi)]',
                  disabled && 'cursor-not-allowed',
                )}
              >
                <span className="text-[12px] font-semibold leading-tight">
                  {BRAND_SHORT[brand]}
                </span>
                <span
                  className={cn(
                    'flex items-baseline gap-0.5 text-[10.5px] leading-tight',
                    active ? 'opacity-85' : 'text-[var(--ink-2)]',
                  )}
                >
                  <span className="tabular-nums">{brandCounts[brand]}</span>
                  <span>色</span>
                </span>
              </button>
            );
          })}
        </div>
      </Section>

      <div className="px-rule" />

      {/* ---------------- 豆径（决定成品多大、要几块板） ---------------- */}
      <Section
        label="豆径"
        hint={BEAD_SPECS[beadSize].hint}
        disabled={disabled}
      >
        <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="豆子直径">
          {BEAD_SIZES.map((id) => {
            const spec = BEAD_SPECS[id];
            const active = beadSize === id;
            return (
              <button
                key={id}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                onClick={() => patch({ beadSize: id })}
                className={cn(
                  'flex flex-col items-start gap-0.5 border-2 px-2 py-1.5 text-left transition-[background-color,box-shadow] duration-75',
                  active
                    ? 'border-[var(--clay-deep)] bg-[var(--clay)] text-[var(--on-clay)] shadow-[inset_0_2px_0_0_rgba(0,0,0,0.22)] hover:bg-[var(--clay-deep)]'
                    : 'border-[var(--line-strong)] bg-[var(--paper-raised)] text-[var(--ink)] shadow-[0_2px_0_0_var(--line-strong)] hover:border-[var(--clay)] hover:bg-[var(--paper-hi)]',
                  disabled && 'cursor-not-allowed',
                )}
              >
                <span className="text-[12px] font-semibold leading-tight">{spec.label}</span>
                <span
                  className={cn(
                    'text-[10.5px] leading-tight tabular-nums',
                    active ? 'opacity-85' : 'text-[var(--ink-2)]',
                  )}
                >
                  常见板 {spec.commonPlate}×{spec.commonPlate} 钉
                </span>
              </button>
            );
          })}
        </div>

        {/*
         * 板子方案 —— 这是用户 m11918 真正想要的那个数。
         *
         * 他的动作不是"我要 64 格"，而是"我这块板放不放得下、不够要买几块"。
         * 上面滑杆只告诉他格数，这里告诉他换算成现实的结论。
         */}
        {boardText ? (
          <div className="px-inset mt-1.5 flex items-start gap-1.5 p-2">
            <Grid2x2 className="mt-[1px] h-3 w-3 shrink-0 text-[var(--clay)]" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-[11.5px] leading-snug text-[var(--ink)]">
                <span className="text-[var(--ink-2)]">底板 </span>
                <span className="font-semibold tabular-nums">{boardText}</span>
              </p>
              <p className="mt-0.5 text-[10.5px] leading-snug text-[var(--ink-2)]">
                尺寸是熨烫前的；烫完会缩 5%–8%（小豆缩得更多）
              </p>
            </div>
          </div>
        ) : (
          <p className="mt-1.5 text-[11px] leading-snug text-[var(--ink-2)]">
            选好图片后这里会算出用几块底板
          </p>
        )}

        {/*
         * 短边对齐 + 板钉数自定义。
         *
         * 用户 m12282：「最好是整个格子整个格子的取，不然实在不好看，比如
         * 64 就是整的，然后五十几就不整」；m12286：「也要支持用户自定义的，
         * 不然没法调整」。所以默认开、能关、板钉数能填。
         *
         * 为什么钉数是**输入框**而不是下拉：真实世界的板不止 29/52 两种，
         * 用户手上可能是 14×14 小板、78×78 大板、或者某些品牌的 50/57 钉
         * （这几档互相还不能拼）。做成固定选项就必须替他想全，而一定会漏。
         */}
        <div className="mt-2 flex items-center gap-1.5">
          <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-[var(--ink)]">
            <input
              type="checkbox"
              checked={boardAlignOn}
              disabled={disabled}
              onChange={(e) => patch({ boardAlign: e.target.checked })}
              className="h-3 w-3 accent-[var(--clay)]"
            />
            短边对齐整块板
          </label>
          <span className="ml-auto flex items-center gap-1 text-[11px] text-[var(--ink-2)]">
            <span>按</span>
            <input
              type="number"
              inputMode="numeric"
              min={2}
              max={200}
              step={1}
              disabled={disabled || !boardAlignOn}
              value={plateValue}
              aria-label="单块底板钉数"
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isFinite(n)) return;
                patch({ boardPlate: Math.max(2, Math.min(200, Math.round(n))) });
              }}
              className="w-[46px] border-2 border-[var(--line-strong)] bg-[var(--paper-hi)] px-1 py-0.5 text-center text-[11px] font-semibold tabular-nums text-[var(--ink)] outline-none focus:border-[var(--clay)] disabled:opacity-40"
            />
            <span>钉</span>
          </span>
        </div>
        {boardAlignOn && hasActual && alignedNote ? (
          <p className="mt-1 text-[10.5px] leading-snug text-[var(--ink-2)]">{alignedNote}</p>
        ) : null}
      </Section>

      <div className="px-rule" />

      {/* ---------------- 适配方式 ---------------- */}
      <Section
        label="适配方式"
        hint={
          value.fit === 'contain'
            ? '完整放入：整张图都在，比例不符处留白（不浪费豆子的部分会少）'
            : '填满裁切：铺满整个网格，四周会被裁掉一些'
        }
        disabled={disabled}
      >
        <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="图片适配方式">
          {(
            [
              { id: 'contain', label: '完整放入', sub: '不裁切' },
              { id: 'cover', label: '填满裁切', sub: '无留白' },
            ] as const
          ).map((opt) => {
            const active = value.fit === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                onClick={() => patch({ fit: opt.id })}
                className={cn(
                  'flex flex-col items-center gap-0.5 border-2 px-2 py-1.5 transition-[background-color,box-shadow] duration-75',
                  active
                    ? 'border-[var(--clay-deep)] bg-[var(--clay)] text-[var(--on-clay)] shadow-[inset_0_2px_0_0_rgba(0,0,0,0.22)]'
                    : 'border-[var(--line-strong)] bg-[var(--paper-raised)] text-[var(--ink)] shadow-[0_2px_0_0_var(--line-strong)] hover:border-[var(--clay)] hover:bg-[var(--paper-hi)]',
                  disabled && 'cursor-not-allowed',
                )}
              >
                <span className="text-[12.5px] font-semibold leading-tight">{opt.label}</span>
                <span
                  className={cn(
                    'text-[10.5px] leading-tight',
                    active ? 'opacity-85' : 'text-[var(--ink-2)]',
                  )}
                >
                  {opt.sub}
                </span>
              </button>
            );
          })}
        </div>
      </Section>

      <div className="px-rule" />

      {/* ---------------- 精细度算法 ----------------
          引擎按这一档一次性决定超采样倍数、调色板最小间隔、小特征保护强度、
          碎块合并门槛、弱色剪枝门槛。所以它不是"滤镜"，而是整条管线的档位，
          换档会明显改变色号数与颗粒感 —— 必须让用户能选，并且把代价写上。 */}
      <Section
        label="精细度算法"
        hint={DETAIL_META[value.detail ?? 'balanced'].blurb}
        disabled={disabled}
      >
        <div
          className="grid grid-cols-2 gap-1.5"
          role="group"
          aria-label="精细度算法"
        >
          {DETAIL_ALGORITHMS.map((algo) => {
            const active = (value.detail ?? 'balanced') === algo;
            const meta = DETAIL_META[algo];
            return (
              <button
                key={algo}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                onClick={() => patch({ detail: algo as DetailAlgorithm })}
                className={cn(
                  'flex flex-col items-start gap-0.5 border-2 px-2 py-1.5 text-left transition-[background-color,box-shadow] duration-75',
                  active
                    ? 'border-[var(--clay-deep)] bg-[var(--clay)] text-[var(--on-clay)] shadow-[inset_0_2px_0_0_rgba(0,0,0,0.22)]'
                    : 'border-[var(--line-strong)] bg-[var(--paper-raised)] text-[var(--ink)] shadow-[0_2px_0_0_var(--line-strong)] hover:border-[var(--clay)] hover:bg-[var(--paper-hi)]',
                  disabled && 'cursor-not-allowed',
                )}
              >
                <span className="text-[12.5px] font-semibold leading-tight">
                  {meta.label}
                </span>
                <span
                  className={cn(
                    'text-[10.5px] leading-tight',
                    active ? 'opacity-85' : 'text-[var(--ink-2)]',
                  )}
                >
                  {meta.best}
                </span>
              </button>
            );
          })}
        </div>
      </Section>

      <div className="px-rule" />

      {/* ---------------- 平滑 / 彩度（新引擎） ---------------- */}
      <Field
        label="色块成片度"
        hint="越高色块越连成片、越好拼；越低越保留细节"
        readout={
          <span className="flex items-baseline font-semibold tabular-nums text-[var(--ink)]">
            <span className="text-[13px]">{Math.round((value.smoothing ?? 0.6) * 100)}</span>
            <span className="ml-0.5 text-[11px] font-normal text-[var(--ink-2)]">%</span>
          </span>
        }
        disabled={disabled}
      >
        <div className={SLIDER_CLASSES}>
          <Slider
            value={[Math.round((value.smoothing ?? 0.6) * 100)]}
            min={0}
            max={100}
            step={5}
            disabled={disabled}
            onValueChange={([n]) => patch({ smoothing: clamp(n / 100, 0, 1) })}
            aria-label="色块成片度（平滑强度）"
          />
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-[11px] leading-none text-[var(--ink-2)]">保留细节</span>
          <span className="text-[11px] leading-none text-[var(--ink-2)]">极度概括</span>
        </div>
      </Field>

      <Field
        label="彩度增强"
        hint="让成品更鲜艳，适合卡通和插画；写实照片建议调低"
        readout={
          <span className="flex items-baseline font-semibold tabular-nums text-[var(--ink)]">
            <span className="text-[13px]">{(value.chromaBoost ?? 1.1).toFixed(2)}</span>
            <span className="ml-0.5 text-[11px] font-normal text-[var(--ink-2)]">×</span>
          </span>
        }
        disabled={disabled}
      >
        <div className={SLIDER_CLASSES}>
          <Slider
            value={[Math.round((value.chromaBoost ?? 1.1) * 100)]}
            min={100}
            max={135}
            step={1}
            disabled={disabled}
            onValueChange={([n]) => patch({ chromaBoost: clamp(n / 100, 1, 1.35) })}
            aria-label="彩度增强倍数"
          />
        </div>
      </Field>

      <div className="px-rule" />

      {/* ---------------- 开关 ---------------- */}
      <div className="space-y-2">
        <SwitchRow
          label="自动裁背景"
          hint="去掉大片同色背景，豆子不浪费在留白上"
          checked={value.autoCrop !== false}
          disabled={disabled}
          onChange={(next) => patch({ autoCrop: next })}
        />
        <SwitchRow
          label="忽略背景"
          hint="把与画布边缘同色的连通背景当空白，不拼豆"
          checked={value.background === 'ignore'}
          disabled={disabled}
          onChange={(next) => patch({ background: next ? 'ignore' : 'keep' })}
        />
        <SwitchRow
          label="抖动混色"
          hint="用噪点换渐变平滑；会明显增加色号与颗粒感，一般不建议开"
          checked={value.dither === true}
          disabled={disabled}
          onChange={(next) => patch({ dither: next })}
        />
      </div>

      {/*
        ---------------- 卡通黑边 ----------------
        单独一块、默认关闭，因为它会**多占一个颜色名额**（纯黑），
        在「颜色数量」卡得很紧时开它可能把某个原本的色挤掉。所以文案
        里要写清代价，而不是只写"更好看"。
      */}
      {outline && onOutlineChange ? (
        <>
          <div className="px-rule" />
          <div className="space-y-2">
            <SwitchRow
              label="卡通黑边"
              hint="沿轮廓盖一圈纯黑豆，卡通感和辨识度更强；会占用一个颜色名额"
              checked={outline.enabled}
              disabled={disabled}
              onChange={(next) => onOutlineChange({ ...outline, enabled: next })}
            />

            {/*
              只有开启时才露出粗细/样式：关着的时候露出一排点了没反应的
              按钮，最容易让人以为界面坏了。
            */}
            {outline.enabled ? (
              <div className="space-y-2.5 border-l-2 border-[var(--line)] pl-2.5">
                <div>
                  <span className="mb-1 block text-[11.5px] font-semibold leading-none text-[var(--ink)]">
                    黑边粗细
                  </span>
                  <div className="flex gap-1.5">
                    {THICKNESS_META.map((t) => (
                      <button
                        key={t.value}
                        type="button"
                        disabled={disabled}
                        onClick={() =>
                          onOutlineChange({ ...outline, thickness: t.value })
                        }
                        title={t.hint}
                        aria-pressed={outline.thickness === t.value}
                        className={cn(
                          'px-btn px-btn-sm !px-2.5 !py-1 !text-[11.5px]',
                          outline.thickness === t.value &&
                            '!border-[var(--clay-deep)] !bg-[var(--clay)] !text-[var(--on-clay)]',
                        )}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <span className="mb-1 block text-[11.5px] font-semibold leading-none text-[var(--ink)]">
                    线条
                  </span>
                  <div className="flex gap-1.5">
                    {LINES_META.map((s) => (
                      <button
                        key={s.value}
                        type="button"
                        disabled={disabled}
                        onClick={() =>
                          onOutlineChange({ ...outline, lines: s.value })
                        }
                        title={s.hint}
                        aria-pressed={outline.lines === s.value}
                        className={cn(
                          'px-btn px-btn-sm !px-2.5 !py-1 !text-[11.5px]',
                          outline.lines === s.value &&
                            '!border-[var(--clay-deep)] !bg-[var(--clay)] !text-[var(--on-clay)]',
                        )}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-[var(--ink-2)]">
                    {LINES_META.find((s) => s.value === outline.lines)?.hint}
                  </p>
                </div>

                {/*
                  画布边距：黑边长在主体外侧的空白格里，留白不够就会被
                  画布边界切掉。三种取舍都摆出来让用户自己挑 —— 缩小内容、
                  放大画布、还是接受切角，没有普适的更优解。

                  放在「线条」之后是有意的：用户先决定要不要描边、再决定
                  怎么给描边腾地方，顺序反过来会先问一个还不存在的问题。
                */}
                {onMarginChange ? (
                  <div>
                    <span className="mb-1 block text-[11.5px] font-semibold leading-none text-[var(--ink)]">
                      画布边距
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {MARGIN_META.map((m) => (
                        <button
                          key={m.value}
                          type="button"
                          disabled={disabled}
                          onClick={() => onMarginChange(m.value)}
                          title={m.hint}
                          data-testid={`margin-${m.value}`}
                          aria-pressed={margin === m.value}
                          className={cn(
                            'px-btn px-btn-sm !px-2.5 !py-1 !text-[11.5px]',
                            margin === m.value &&
                              '!border-[var(--clay-deep)] !bg-[var(--clay)] !text-[var(--on-clay)]',
                          )}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                    <p className="mt-1 text-[11px] leading-snug text-[var(--ink-2)]">
                      {MARGIN_META.find((m) => m.value === margin)?.hint}
                    </p>
                  </div>
                ) : null}

                {/*
                  实验能力必须自带"实验"标识。同色部件识别在验收里
                  6 项只过 1 项（耳根处会把同一色的耳朵切成两半），
                  不能让人以为这是稳定功能。
                */}
                <SwitchRow
                  label="同色部件补线（实验）"
                  hint="尝试把同色相邻部件之间也划开；目前不稳定，可能把一片同色切成两半"
                  checked={outline.experimentalParts}
                  disabled={disabled}
                  onChange={(next) =>
                    onOutlineChange({ ...outline, experimentalParts: next })
                  }
                />
              </div>
            ) : null}

            {/*
              算不出来时的原因。用说明文字而不是红色 toast：
              "色位满了"是正常边界，用户可能只是点开看一眼。
            */}
            {outline.enabled && outlineNote ? (
              <p className="border border-dashed border-[var(--line)] px-2 py-1.5 text-[11.5px] leading-snug text-[var(--ink-2)]">
                {outlineNote}
              </p>
            ) : null}
          </div>
        </>
      ) : null}

      {/* 禁用态说明：不让用户以为界面坏了 */}
      {disabled ? (
        <p className="flex items-center gap-1.5 border border-dashed border-[var(--line)] px-2 py-1.5 text-[11.5px] text-[var(--ink-2)]">
          <SlidersHorizontal className="h-3 w-3 shrink-0" aria-hidden />
          先上传一张图片，参数才会生效
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子组件
// ---------------------------------------------------------------------------

function Field({
  label,
  hint,
  readout,
  disabled,
  children,
}: {
  label: string;
  hint: string;
  readout: ReactNode;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn(disabled && 'opacity-90')}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold text-[var(--ink)]">{label}</span>
        {readout}
      </div>
      <p className="mt-0.5 text-[11.5px] leading-snug text-[var(--ink-2)]">{hint}</p>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function Section({
  label,
  hint,
  disabled,
  children,
}: {
  label: string;
  hint: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn(disabled && 'opacity-90')}>
      <span className="text-[13px] font-semibold text-[var(--ink)]">{label}</span>
      <p className="mb-1.5 mt-0.5 text-[11.5px] leading-snug text-[var(--ink-2)]">{hint}</p>
      {children}
    </div>
  );
}

/**
 * 像素风开关：不用原生 checkbox，自己画一个带硬投影的拨块。
 * 用 button + role="switch" 而不是 div，键盘与读屏都能正确操作。
 */
function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 border-2 px-2 py-1.5 transition-colors duration-100',
        checked
          ? 'border-[var(--clay)] bg-[var(--clay-soft)]'
          : 'border-[var(--line)] bg-[var(--paper-sunken)]',
        disabled && 'opacity-60',
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-[18px] w-[34px] shrink-0 border-2',
          checked
            ? 'border-[var(--clay-deep)] bg-[var(--clay)]'
            : 'border-[var(--line-strong)] bg-[var(--paper-deep)]',
          disabled ? 'cursor-not-allowed' : 'cursor-pointer',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'absolute top-0 h-[14px] w-[14px] border-2 transition-[left] duration-75',
            checked
              ? 'left-[16px] border-[var(--clay-deep)] bg-[var(--paper-hi)]'
              : 'left-0 border-[var(--line-strong)] bg-[var(--paper-raised)]',
          )}
          style={{ position: 'absolute' }}
        />
      </button>

      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="min-w-0 flex-1 text-left"
        tabIndex={-1}
      >
        <span
          className={cn(
            'block text-[12.5px] font-semibold leading-tight',
            checked ? 'text-[var(--ink)]' : 'text-[var(--ink-2)]',
          )}
        >
          {label}
        </span>
        <span className="mt-0.5 block text-[11px] leading-snug text-[var(--ink-2)]">{hint}</span>
      </button>
    </div>
  );
}

export default PatternSettings;

/**
 * 画板校准：居中 / 放大。
 *
 * 为什么两个按钮要并排且各带一句说明：它们唯一的区别是"图案大小变不变"，
 * 而这恰恰是用户唯一会搞混的地方。说明直接写进按钮下方而不是 tooltip ——
 * 手机上根本没有 hover。
 *
 * 只做整数倍放大是硬约束：拼豆是手摆的，1.4 倍会让一半源列映射到 1 列、
 * 一半映射到 2 列，实物上一眼就是坏的。宁可留白。
 */
function CanvasCalibrateRow({
  onCenter,
  onScaleToFit,
  disabled,
}: {
  onCenter: () => void;
  onScaleToFit: () => void;
  disabled: boolean;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-semibold text-[var(--ink)]">画板校准</span>
        <span className="font-px text-[9px] tracking-[0.14em] text-[var(--ink-3)]">
          不改颜色
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          onClick={onCenter}
          disabled={disabled}
          title="只是平移，图案大小不变"
          className="px-btn px-btn-sm disabled:opacity-40"
        >
          <AlignCenter className="h-3 w-3" aria-hidden />
          居中
        </button>
        <button
          type="button"
          onClick={onScaleToFit}
          disabled={disabled}
          title="整数倍放大到铺满画板，图案会变大"
          className="px-btn px-btn-sm disabled:opacity-40"
        >
          <Maximize2 className="h-3 w-3" aria-hidden />
          放大约到边
        </button>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--ink-3)]">
        居中只挪位置；放大把每颗豆变成 2×2、3×3 块，零空洞零锯齿。
      </p>
    </div>
  );
}
