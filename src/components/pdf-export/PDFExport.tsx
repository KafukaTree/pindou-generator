'use client';

import { useCallback, useMemo, useState, type JSX } from 'react';
import { Download, FileImage, FileType2, Loader2, ShieldCheck, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { PatternResult } from '@/lib/pattern/generate';
import type { Brand } from '@/lib/color/palette';

/**
 * 图纸导出按钮 + 格式选择弹窗
 * ---------------------------------------------------------------------------
 * 组件只负责三件事：
 *   1. 把 PatternResult 序列化成 API 契约；
 *   2. 让用户选格式（PDF / PNG / SVG）；
 *   3. 触发下载、给 loading 与错误反馈。
 *
 * 排版全在 /api/pdf 里做。三种格式的分工：
 *   - **PDF**：分页图纸（每页一块 + 重叠行列 + 全局标尺），适合打印照着摆豆子。
 *   - **PNG**：单张整图，格内印色号，适合发群/存手机。栅格化到 ~3400px 长边，
 *     单格约 30px，色号依然清楚；超出这个尺寸的图会自动退到"大色块标一次"。
 *   - **SVG**：单张矢量图，无论放大多少倍色号都锐利，适合再编辑或印大幅面。
 *
 * 关键点：
 * - cells 是 Int16Array，必须 Array.from 转普通数组，否则 JSON.stringify 成对象。
 * - palette 里的 index 是"图案调色板下标"，cells 存的是它；上传前压缩成
 *   连续数组并重映射，避免稀疏 palette 让 API 侧的 [-1, len-1] 校验失败。
 * - 失败走 sonner toast.error，并在弹窗里保留一行可读错误文本。
 */

interface PDFExportProps {
  pattern: PatternResult | null;
  brand: Brand;
  /**
   * 紧凑模式：只留一个图标按钮，用于顶栏这类空间紧张的地方。
   * 失败信息仍然通过 toast 提示，不在按钮下面再占一行 ——
   * 顶栏里多出一行会导致整排按钮错位。
   */
  compact?: boolean;
  className?: string;
}

type ExportFormat = 'pdf' | 'png' | 'svg';

interface SerializedPattern {
  cols: number;
  rows: number;
  cells: number[];
  palette: Array<{ hex: string; code: string; count: number; ratio: number }>;
  totalBeads: number;
}

interface FormatOption {
  format: ExportFormat;
  label: string;
  extension: string;
  icon: typeof FileType2;
  /** 弹窗里的一句话说明 */
  blurb: string;
  /** 单独一行的小字，讲"什么时候该选它" */
  hint: string;
  /** 估算出来的输出描述（尺寸 / 页数 / 体积级别） */
  meta: (pattern: PatternResult | null) => string;
  /** 主推格式：描边更重，放最前面 */
  primary?: boolean;
}

function serialize(pattern: PatternResult): SerializedPattern {
  const { cols, rows, cells, palette, totalBeads } = pattern;

  // 收集真正用到的 palette 下标（保持首次出现顺序由 palette 自身顺序决定）
  const usedIndices = new Set<number>();
  for (let i = 0; i < cells.length; i++) {
    const value = cells[i];
    if (value >= 0) usedIndices.add(value);
  }

  const source = palette.filter((entry) => usedIndices.has(entry.index));
  const positionOf = new Map<number, number>();
  source.forEach((entry, position) => positionOf.set(entry.index, position));

  const remapped = new Array<number>(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const value = cells[i];
    remapped[i] = value < 0 ? -1 : (positionOf.get(value) ?? -1);
  }

  const total = source.reduce((sum, entry) => sum + entry.count, 0) || totalBeads;

  return {
    cols,
    rows,
    cells: remapped,
    palette: source.map((entry) => ({
      hex: entry.hex,
      code: entry.code,
      count: entry.count,
      ratio: entry.ratio,
    })),
    totalBeads: total,
  };
}

/** 粗略估算 PDF 页数：封面 +（大图有总览）+ 图纸块 + 用料清单 + 图例 */
function estimatePdfPages(pattern: PatternResult | null): number {
  if (!pattern) return 0;
  const { cols, rows } = pattern;
  // 和 route.ts 的 planPages 同量级：约每页放 26~30 格，重叠 2
  const perPage = 28;
  const tilesX = Math.max(1, Math.ceil((cols - 2) / (perPage - 2)));
  const tilesY = Math.max(1, Math.ceil((rows - 2) / (perPage - 2)));
  const tiles = cols * rows <= 1500 ? 1 : tilesX * tilesY;
  const bom = 1 + Math.floor(pattern.palette.length / 26);
  return 1 + (tiles > 1 ? 1 : 0) + tiles + bom + 1;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const FORMATS: FormatOption[] = [
  {
    format: 'pdf',
    label: 'PDF 图纸',
    extension: 'pdf',
    icon: FileType2,
    blurb: 'A4 分页图纸，打印照着摆豆子',
    hint: '每页一块区域，带重叠行列和全局列号 / 行号标尺',
    primary: true,
    meta: (pattern) => (pattern ? `约 ${estimatePdfPages(pattern)} 页 A4` : ''),
  },
  {
    format: 'png',
    label: 'PNG 图片',
    extension: 'png',
    icon: FileImage,
    blurb: '整张图，格子里印着色号',
    hint: '适合发群、存手机，或贴进自己的笔记',
    meta: (pattern) => (pattern ? '约 3000 px 长边' : ''),
  },
  {
    format: 'svg',
    label: 'SVG 矢量',
    extension: 'svg',
    icon: ShieldCheck,
    blurb: '无损矢量，放大多少倍都不糊',
    hint: '适合印大幅面，或用设计软件继续改',
    meta: (pattern) => (pattern ? '矢量，可任意缩放' : ''),
  },
];

export function PDFExport({
  pattern,
  brand,
  compact = false,
  className,
}: PDFExportProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [busyFormat, setBusyFormat] = useState<ExportFormat | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const isGenerating = busyFormat !== null;

  /*
   * 空调色板也是不可导出的状态。
   *
   * 空白画布刚建出来时 palette 是空的，"一张什么都没画的板子"导出成
   * PDF 是一叠没有色号的空白格 —— 用户拿到会以为是导出失败。更实际的是
   * API 侧 `route.ts` 明确要求 palette 非空，会直接 400，用户看到的是
   * 一个错误弹窗而不是"你还没开始画"。
   *
   * 所以这里提前禁用，并把原因写进 title，比让他点一下撞墙好。
   */
  const emptyPalette = !pattern || pattern.palette.length === 0;
  const disabled = !pattern || pattern.cols < 1 || pattern.rows < 1 || emptyPalette;

  const sizeLabel = useMemo(() => {
    if (!pattern) return null;
    return `${pattern.cols} × ${pattern.rows}`;
  }, [pattern]);

  const handleExport = useCallback(
    async (format: ExportFormat) => {
      if (!pattern) {
        toast.error('还没有图纸可以导出，先放一张图。');
        return;
      }

      setBusyFormat(format);
      setErrorText(null);
      const startedAt = Date.now();

      try {
        const payload = serialize(pattern);

        const response = await fetch(`/api/pdf?format=${format}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...payload,
            brand,
            generatedAt: new Date().toISOString(),
          }),
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `导出失败（HTTP ${response.status}）`);
        }

        const blob = await response.blob();
        if (blob.size === 0) {
          throw new Error('返回内容为空，请重试。');
        }

        // 文件名优先用服务端 Content-Disposition（它带中文品牌名），
        // 拿不到就本地拼一个兜底。
        const disposition = response.headers.get('Content-Disposition') ?? '';
        const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
        const fallbackName = `perler-pattern-${brand}-${pattern.cols}x${pattern.rows}.${format}`;
        const filename = utf8Match ? decodeURIComponent(utf8Match[1]) : fallbackName;

        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        // 立刻 revoke 在部分浏览器会取消下载，延迟释放
        window.setTimeout(() => window.URL.revokeObjectURL(url), 4000);

        const label = FORMATS.find((entry) => entry.format === format)?.label ?? format;
        toast.success(`${label} 已导出：${sizeLabel}，${payload.palette.length} 个色号`, {
          description: `${formatBytes(blob.size)} · 用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
        });
        setOpen(false);
      } catch (error) {
        const message = error instanceof Error ? error.message : '导出失败，请重试。';
        setErrorText(message);
        toast.error(message);
      } finally {
        setBusyFormat(null);
      }
    },
    [brand, pattern, sizeLabel],
  );

  const triggerTitle = !pattern
    ? '先放一张图'
    : emptyPalette
      ? '还没上色 —— 先画几格再导出'
      : `导出图纸（${pattern.cols} × ${pattern.rows}，${pattern.palette.length} 个色号）`;

  const trigger = compact ? (
    <button
      type="button"
      onClick={() => setOpen(true)}
      disabled={disabled}
      className={cn('px-btn px-btn-primary px-btn-sm', className)}
      aria-label="导出图纸"
      title={triggerTitle}
    >
      <Download className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="hidden sm:inline">导出</span>
    </button>
  ) : (
    <button
      type="button"
      onClick={() => setOpen(true)}
      disabled={disabled}
      className={cn('px-btn px-btn-primary', className)}
      title={triggerTitle}
    >
      <Download className="h-4 w-4" aria-hidden="true" />
      导出图纸
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => (isGenerating ? undefined : setOpen(next))}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>

      <DialogContent
        showCloseButton={false}
        className={cn(
          // 覆盖 shadcn 默认：方角、硬投影、纸面板底、2px 边框 —— 与历史记录弹窗一致
          'max-h-[86vh] w-[min(520px,calc(100vw-2rem))] max-w-none gap-0 rounded-none border-2 border-[var(--line-strong)] bg-[var(--paper-raised)] p-0 shadow-[var(--shadow-px-lg)]',
        )}
      >
        <DialogHeader className="space-y-0 border-b-2 border-[var(--line)] px-3.5 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <DialogTitle className="flex items-center gap-2 text-[14px] font-semibold text-[var(--ink)]">
              导出图纸
              {sizeLabel && (
                <span className="text-[11.5px] font-normal tabular-nums text-[var(--ink-2)]">
                  {sizeLabel}
                  {pattern ? ` · ${pattern.palette.length} 色` : ''}
                </span>
              )}
            </DialogTitle>

            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={isGenerating}
              className="px-btn px-btn-sm px-btn-ghost"
              aria-label="关闭"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          <DialogDescription className="text-[11.5px] leading-snug text-[var(--ink-2)]">
            选择一种格式下载。需要打印照着摆豆子就选 PDF；只是发出去看或存手机选 PNG。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5 p-2.5">
          {FORMATS.map((option) => {
            const Icon = option.icon;
            const busy = busyFormat === option.format;
            const meta = option.meta(pattern);
            return (
              <button
                key={option.format}
                type="button"
                onClick={() => void handleExport(option.format)}
                disabled={isGenerating || disabled}
                aria-busy={busy}
                className={cn(
                  'group flex w-full items-start gap-2.5 border-2 px-2.5 py-2 text-left transition-colors',
                  'disabled:cursor-not-allowed disabled:opacity-55',
                  option.primary
                    ? 'border-[var(--line-strong)] bg-[var(--clay-soft)]/45 hover:bg-[var(--clay-soft)]'
                    : 'border-[var(--line)] bg-[var(--paper-hi)] hover:border-[var(--line-strong)]',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center border-2',
                    option.primary
                      ? 'border-[var(--clay)] bg-[var(--clay)] text-[var(--paper-hi)]'
                      : 'border-[var(--line-strong)] bg-[var(--paper-raised)] text-[var(--ink-2)]',
                  )}
                  aria-hidden
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Icon className="h-3.5 w-3.5" />
                  )}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-[13px] font-semibold text-[var(--ink)]">
                      {option.label}
                      {option.primary && (
                        <span className="ml-1.5 border border-[var(--clay)] px-1 py-px text-[9.5px] font-bold uppercase tracking-wide text-[var(--clay)]">
                          推荐
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--ink-3)]">
                      {busy ? '生成中…' : meta}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-snug text-[var(--ink)]">
                    {option.blurb}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-[var(--ink-2)]">
                    {option.hint}
                  </span>
                </span>
              </button>
            );
          })}

          {errorText && (
            <p
              role="alert"
              className="mt-0.5 border-l-2 border-[var(--berry)] pl-2 text-[11.5px] leading-snug text-[var(--berry)]"
            >
              {errorText}
            </p>
          )}

          <p className="mt-0.5 px-0.5 text-[10.5px] leading-snug text-[var(--ink-3)]">
            导出的图纸不包含画布背景；空白格在图纸上是留白，不拼豆。
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
