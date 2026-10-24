'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Upload, Image as ImageIcon, X, RefreshCw, FileWarning } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * 图片上传区
 * ===============================================================
 * 几个刻意的取舍：
 *
 * - **用 FileReader 而不是 URL.createObjectURL**。历史记录要把原图持久化
 *   进 localStorage，blob: URL 出了这个页面就失效（刷新即 404），
 *   只有 dataURL 能跟着 JSON 一起存下去。代价是字符串大一些，
 *   所以我们同时校验体积、并在历史记录那边再压一次。
 *
 * - **真实尺寸校验**。只信 `file.type` 是不可靠的（截图工具/改扩展名都能
 *   骗过去），所以真正解码一遍 `<img>`，再判断像素尺寸。1px 的图或者
 *   10000px 的巨图进去只会让后面的引擎白跑一趟。
 *
 * - **拖拽反馈不能只用 opacity**。像素风的视觉语言里"变淡"很像禁用态，
 *   这里改成：边框换 clay、底色换 clay-soft、并让虚线边框走马灯式滚动，
 *   一眼就能看出"松手就放这儿"。
 *
 * - **不用 alert**。错误用 `.px-tag .px-tag-bloom` 内联显示，可关闭，
 *   且不打断操作。
 */

export interface FileUploadProps {
  onImage: (
    dataUrl: string,
    info: { width: number; height: number; name: string },
  ) => void;
  onClear?: () => void;
  /** 已选图片的 dataURL；有值时渲染"已选"态 */
  previewUrl?: string | null;
  disabled?: boolean;
  className?: string;
  /** 已选图片的原始尺寸/文件名（父组件传回，用于展示"尺寸"那行） */
  imageInfo?: { width: number; height: number; name: string } | null;
}

/** 12MB —— 再大的手机直出照片先让用户裁一下，比在浏览器里解 60MP 强 */
const MAX_BYTES = 12 * 1024 * 1024;
const MIN_EDGE = 8;
const MAX_EDGE = 10000;

const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
const ACCEPT_ATTR = ACCEPTED_MIME.join(',');
const PRETTY_TYPES = 'JPEG / PNG / WebP / GIF';

interface LoadedImage {
  img: HTMLImageElement;
  dataUrl: string;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') resolve(result);
      else reject(new Error('读取失败'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取失败'));
    reader.readAsDataURL(file);
  });
}

/** 解码 dataURL，拿到真实像素尺寸（也顺便确认文件没损坏） */
function decodeImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片已损坏或格式不受支持'));
    img.src = dataUrl;
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FileUpload({
  onImage,
  onClear,
  previewUrl = null,
  disabled = false,
  className,
  imageInfo = null,
}: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [localInfo, setLocalInfo] = useState<{
    width: number;
    height: number;
    name: string;
  } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const inputId = useId();

  // 父组件换了图（比如从历史恢复）时同步清掉本地缓存的信息
  useEffect(() => {
    if (!previewUrl) {
      setLocalInfo(null);
      setError(null);
    }
  }, [previewUrl]);

  const info = imageInfo ?? localInfo;

  const accept = useCallback(
    async (file: File) => {
      setError(null);

      if (!(ACCEPTED_MIME as readonly string[]).includes(file.type)) {
        setError(`格式不支持：只认 ${PRETTY_TYPES}`);
        return;
      }
      if (file.size > MAX_BYTES) {
        setError(`文件太大（${formatBytes(file.size)}），上限 ${formatBytes(MAX_BYTES)}`);
        return;
      }

      setIsReading(true);
      try {
        const dataUrl = await readAsDataUrl(file);
        const img = await decodeImage(dataUrl);

        if (img.naturalWidth < MIN_EDGE || img.naturalHeight < MIN_EDGE) {
          setError(
            `图片太小（${img.naturalWidth}×${img.naturalHeight}px），至少 ${MIN_EDGE}×${MIN_EDGE}px`,
          );
          return;
        }
        if (img.naturalWidth > MAX_EDGE || img.naturalHeight > MAX_EDGE) {
          setError(
            `图片太大（${img.naturalWidth}×${img.naturalHeight}px），单边不能超过 ${MAX_EDGE}px`,
          );
          return;
        }

        const nextInfo = {
          width: img.naturalWidth,
          height: img.naturalHeight,
          name: file.name,
        };
        setLocalInfo(nextInfo);
        onImage(dataUrl, nextInfo);
      } catch (err) {
        setError(err instanceof Error ? err.message : '读不出这张图，换一张试试');
      } finally {
        setIsReading(false);
        // 允许重复选择同一个文件（否则第二次选它不触发 change）
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [onImage],
  );

  const openPicker = useCallback(() => {
    if (disabled || isReading) return;
    inputRef.current?.click();
  }, [disabled, isReading]);

  const handleClear = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setError(null);
      setLocalInfo(null);
      onClear?.();
    },
    [onClear],
  );

  const handlePickAnother = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      openPicker();
    },
    [openPicker],
  );

  // ---- 拖拽：用 dragenter/leave 计数，避免移过子元素时闪烁 ----
  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (disabled) return;
      dragDepth.current += 1;
      setIsDragging(true);
    },
    [disabled],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (disabled) return;
      e.dataTransfer.dropEffect = 'copy';
      if (!isDragging) setIsDragging(true);
    },
    [disabled, isDragging],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setIsDragging(false);
      if (disabled || isReading) return;
      const file = e.dataTransfer.files?.[0];
      if (file) void accept(file);
    },
    [accept, disabled, isReading],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        openPicker();
      }
    },
    [openPicker],
  );

  const hasImage = Boolean(previewUrl);
  const interactiveProps = {
    onDragEnter: handleDragEnter,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop,
  };

  return (
    <div className={cn('w-full', className)}>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={ACCEPT_ATTR}
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void accept(file);
        }}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
      />

      {hasImage ? (
        /* ---------------- 已选态 ---------------- */
        <div className="space-y-2.5">
          <div className="px-inset relative flex items-stretch gap-0 overflow-hidden">
            {/* 缩略图：棋盘底 + contain，透明 PNG 也能看出边界 */}
            <div className="px-checker flex h-[104px] w-[104px] shrink-0 items-center justify-center border-r-2 border-[var(--line)] p-1.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewUrl ?? ''}
                alt={info ? `已选图片：${info.name}` : '已选图片预览'}
                className="max-h-full max-w-full object-contain"
                style={{ imageRendering: 'auto' }}
              />
            </div>

            <div className="flex min-w-0 flex-1 flex-col justify-between gap-1 p-2.5 pl-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <ImageIcon className="h-3.5 w-3.5 shrink-0 text-[var(--clay)]" aria-hidden />
                  <span
                    className="truncate text-[13px] font-semibold text-[var(--ink)]"
                    title={info?.name}
                  >
                    {info?.name ?? '未命名图片'}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                  {info ? (
                    <span className="text-[12.5px] tabular-nums text-[var(--ink-2)]">
                      {info.width}×{info.height}px
                    </span>
                  ) : (
                    <span className="text-[11.5px] text-[var(--ink-2)]">尺寸读取中</span>
                  )}
                  {info ? (
                    <span className="px-tag px-tag-leaf">
                      <span
                        aria-hidden
                        className="inline-block h-1.5 w-1.5 bg-[var(--leaf)]"
                      />
                      已就绪
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={handlePickAnother}
                  disabled={disabled || isReading}
                  className="px-btn px-btn-sm px-btn-ghost"
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                  换一张
                </button>
                <button
                  type="button"
                  onClick={handleClear}
                  disabled={disabled}
                  className="px-btn px-btn-sm px-btn-danger"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                  移除
                </button>
              </div>
            </div>
          </div>

          {error ? <ErrorNote message={error} onDismiss={() => setError(null)} /> : null}
        </div>
      ) : (
        /* ---------------- 空态 / 拖拽态 ---------------- */
        <div
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-label="选择或拖入一张图片，支持 JPEG、PNG、WebP、GIF，最大 12MB"
          aria-disabled={disabled}
          onClick={openPicker}
          onKeyDown={handleKeyDown}
          {...interactiveProps}
          className={cn(
            'relative flex min-h-[168px] cursor-pointer flex-col items-center justify-center gap-2 px-4 py-6 text-center transition-colors duration-100',
            // 虚线边框：空态用 ink-3，拖拽态换成 clay 并走马灯
            isDragging
              ? 'border-2 border-dashed border-[var(--clay)] bg-[var(--clay-soft)]'
              : 'border-2 border-dashed border-[var(--ink-3)] bg-[var(--paper-sunken)]',
            disabled && 'cursor-not-allowed opacity-55',
          )}
          style={
            isDragging
              ? {
                  // 斜纹底 + 背景位移动画：虚线像"走马灯"一样流动，
                  // 一眼就知道现在可以松手。keyframes 用 <style> 注入，
                  // 只在拖拽这一帧存在，不污染 globals.css。
                  backgroundImage:
                    'repeating-linear-gradient(45deg, transparent 0 6px, color-mix(in srgb, var(--clay) 14%, transparent) 6px 12px)',
                  backgroundSize: '17px 17px',
                  animation: 'fd-marching-ants 0.9s linear infinite',
                }
              : undefined
          }
        >
          {isDragging ? (
            <style>{`@keyframes fd-marching-ants{from{background-position:0 0}to{background-position:17px 0}}@media (prefers-reduced-motion: reduce){@keyframes fd-marching-ants{from{background-position:0 0}to{background-position:0 0}}}`}</style>
          ) : null}
          {/* 四角的像素小方块：像是在"占位"的拼豆板 */}
          <Corner className="left-0 top-0 border-l-2 border-t-2" />
          <Corner className="right-0 top-0 border-r-2 border-t-2" />
          <Corner className="bottom-0 left-0 border-b-2 border-l-2" />
          <Corner className="bottom-0 right-0 border-b-2 border-r-2" />

          <div
            className={cn(
              'flex h-11 w-11 items-center justify-center border-2 transition-transform duration-100',
              isDragging
                ? '-translate-y-0.5 border-[var(--clay-deep)] bg-[var(--clay)] text-[var(--on-clay)]'
                : 'border-[var(--line-strong)] bg-[var(--paper-raised)] text-[var(--ink-2)]',
            )}
            aria-hidden
          >
            {isDragging ? (
              <ImageIcon className="h-5 w-5" />
            ) : (
              <Upload className="h-5 w-5" />
            )}
          </div>

          <div className="space-y-1">
            <p className="px-section-title text-[14px]">
              {isDragging ? '松手就放这儿' : isReading ? '正在读取…' : '拖入图片，或点击选择'}
            </p>
            <p className="text-[12.5px] leading-relaxed text-[var(--ink-2)]">
              {isDragging ? '松开鼠标即可载入' : `支持 ${PRETTY_TYPES}，单张不超过 12MB`}
            </p>
          </div>

          {isReading ? (
            <div className="px-label px-blink text-[11px] tracking-normal text-[var(--clay)]">READING…</div>
          ) : (
            <div className="px-label text-[11px] tracking-normal text-[var(--ink-2)]">CLICK · DROP · PASTE?</div>
          )}
        </div>
      )}

      {!hasImage && error ? (
        <div className="mt-2">
          <ErrorNote message={error} onDismiss={() => setError(null)} />
        </div>
      ) : null}
    </div>
  );
}

/** 空态四角的像素角标 */
function Corner({ className }: { className: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute h-3.5 w-3.5 border-[var(--ink-3)]',
        className,
      )}
    />
  );
}

/** 内联错误条：bloom 色系 + 可关闭，不打断操作 */
function ErrorNote({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 border border-[var(--bloom)] bg-[var(--bloom-soft)] px-2 py-1.5"
    >
      <FileWarning
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--bloom)]"
        aria-hidden
      />
      <p className="flex-1 text-[12.5px] leading-snug text-[var(--bloom)]">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="关闭错误提示"
        className="-mr-0.5 shrink-0 p-0.5 text-[var(--bloom)] hover:bg-[var(--bloom)] hover:text-[var(--paper-hi)]"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}

export default FileUpload;

/** 供外部复用的图片解码工具（历史恢复时上层需要先解码原图） */
export async function loadImageFromDataUrl(dataUrl: string): Promise<LoadedImage> {
  const img = await decodeImage(dataUrl);
  return { img, dataUrl };
}
