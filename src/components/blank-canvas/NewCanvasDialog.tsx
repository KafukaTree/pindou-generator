'use client';

/**
 * 新建空白画布的对话框
 * ===============================================================
 * 为什么要有这个弹窗，而不是直接把"新建空白画布"做成一个按钮了事：
 * 空白画布最先要定的是**尺寸** —— 而尺寸是这个产品里唯一"错了就得全部
 * 重来"的参数。一颗豆 5mm，29×29 是 14.5cm 的单板挂件，96×96 是 48cm
 * 的挂画；涂了半小时才发现选错尺寸，等于白干。所以尺寸必须在落笔之前
 * 明确确认一次。
 *
 * 三个入口都要给：
 *   1. 常用底板尺寸（拼豆板是固定规格，绝大多数人直接选这些）；
 *   2. 手动输入行列（复刻别人的图纸时，行列数是硬约束）；
 *   3. 当前参数的默认值（用户已经调好 64 格，新建时不该又跳回 29）。
 *
 * 视觉上沿用工作台的纸面板语言（方角 + 硬投影 + 2px 边框），不用 shadcn
 * 默认的圆角卡片 —— 这个产品的每一个面都是方的，弹窗圆一下会显得是别人家的。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Grid2x2, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { BRANDS, BRAND_META, type Brand } from '@/lib/color/palette';
import {
  BLANK_MAX,
  BLANK_MIN,
  BLANK_PRESETS,
  clampBlank,
} from '@/lib/pattern/blank';
import { estimateSizeCm } from '@/lib/pattern/generate';
import { cn } from '@/lib/utils';

export interface NewCanvasDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 新建时采用的默认行列（一般传当前 gridSize / 当前图纸尺寸） */
  defaultCols: number;
  defaultRows: number;
  /** 新建时采用的默认品牌 */
  defaultBrand: Brand;
  /** 用户确认后回调：只回尺寸与品牌，图纸由父组件造 */
  onCreate: (cols: number, rows: number, brand: Brand) => void;
  /**
   * 会被覆盖掉的现有工作提示（比如"当前这张 29×29 已经画了 37 格"）。
   * 有值时在按钮上方亮一条警示 —— 新建 = 换掉当前图纸，这一点必须在
   * 按下去之前说清楚，而不是让用户事后发现画的东西没了。
   */
  replaceWarning?: string | null;
}

/** 拼豆尺寸换算：一颗豆 5mm。放在这里而不是 import，是为了让卡片能自己算 */
function cmText(cols: number, rows: number): string {
  const { w, h } = estimateSizeCm(cols, rows);
  return `${w} × ${h} cm`;
}

export function NewCanvasDialog({
  open,
  onOpenChange,
  defaultCols,
  defaultRows,
  defaultBrand,
  onCreate,
  replaceWarning,
}: NewCanvasDialogProps) {
  const [cols, setCols] = useState(defaultCols);
  const [rows, setRows] = useState(defaultRows);
  const [brand, setBrand] = useState<Brand>(defaultBrand);

  /*
   * 每次打开都用最新的默认值重置。
   *
   * 只在 open 变 true 时重置，而不是把 defaultCols 放进依赖 —— 否则用户
   * 正在输入 96，父组件因为别的原因重渲染导致 defaultCols 变了，输入框
   * 会被当场改掉。弹窗一开就定住，这是表单类弹窗的常规做法。
   */
  useEffect(() => {
    if (!open) return;
    setCols(clampBlank(defaultCols));
    setRows(clampBlank(defaultRows));
    setBrand(defaultBrand);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const totalCells = cols * rows;
  const size = useMemo(() => estimateSizeCm(cols, rows), [cols, rows]);

  const submit = useCallback(() => {
    onCreate(cols, rows, brand);
    onOpenChange(false);
  }, [cols, rows, brand, onCreate, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[88vh] w-[min(520px,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden rounded-none border-2 border-[var(--line-strong)] bg-[var(--paper-raised)] p-0 shadow-[var(--shadow-px-lg)]"
      >
        <DialogHeader className="space-y-0 border-b-2 border-[var(--line)] px-3.5 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <DialogTitle className="flex items-center gap-2 text-[14px] font-semibold text-[var(--ink)]">
              <span className="px-section-no" aria-hidden>
                00
              </span>
              新建空白画布
            </DialogTitle>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="关闭新建画布对话框"
              className="px-btn px-btn-sm px-btn-ghost !px-1.5"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </DialogHeader>

        <div className="max-h-[calc(88vh-56px)] overflow-y-auto px-3.5 py-3.5">
          {/* ---------- 尺寸预设 ---------- */}
          <p className="text-[11.5px] leading-relaxed text-[var(--ink-2)]">
            选一块空板子，进去之后用画笔一格一格涂。
            <span className="text-[var(--ink-3)]">（一颗豆 5mm，尺寸按格子数折算）</span>
          </p>

          <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {BLANK_PRESETS.map((preset) => {
              const active = cols === preset.cols && rows === preset.rows;
              return (
                <button
                  key={preset.label}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setCols(preset.cols);
                    setRows(preset.rows);
                  }}
                  className={cn(
                    'flex flex-col items-start gap-0.5 border-2 px-2 py-1.5 text-left transition-[background-color,box-shadow] duration-75',
                    active
                      ? 'border-[var(--clay-deep)] bg-[var(--clay)] text-[var(--on-clay)] shadow-[inset_0_2px_0_0_rgba(0,0,0,0.22)]'
                      : 'border-[var(--line-strong)] bg-[var(--paper-hi)] text-[var(--ink)] shadow-[0_2px_0_0_var(--line-strong)] hover:bg-[var(--paper-hi)]',
                  )}
                >
                  <span className="text-[12.5px] font-semibold leading-tight tabular-nums">
                    {preset.label}
                  </span>
                  <span
                    className={cn(
                      'text-[10.5px] leading-tight tabular-nums',
                      active ? 'opacity-85' : 'text-[var(--ink-2)]',
                    )}
                  >
                    {preset.note} · {cmText(preset.cols, preset.rows)}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="px-rule my-3.5" />

          {/* ---------- 手动行列 ---------- */}
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="font-px text-[9.5px] uppercase tracking-[0.16em] text-[var(--ink-3)]">
                列数
              </span>
              <input
                type="number"
                min={BLANK_MIN}
                max={BLANK_MAX}
                value={cols}
                onChange={(e) => setCols(clampBlank(Number(e.target.value)))}
                className="px-input w-[86px] text-[13px] tabular-nums"
                aria-label="画布列数"
              />
            </label>
            <span className="pb-2 text-[13px] text-[var(--ink-3)]">×</span>
            <label className="flex flex-col gap-1">
              <span className="font-px text-[9.5px] uppercase tracking-[0.16em] text-[var(--ink-3)]">
                行数
              </span>
              <input
                type="number"
                min={BLANK_MIN}
                max={BLANK_MAX}
                value={rows}
                onChange={(e) => setRows(clampBlank(Number(e.target.value)))}
                className="px-input w-[86px] text-[13px] tabular-nums"
                aria-label="画布行数"
              />
            </label>
            <div className="pb-1.5">
              <p className="text-[12.5px] font-semibold tabular-nums text-[var(--ink)]">
                {totalCells.toLocaleString('en-US')} 格
              </p>
              <p className="mt-0.5 text-[11.5px] tabular-nums text-[var(--ink-2)]">
                约 {size.w} × {size.h} cm
              </p>
            </div>
            <span className="ml-auto pb-1.5 font-px text-[9px] tracking-[0.14em] text-[var(--ink-3)]">
              {BLANK_MIN}–{BLANK_MAX}
            </span>
          </div>

          <div className="px-rule my-3.5" />

          {/* ---------- 品牌 ---------- */}
          <div>
            <p className="mb-1.5 text-[11.5px] font-semibold text-[var(--ink)]">色号体系</p>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {BRANDS.map((b) => {
                const active = brand === b;
                return (
                  <button
                    key={b}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setBrand(b)}
                    title={BRAND_META[b].note}
                    className={cn(
                      'border-2 px-2 py-1.5 text-[12px] font-semibold transition-colors duration-75',
                      active
                        ? 'border-[var(--clay-deep)] bg-[var(--clay)] text-[var(--on-clay)]'
                        : 'border-[var(--line-strong)] bg-[var(--paper-hi)] text-[var(--ink)] hover:bg-[var(--paper-raised)]',
                    )}
                  >
                    {BRAND_META[b].label}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--ink-3)]">
              决定了画笔色卡能选哪些色号；进去之后也能在参数里换。
            </p>
          </div>

          {/* ---------- 动作 ---------- */}
          {replaceWarning && (
            <div className="mt-3 flex items-start gap-1.5 border-2 border-[var(--berry)] bg-[var(--berry-soft)] px-2 py-1.5">
              <span
                aria-hidden
                className="mt-[3px] inline-block h-1.5 w-1.5 shrink-0 bg-[var(--berry)]"
              />
              <p className="text-[11.5px] leading-relaxed text-[var(--ink)]">{replaceWarning}</p>
            </div>
          )}
          <div className="mt-4 flex items-center justify-end gap-2 border-t-2 border-[var(--line)] pt-3">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="px-btn px-btn-sm"
            >
              取消
            </button>
            <button
              type="button"
              onClick={submit}
              className="px-btn px-btn-primary px-btn-sm"
            >
              <Grid2x2 className="h-3.5 w-3.5" aria-hidden />
              建一张 {cols} × {rows}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
