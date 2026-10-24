'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 通用 localStorage 持久化 hook
 * ===============================================================
 * 设计要点：
 *
 * 1. **SSR / 水合安全**。第一帧永远返回 `initial`（服务端没有
 *    localStorage，客户端首帧也必须与服务端 HTML 一致），真正的
 *    读取放在 `useEffect` 里。第三个返回值 `isLoaded` 让调用方可以
 *    "数据没读出来之前先别渲染列表"，避免闪一下空态。
 *
 * 2. **隐私模式 / 配额溢出**。Safari 无痕、Chrome 禁用第三方存储时
 *    `localStorage.setItem` 会直接抛 QuotaExceededError；有些环境
 *    连访问 `window.localStorage` 本身都会抛 SecurityError。
 *    这里全部 try/catch 吞掉，降级为"内存态"——功能照用，只是刷新
 *    后丢失，比整页崩掉好。
 *
 * 3. **写入失败要能把错误抛回给调用方**。历史记录需要知道"这次没存
 *    进去"，所以持久化逻辑抽成 `persist` 并单独导出，由 hook 内部
 *    使用，失败时返回 false 而不是 throw。
 *
 * 4. **不做跨标签页同步**。这个应用是单页工具，加 storage 事件监听
 *    反而会让"另一个标签页清空了历史"把当前编辑态打乱。
 */

/** 底层读写：任何异常都退化成 null / false，绝不冒泡到渲染层 */
export function readStorage<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    // JSON 损坏 / 隐私模式 / 被安全策略拦截：当作没存过
    return fallback;
  }
}

/** 写入，返回是否成功（配额溢出时为 false，调用方可据此裁剪数据） */
export function writeStorage(key: string, value: unknown): boolean {
  return writeStorageDetailed(key, value).ok;
}

export type WriteResult = { ok: true } | { ok: false; error: string };

/**
 * 带错误原因版本的写入。
 *
 * `writeStorage` 只回 boolean，调用方无法区分"配额满"和"隐私模式禁用"，
 * 也就没法给出有意义的提示。历史记录需要把失败原因写进 console.warn，
 * 所以这里额外把 `DOMException.name`（QuotaExceededError /
 * SecurityError 等）原样带出来。
 *
 * 先单独 `JSON.stringify`：序列化失败（循环引用、BigInt）和 setItem
 * 失败是两类完全不同的错误，混在一个 catch 里会看不出原因。
 */
export function writeStorageDetailed(key: string, value: unknown): WriteResult {
  if (typeof window === 'undefined') return { ok: false, error: 'NoWindow' };

  let json: string;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    return { ok: false, error: `SerializeError:${(err as Error)?.name ?? 'Error'}` };
  }

  return writeRawStorage(key, json);
}

/** 直接写已经序列化好的 JSON 串，省掉一次重复的 JSON.stringify */
export function writeRawStorage(key: string, json: string): WriteResult {
  if (typeof window === 'undefined') return { ok: false, error: 'NoWindow' };
  try {
    window.localStorage.setItem(key, json);
    return { ok: true };
  } catch (err) {
    // 隐私模式 / 配额溢出 / 被安全策略拦截
    const name = (err as { name?: string })?.name;
    return { ok: false, error: name || 'UnknownError' };
  }
}

export function removeStorage(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* 忽略：隐私模式下删不掉也无所谓 */
  }
}

export type StorageSetter<T> = (value: T | ((prev: T) => T)) => void;

/**
 * @param key       localStorage 键名
 * @param initial   首帧值（服务端与客户端必须一致）
 * @param options.onQuotaExceeded  写入失败（通常是配额）时的回调，
 *                 调用方可以裁掉旧数据后自行重试
 */
export function useLocalStorage<T>(
  key: string,
  initial: T,
  options?: { onQuotaExceeded?: () => void },
): [T, StorageSetter<T>, boolean] {
  const [value, setValue] = useState<T>(initial);
  const [isLoaded, setIsLoaded] = useState(false);

  // 首帧不写回，避免把 initial 覆盖掉磁盘上已有的数据
  const hydratedRef = useRef(false);
  const onQuotaRef = useRef(options?.onQuotaExceeded);
  onQuotaRef.current = options?.onQuotaExceeded;

  // 读：只在挂载后跑一次
  useEffect(() => {
    const stored = readStorage<T>(key, initial);
    setValue(stored);
    setIsLoaded(true);
    hydratedRef.current = true;
    // initial 刻意不进依赖：它通常是字面量对象，每次渲染都是新引用，
    // 放进依赖会让读盘反复执行、覆盖用户刚做的修改。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = useCallback<StorageSetter<T>>(
    (next) => {
      setValue((prev) => {
        const resolved =
          typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        const ok = writeStorage(key, resolved);
        if (!ok && hydratedRef.current) {
          // 让调用方有机会裁剪（例如历史记录丢最旧的一条再写）
          onQuotaRef.current?.();
        }
        return resolved;
      });
    },
    [key],
  );

  return [value, set, isLoaded];
}

export default useLocalStorage;
