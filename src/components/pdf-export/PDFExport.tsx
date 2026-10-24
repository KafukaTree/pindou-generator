'use client';

import { useCallback, useMemo, useState, type JSX } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { PatternResult } from '@/lib/pattern/generate';
import type { Brand } from '@/lib/color/palette';

/**
 * PDF 图纸导出按钮
 * ---------------------------------------------------------------------------
 * 组件只负责把 PatternResult 序列化成 API 契约并触发下载；
 * 所有排版（分页、标尺、色号、用料清单）都在 /api/pdf 里做。
 *
 * 关键点：
 * - cells 是 Int16Array，必须 Array.from 转普通数组，否则 JSON.stringify 成对象。
 * - palette 里的 index 是"图案调色板下标"，cells 存的是它；上传前压缩成
 *   连续数组并重映射，避免稀疏 palette 让 API 侧的 [-1, len-1] 校验失败。
 * - 失败走 sonner toast.error，并在按钮下方保留一行可读错误文本。
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

interface SerializedPattern {
  cols: number;
  rows: number;
  cells: number[];
  palette: Array<{ hex: string; code: string; count: number; ratio: number }>;
  totalBeads: number;
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

export function PDFExport({
  pattern,
  brand,
  compact = false,
  className,
}: PDFExportProps): JSX.Element {
  const [isGenerating, setIsGenerating] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const disabled = !pattern || pattern.cols < 1 || pattern.rows < 1 || isGenerating;

  const sizeLabel = useMemo(() => {
    if (!pattern) return null;
    return `${pattern.cols} x ${pattern.rows}`;
  }, [pattern]);

  const handleExport = useCallback(async () => {
    if (!pattern) {
      toast.error('还没有图纸可以导出，先放一张图。');
      return;
    }

    setIsGenerating(true);
    setErrorText(null);
    const startedAt = Date.now();

    try {
      const payload = serialize(pattern);

      const response = await fetch('/api/pdf', {
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
        throw new Error(body?.error ?? `PDF 生成失败（HTTP ${response.status}）`);
      }

      const blob = await response.blob();
      if (blob.size === 0) {
        throw new Error('PDF 返回为空，请重试。');
      }

      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `perler-pattern-${brand}-${pattern.cols}x${pattern.rows}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // 立刻 revoke 在部分浏览器会取消下载，延迟释放
      window.setTimeout(() => window.URL.revokeObjectURL(url), 4000);

      toast.success(`图纸已导出：${sizeLabel}，${payload.palette.length} 个色号`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'PDF 生成失败，请重试。';
      setErrorText(message);
      toast.error(message);
    } finally {
      const elapsed = Date.now() - startedAt;
      if (elapsed < 250) {
        await new Promise((resolve) => setTimeout(resolve, 250 - elapsed));
      }
      setIsGenerating(false);
    }
  }, [brand, pattern, sizeLabel]);

  const title = pattern
    ? `导出可打印 PDF（${pattern.cols} × ${pattern.rows}，${pattern.palette.length} 个色号）`
    : '先放一张图';

  if (compact) {
    return (
      <button
        type="button"
        onClick={handleExport}
        disabled={disabled}
        className={className ? `px-btn px-btn-primary px-btn-sm ${className}` : 'px-btn px-btn-primary px-btn-sm'}
        aria-busy={isGenerating}
        aria-label={isGenerating ? '正在生成 PDF' : '导出图纸 PDF'}
        title={title}
      >
        {isGenerating ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        <span className="hidden sm:inline">{isGenerating ? '生成中…' : 'PDF'}</span>
      </button>
    );
  }

  return (
    <div className={className ? `flex flex-col gap-1.5 ${className}` : 'flex flex-col gap-1.5'}>
      <button
        type="button"
        onClick={handleExport}
        disabled={disabled}
        className="px-btn px-btn-primary"
        aria-busy={isGenerating}
        title={title}
      >
        {isGenerating ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            正在生成…
          </>
        ) : (
          <>
            <Download className="h-4 w-4" aria-hidden="true" />
            导出图纸 PDF
          </>
        )}
      </button>

      {errorText && (
        <p role="alert" className="text-xs text-[var(--berry)] leading-snug">
          {errorText}
        </p>
      )}
    </div>
  );
}
