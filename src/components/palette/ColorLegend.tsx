'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, Palette as PaletteIcon } from 'lucide-react';
import type { UsedColor } from '@/lib/pattern/generate';
import type { Brand } from '@/lib/color/palette';
import { cn } from '@/lib/utils';

/**
 * 用料清单（ColorLegend）
 * ===============================================================
 * 这是拼豆流程里**最实用**的一块：用户真正在店里/淘宝下单时要的是
 * "哪个色号、买多少颗"，而不是一张漂亮的预览图。
 *
 * 几个决定：
 *
 * - **不重排 palette**。引擎已经按用量降序返回，这里再 sort 一次不仅
 *   白费，还可能因为 `ratio` 相等时排序不稳定而让高亮行跳动。
 *
 * - **进度条用该色本身**，轨道用 paper-sunken。看一条就知道这个颜色
 *   在图里占多大面积；用统一的强调色反而丢信息。
 *
 * - **建议备货 = ceil(count * 1.1 / 10) * 10**。拼豆损耗来自掉豆、
 *   拼错、缺角，10% 是社区里常用的余量；再向上取整到 10 颗，因为
 *   店家通常按 10 颗/小包或整包卖。宁可多买几颗，也别拼到 90% 发现
 *   差 3 颗同色。
 */

export interface ColorLegendProps {
  palette: UsedColor[];
  brand: Brand;
  totalBeads: number;
  /**
   * 填满父容器：用于"用料清单独占一栏"的工作台布局。
   * 打开后整块变成 flex 列、清单区吃掉剩余高度自己滚，
   * 而不是缩在一个 336px 的小窗口里 —— 后者在长清单上要滚两次
   * （外层滚一次、内层滚一次），用起来很别扭。
   */
  fill?: boolean;
  className?: string;
}

/** 超过这个颗数就提示评估尺寸（一张 A4 图纸大约也就几千颗的量级） */
const LARGE_BEAD_THRESHOLD = 5000;

function suggestPurchase(count: number): number {
  return Math.ceil((count * 1.1) / 10) * 10;
}

function formatRatio(ratio: number): string {
  const pct = ratio * 100;
  // 小于 1% 时用一位小数，否则整数就够——避免出现 "0%" 这种迷惑显示
  return pct < 1 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

export function ColorLegend({
  palette,
  brand,
  totalBeads,
  fill = false,
  className,
}: ColorLegendProps) {
  // 高亮用一种颜色：再点一次取消。用 id 而不是 index 作为 key，删改更稳。
  const [activeCode, setActiveCode] = useState<string | null>(null);

  const total = useMemo(
    () => (totalBeads > 0 ? totalBeads : palette.reduce((sum, c) => sum + c.count, 0)),
    [palette, totalBeads],
  );

  // 空清单直接不占版面（父组件可能还没生成图案）
  if (palette.length === 0) return null;

  const isLarge = total > LARGE_BEAD_THRESHOLD;

  return (
    <div
      className={cn(
        'space-y-2',
        fill && 'flex h-full min-h-0 flex-col space-y-0',
        className,
      )}
    >
      {/* ---------- 顶部汇总 ---------- */}
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="px-section-title">用料清单</h3>
        </div>
        <span className="px-label text-[11px] tracking-normal text-[var(--ink-2)]">{brand}</span>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[13px] font-semibold tabular-nums text-[var(--ink)]">
          {palette.length}
          <span className="ml-0.5 text-[12px] font-normal text-[var(--ink-2)]">色</span>
        </span>
        <span className="text-[var(--ink-3)]" aria-hidden>
          ·
        </span>
        <span className="text-[13px] font-semibold tabular-nums text-[var(--ink)]">
          {total.toLocaleString('en-US')}
          <span className="ml-0.5 text-[12px] font-normal text-[var(--ink-2)]">颗</span>
        </span>
        {isLarge ? (
          <span className="px-tag px-tag-gold" title="颗数越多，拼装时间与成本越高">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            建议先评估成品尺寸
          </span>
        ) : null}
      </div>

      {isLarge ? (
        <p className="text-[12px] leading-snug text-[var(--ink-2)]">
          颗粒数较多，建议评估成品尺寸与拼装时间后再开始。
        </p>
      ) : null}

      <div className={cn('px-rule', fill && 'mt-2 shrink-0')} />

      {/* ---------- 颜色行 ---------- */}
      <ul
        className={cn(
          'space-y-1 pr-1',
          fill
            ? 'mt-2 min-h-0 flex-1 overflow-y-auto'
            : 'max-h-[336px] overflow-y-auto',
        )}
        aria-label="颜色用料明细"
      >
        {palette.map((color) => {
          const active = activeCode === color.code;
          const purchase = suggestPurchase(color.count);
          return (
            <li key={`${color.code}-${color.index}`}>
              <button
                type="button"
                onClick={() => setActiveCode(active ? null : color.code)}
                aria-pressed={active}
                aria-label={`色号 ${color.code}，${color.hex}，${color.count} 颗，占 ${formatRatio(
                  color.ratio,
                )}`}
                className={cn(
                  'group flex w-full items-start gap-2 border-l-2 px-1.5 py-1.5 text-left transition-colors duration-75',
                  active
                    ? 'border-l-[var(--clay)] bg-[var(--clay-soft)]'
                    : 'border-l-transparent hover:bg-[var(--paper-hi)]',
                )}
              >
                {/* 色块：1px 描边让它从纸面浮出来，不然浅色块会糊进背景 */}
                <span
                  aria-hidden
                  className="mt-0.5 h-6 w-6 shrink-0 border border-[var(--line-strong)]"
                  style={{ backgroundColor: color.hex }}
                />

                <span className="min-w-0 flex-1">
                  {/* 第一行：色号 + HEX + 颗数/占比
                      可读性约定（实测过 9–16px 各档位）：
                      - 像素字体只承担"短码"（A01 / MARD），13px 且 letter-spacing 归零。
                        Silkscreen 自带字距，叠 .px-code 的 0.02em 会让 8/6/9 粘在一起。
                      - 计数类数字（864、3,600、24%）改用 --font-ui + tabular-nums：
                        像素字体的 6/8/9 在 11px 以下几乎无法区分，而这里数字必须一眼读准。 */}
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span className="px-code shrink-0 text-[13px] tracking-normal text-[var(--ink)]">
                        {color.code}
                      </span>
                      <span
                        className="shrink-0 text-[11.5px] font-normal tracking-[0.02em] text-[var(--ink-2)]"
                        style={{
                          fontFamily: 'ui-monospace, "SF Mono", Menlo, "Courier New", monospace',
                        }}
                      >
                        {color.hex.toUpperCase()}
                      </span>
                    </span>
                    <span className="shrink-0 whitespace-nowrap text-[13px] font-semibold tabular-nums text-[var(--ink)]">
                      {color.count.toLocaleString('en-US')}
                      <span className="ml-0.5 text-[11px] font-normal text-[var(--ink-2)]">颗</span>
                      <span className="ml-1.5 text-[11px] font-normal text-[var(--ink-2)]">
                        {formatRatio(color.ratio)}
                      </span>
                    </span>
                  </span>

                  {/* 第二行：像素进度条。填色用该色本身，但浅色（如 #FAF4C8）
                      在纸面上几乎看不见，所以给填充块一圈半透明深边兜住轮廓。 */}
                  <span
                    className="mt-1 flex h-[7px] w-full border border-[var(--line-strong)] bg-[var(--paper-sunken)]"
                    aria-hidden
                  >
                    <span
                      className="block h-full"
                      style={{
                        width: `${Math.max(3, Math.min(100, color.ratio * 100))}%`,
                        backgroundColor: color.hex,
                        // 用主题变量而不是写死棕色：主色从陶土橙改成玫瑰粉后，
                        // 写死的 rgba(67,47,30) 会跟纸面打架。
                        boxShadow: 'inset 0 0 0 1px var(--line-strong)',
                      }}
                    />
                  </span>

                  {/* 第三行：建议备货（小字，hover 有规则说明） */}
                  <span
                    className="mt-0.5 block text-[11px] leading-tight text-[var(--ink-2)]"
                    title="按用量 ×1.1 留损耗，再向上取整到 10 颗"
                  >
                    建议备货 <span className="font-semibold tabular-nums">{purchase}</span> 颗
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className={cn(
        'flex items-center gap-1 border-t border-dashed border-[var(--line)] pt-1.5 text-[11px] leading-snug text-[var(--ink-2)]',
        fill && 'mt-2 shrink-0',
      )}>
        <PaletteIcon className="h-3 w-3 shrink-0" aria-hidden />
        建议备货含约 10% 损耗，已向上取整到 10 颗。
      </p>
    </div>
  );
}

export default ColorLegend;
