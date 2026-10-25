'use client';

import { useState } from 'react';
import {
  History as HistoryIcon,
  Trash2,
  RotateCcw,
  Clock,
  X,
  Layers,
  Sparkles,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useHistory, type HistoryItem, type HistoryVersion } from '@/hooks/useHistory';
import { BRAND_META } from '@/lib/color/palette';
import { DETAIL_META, type DetailAlgorithm } from '@/lib/pattern/detail';
import { cn } from '@/lib/utils';

/**
 * 历史记录
 * ===============================================================
 * 这一块原来最大的问题是**风格断层**：用了 shadcn 默认的 Dialog，
 * 圆角 + 柔和阴影 + 系统字体，跟周围的像素面板完全不是一套东西。
 * 现在 DialogContent 被强制覆盖成：方角（rounded-none）、
 * `bg-[var(--paper-raised)]`、`shadow-[var(--shadow-px-lg)]`、
 * 2px 硬边框，关掉默认的 X 换成自绘像素按钮。
 *
 * v3 新增**版本时间线**：
 *
 * - `versions.length === 1` 时，列表项与 v2 **完全一致**（零回归）；
 * - `> 1` 时多一个"共 N 版"徽标 + 展开箭头，展开后是纯文字的版本行；
 * - **点版本行 = 直接恢复该版本**，不需要"先选中再点恢复"两步。
 *
 * 为什么版本行不放缩略图：3 个版本各放一个缩略图要占 400px 高，
 * 而用户对"同一张图的微小差异"靠缩略图根本分辨不出来 ——
 * 他要看的是**参数差异**（网格 64 还是 96）。想比视觉就点恢复直接看画布。
 */

export interface HistoryListProps {
  /** 不传 version = 恢复最新版本（完全向后兼容 v2 的调用方式） */
  onRestore: (item: HistoryItem, version?: HistoryVersion) => void;
  className?: string;
}

/** 相对时间：只做到"天"这一级，再久就直接给日期 */
function formatRelative(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;

  const hour = Math.floor(min / 60);
  const today = new Date(now);
  const that = new Date(ts);
  const sameDay =
    today.getFullYear() === that.getFullYear() &&
    today.getMonth() === that.getMonth() &&
    today.getDate() === that.getDate();
  if (sameDay) return `${hour} 小时前`;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    yesterday.getFullYear() === that.getFullYear() &&
    yesterday.getMonth() === that.getMonth() &&
    yesterday.getDate() === that.getDate();
  if (isYesterday) return '昨天';

  if (hour < 24 * 7) return `${Math.floor(hour / 24)} 天前`;

  const y = that.getFullYear();
  const m = `${that.getMonth() + 1}`.padStart(2, '0');
  const d = `${that.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 版本行上的一句话参数摘要：网格 + 色数 + 精细度档 */
function versionSummary(v: HistoryVersion): string {
  const detail = DETAIL_META[(v.settings.detail ?? 'balanced') as DetailAlgorithm];
  return `网格 ${v.settings.gridSize} · ${v.colorCount} 色 · ${detail?.short ?? '均衡'}`;
}

/** 完整参数，挂在 title 上供 hover 深挖，不占版面 */
function versionTitle(v: HistoryVersion): string {
  const s = v.settings;
  const brand = BRAND_META[s.brand]?.label ?? s.brand;
  const detail = DETAIL_META[(s.detail ?? 'balanced') as DetailAlgorithm];
  return [
    `网格 ${s.gridSize}`,
    `${s.colorLimit} 色上限`,
    brand,
    s.fit === 'cover' ? '填满裁切' : '完整放入',
    s.dither ? '抖动开' : '抖动关',
    s.background === 'ignore' ? '忽略背景' : '保留背景',
    detail?.label ?? '均衡',
  ].join(' · ');
}

export function HistoryList({ onRestore, className }: HistoryListProps) {
  const { history, isLoaded, removeFromHistory, clearHistory } = useHistory();
  const [isOpen, setIsOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  /** 展开的版本时间线（存 item.id，同一时刻可展开多条） */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // isLoaded 之前不渲染，避免"先闪一下空态再跳出 12 条"的抖动
  if (!isLoaded) {
    return (
      <span
        className={cn('inline-block text-[11px] text-[var(--ink-2)]', className)}
        aria-hidden
      >
        历史加载中
      </span>
    );
  }

  const handleClear = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      // 3 秒内不确认就自动收起，避免一直停在"确定吗"状态
      window.setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    clearHistory();
    setConfirmClear(false);
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        setIsOpen(next);
        if (!next) {
          setConfirmClear(false);
          setExpanded(new Set());
        }
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn('px-btn px-btn-sm', className)}
          aria-label={`打开历史记录，共 ${history.length} 条`}
        >
          <HistoryIcon className="h-3.5 w-3.5" aria-hidden />
          历史
          <span className="ml-1 text-[11px] tabular-nums opacity-80">{history.length}</span>
        </button>
      </DialogTrigger>

      <DialogContent
        showCloseButton={false}
        className={cn(
          // 覆盖 shadcn 默认：方角、硬投影、纸面板底、2px 边框
          'max-h-[86vh] w-[min(560px,calc(100vw-2rem))] max-w-none gap-0 rounded-none border-2 border-[var(--line-strong)] bg-[var(--paper-raised)] p-0 shadow-[var(--shadow-px-lg)]',
        )}
      >
        <DialogHeader className="space-y-0 border-b-2 border-[var(--line)] px-3.5 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <DialogTitle className="flex items-center gap-2 text-[14px] font-semibold text-[var(--ink)]">
              历史记录
              <span className="text-[11.5px] tabular-nums text-[var(--ink-2)]">
                {history.length}
              </span>
            </DialogTitle>

            <div className="flex items-center gap-1.5">
              {history.length > 0 ? (
                <button
                  type="button"
                  onClick={handleClear}
                  className={cn(
                    'px-btn px-btn-sm',
                    confirmClear
                      ? '!border-[var(--bloom)] !bg-[var(--bloom)] !text-[var(--paper-hi)]'
                      : 'px-btn-danger',
                  )}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  {confirmClear ? '确认清空' : '清空'}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                aria-label="关闭历史记录"
                className="px-btn px-btn-sm px-btn-ghost !px-1.5"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          </div>
        </DialogHeader>

        {history.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="max-h-[calc(86vh-58px)] space-y-1.5 overflow-y-auto p-2.5">
            {history.map((item) => (
              <li key={item.id}>
                <HistoryRow
                  item={item}
                  isExpanded={expanded.has(item.id)}
                  onToggleExpand={() => toggleExpanded(item.id)}
                  onRestore={(version) => {
                    onRestore(item, version);
                    setIsOpen(false);
                  }}
                  onDelete={() => removeFromHistory(item.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 列表行（默认收起时与 v2 视觉完全一致）
// ---------------------------------------------------------------------------

function HistoryRow({
  item,
  isExpanded,
  onToggleExpand,
  onRestore,
  onDelete,
}: {
  item: HistoryItem;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onRestore: (version?: HistoryVersion) => void;
  onDelete: () => void;
}) {
  const brandLabel = BRAND_META[item.settings.brand]?.label ?? item.settings.brand;
  const versionCount = item.versions.length;
  const hasVersions = versionCount > 1;

  return (
    <div className="group border-2 border-[var(--line)] bg-[var(--paper)] transition-colors duration-75 hover:border-[var(--line-strong)]">
      <div className="flex items-stretch gap-2 p-1.5">
        {/* 缩略图：棋盘底 + contain */}
        <div className="px-checker flex h-[68px] w-[68px] shrink-0 items-center justify-center border border-[var(--line)] p-1">
          {item.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.previewUrl}
              alt={`${brandLabel} ${item.cols}×${item.rows} 图案缩略图`}
              className="max-h-full max-w-full object-contain"
              style={{ imageRendering: 'pixelated' }}
            />
          ) : (
            <Layers className="h-4 w-4 text-[var(--ink-3)]" aria-hidden />
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col justify-between gap-1">
          {/* 设置摘要：品牌 · 行列 · 色数 · 颗数 */}
          <div className="min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[12.5px] font-semibold text-[var(--ink)]">
                {brandLabel}
                <span className="ml-1.5 text-[11.5px] font-normal tabular-nums text-[var(--ink-2)]">
                  {item.cols}×{item.rows}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--ink-2)]">
                <Clock className="h-3 w-3" aria-hidden />
                {formatRelative(item.timestamp)}
              </span>
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="px-tag px-tag-sky !px-1.5 !py-0.5 !text-[10.5px]">
                {item.colorCount} 色
              </span>
              <span className="text-[11.5px] tabular-nums text-[var(--ink-2)]">
                {item.totalBeads.toLocaleString('en-US')}
                <span className="ml-0.5">颗</span>
              </span>
              <span className="px-label text-[10.5px] tracking-normal text-[var(--ink-2)]">
                {item.settings.fit === 'cover' ? 'CROP' : 'FIT'}
                {item.settings.dither ? ' · DITHER' : ''}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onRestore()}
              className="px-btn px-btn-sm px-btn-primary !py-1 !text-[11.5px]"
            >
              <RotateCcw className="h-3 w-3" aria-hidden />
              恢复
            </button>

            {/* 版本徽标与删除都靠右，避免"恢复"被拉成一条占满整行的色带 */}
            <div className="ml-auto flex items-center gap-1.5">
              {/* 只有多于 1 版才出现，保证单版零回归 */}
              {hasVersions ? (
                <button
                  type="button"
                  onClick={onToggleExpand}
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? '收起' : '展开'} ${versionCount} 个版本`}
                  className="px-btn px-btn-sm !gap-1 !px-1.5 !py-1"
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3 w-3" aria-hidden />
                  ) : (
                    <ChevronRight className="h-3 w-3" aria-hidden />
                  )}
                  <span className="tabular-nums">共 {versionCount} 版</span>
                </button>
              ) : null}

              <button
                type="button"
                onClick={onDelete}
                aria-label="删除这条历史"
                className="px-btn px-btn-sm px-btn-danger !px-1.5 !py-1"
              >
                <Trash2 className="h-3 w-3" aria-hidden />
              </button>
            </div>
          </div>
        </div>
      </div>

      {hasVersions && isExpanded ? (
        <VersionTimeline item={item} onRestore={onRestore} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 版本时间线（纯文字，一行一版）
// ---------------------------------------------------------------------------

function VersionTimeline({
  item,
  onRestore,
}: {
  item: HistoryItem;
  onRestore: (version?: HistoryVersion) => void;
}) {
  const latest = item.versions[item.versions.length - 1];

  return (
    <div className="border-t-2 border-[var(--line)] bg-[var(--paper-sunken)] px-1.5 py-1.5">
      <div className="mb-1 flex items-baseline justify-between px-1">
        <span className="px-label text-[10px] text-[var(--ink-2)]">版本时间线</span>
        <span className="text-[10.5px] text-[var(--ink-2)]">点一行直接恢复该版本</span>
      </div>

      <ul className="space-y-1">
        {item.versions.map((v, i) => {
          const isCurrent = v.id === latest.id;
          return (
            <li key={v.id}>
              <button
                type="button"
                onClick={() => onRestore(v)}
                title={versionTitle(v)}
                className={cn(
                  'flex w-full items-center gap-2 border-l-2 px-1.5 py-1 text-left transition-colors duration-75',
                  isCurrent
                    ? 'border-l-[var(--clay)] bg-[var(--clay-soft)]'
                    : 'border-l-transparent bg-[var(--paper)] hover:bg-[var(--paper-hi)]',
                )}
              >
                <span
                  className={cn(
                    'px-code shrink-0 text-[10.5px]',
                    isCurrent ? 'text-[var(--ink)]' : 'text-[var(--ink-2)]',
                  )}
                >
                  v{i + 1}
                </span>
                <span
                  className={cn(
                    'truncate text-[11.5px]',
                    isCurrent ? 'font-semibold text-[var(--ink)]' : 'text-[var(--ink)]',
                  )}
                >
                  {versionSummary(v)}
                </span>
                <span className="ml-auto shrink-0 text-[10.5px] text-[var(--ink-2)]">
                  {formatRelative(v.timestamp)}
                </span>
                {isCurrent ? (
                  <span className="px-tag px-tag-clay shrink-0 !px-1 !py-0 !text-[9.5px]">
                    当前
                  </span>
                ) : (
                  <RotateCcw
                    className="h-3 w-3 shrink-0 text-[var(--ink-2)]"
                    aria-hidden
                  />
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 空态
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-9 text-center">
      {/* 用像素小方块堆一个"空相框"，比一个灰色大图标有设计感 */}
      <div
        className="relative grid grid-cols-4 gap-1 border-2 border-dashed border-[var(--line-strong)] bg-[var(--paper-sunken)] p-2.5"
        aria-hidden
      >
        {Array.from({ length: 16 }).map((_, i) => (
          <span
            key={i}
            className={cn(
              'h-3 w-3',
              (i * 7) % 5 === 0
                ? 'bg-[var(--paper-deep)]'
                : i % 3 === 0
                  ? 'bg-[var(--clay-soft)]'
                  : 'bg-transparent border border-[var(--line)]',
            )}
          />
        ))}
      </div>

      <div className="space-y-1">
        <p className="px-section-title text-[13px]">还没有历史记录</p>
        <p className="max-w-[260px] text-[12px] leading-relaxed text-[var(--ink-2)]">
          生成一张图案后会自动存一条。同一张图调过的多套参数会收进「版本」里，随时可以翻回去。
        </p>
      </div>

      <span className="px-tag px-tag-gold">
        <Sparkles className="h-3 w-3" aria-hidden />
        最多保存 12 张图
      </span>
    </div>
  );
}

export default HistoryList;
