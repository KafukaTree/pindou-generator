'use client';

/**
 * 文档级撤销 / 重做。
 * ---------------------------------------------------------------
 * 为什么要有这一层，而不是继续用原来画布内部那个栈
 * ---------------------------------------------------------------
 * 旧实现里回退能力散在**三个互不相干的地方**，每个只管自己那一小块：
 *
 *   1. `usePatternCanvas` 里的 `undoLogRef`／`redoLogRef`
 *      —— 只认「手工编辑」和「区域笔刷」两种条目，而且活在画布组件内部；
 *   2. 刷区域工具条上的「撤销 / 清空」
 *      —— 只回退 brushes，完全不碰 edits；
 *   3. 编辑工具条上的「还原」（clearEdits）
 *      —— 只清 edits，区域笔刷一格都不动。
 *
 * 于是用户看到的是：涂几笔再刷一块区域，点刷子的撤销撤掉的是区域、点编辑
 * 的还原只擦掉手绘，两个按钮各退半步，谁也没把"我刚才那一下"退掉；而
 * 换图 / 换画幅 / 居中 / 放大 / 从历史恢复这些**改变文档本身**的动作根本
 * 不进任何栈，栈里还留着按旧尺寸算出来的格子下标 —— 撤销一去，新画布上
 * 冒出几颗莫名其妙的豆子。
 *
 * 这一层的做法：把整份文档当一个对象，变化前后各拍一个快照。快照里全是
 * 引用（`pattern`／`edits`／`brushes` 每次变化都是新对象），所以"拍快照"
 * 的成本只是几个指针，不是把 10 万格的 Int16Array 复制一份。
 *
 * 记什么、不记什么 —— 这是整个设计的关键
 * ---------------------------------------------------------------
 * 不能"文档对象一变就记一笔"。因为 `pattern` 大多数时候是**派生**的：
 * 刷一块区域 → `brushes` 变（用户意图）→ 推一下触发引擎重算 → `pattern`
 * 变（派生结果）。两个变化相隔几百毫秒，若都记一笔，撤销一次只会退掉
 * 那次"重算"（图案短暂回到旧结果、选区还在图上），再撤一次才真的退掉
 * 区域 —— 这正是用户说的"怪怪的"。
 *
 * 所以把文档拆成两部分：
 *
 *   - **意图**（`sig`）：图源、空白画布身份与尺寸、参数、edits、brushes。
 *     这几样只有用户的动作能改，引擎跑完不会动它。**只有意图变了才记一笔**。
 *   - **派生**（`doc`）：pattern（以及随之而来的描边结果）。它跟着意图
 *     算出来，变了不记，但快照里必须带着 —— 「居中 / 放大」这类动作直接
 *     改 cells，撤销时要能把那份 cells 一起放回去。
 *
 * 自动记，不手动记
 * ---------------------------------------------------------------
 * 不在每个 handler 里手写 `pushUndo(...)`。那种写法漏掉一个入口就出现
 * "这个操作撤不回来"，而且漏掉的往往是后来新加的 —— 旧实现踩的就是这个
 * 坑（居中/放大/换画幅全漏）。这里改成监听意图对象本身，加新入口不用改
 * 历史层。
 *
 * 连发合并（burst）
 * ---------------------------------------------------------------
 * 拖网格密度滑杆会连续触发几十次变化，一次一笔会瞬间把历史灌满，用户按
 * 十几次撤销才回到拖动前。所以同一阵连续变化合并成一条：第一次变化时把
 * "变化之前那份"扣在手里，之后只刷新静默计时器，停满 `QUIET_MS` 才真正
 * 落栈。拖 3 秒 = 一条历史，撤销一次回到拖动前。
 *
 * 撤销前先 flush
 * ---------------------------------------------------------------
 * 合并意味着"刚拖完 200ms 内按 Ctrl+Z，栈里还没有这一笔"。所以 `undo()`
 * 第一件事是 `flush()`，把手里那份压进去再退。不这么做就会出现"刚改完
 * 马上撤销没反应，再按一下退了两步"。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** 连续变化的静默期：停了这么久才认为"这一阵操作结束了" */
const QUIET_MS = 420;

/** 历史深度上限。80 条足够走回去，再多反而找不到想撤的那一步 */
const MAX_DEPTH = 80;

/**
 * 回写守卫的有效期。
 *
 * 撤销/重做会把一批 state 写回去，随之而来的那次意图变化**不该**被记成
 * 新的一笔（否则撤销完立刻冒出一条可重做，再撤销原地打转）。守卫就是
 * 为此存在的"下一次变化不算数"信号。
 *
 * 但它不能无限期挂着：若回写后意图恰好没变（快照与当前状态相同），守卫
 * 没人消费，下一次真正的用户操作就会被吞掉。给 600ms 的上限，超时作废
 * —— 宁可多记一笔，也不能吞掉用户的操作。
 */
const GUARD_MS = 600;

interface Burst<T> {
  /** 这阵连续变化**之前**的文档 */
  base: T;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface DocHistory<TDoc> {
  /** 现在能不能撤销 / 重做 */
  canUndo: boolean;
  canRedo: boolean;
  /** 撤销 / 重做：先把还没落地的连发变化 flush 掉，再走一步 */
  undo: () => void;
  redo: () => void;
  /**
   * 把给定文档写回去，并**记下当前状态**作为可撤销的一步。
   *
   * 给「还原到最初」用：它不是一个"退一步"的动作，而是"跳到某个已知
   * 状态"，跳完还得能撤销回跳之前。
   */
  jumpTo: (doc: TDoc) => void;
  /** 清空历史。文档身份被整体替换时必须调 */
  clear: () => void;
  /** 已经记录了多少步（调试 / "可撤销 N 步"提示用） */
  undoDepth: number;
  redoDepth: number;
  /** 立刻把待定的连发变化落栈（导出、存版本这类需要状态定型的动作前调） */
  flush: () => void;
}

/**
 * @param doc   当前文档快照（撤销时要写回去的东西）
 * @param sig   意图指纹。**逐项用 `Object.is` 比较**，任一项变了就记一笔。
 *              放的东西必须是"只有用户动作能改"的 state：图源、画布身份与
 *              尺寸、参数、edits、brushes。派生结果（pattern/描边）不要放。
 * @param apply 把一份 doc 写回各个 state。内部只做 setState，不要塞副作用。
 * @param opts.immediate  与 `sig` **逐位对齐**的布尔数组：为 true 的那一项
 *              变化时立刻单独记一笔，不参与连发合并。
 *
 *              为什么需要：合并本来是为拖滑杆设计的（拖 3 秒 = 一条历史）。
 *              但「画了一笔」和「刷了一块区域」是两次独立的、有明确边界的
 *              意图动作，用户心里它们就是两步 —— 若也并进去，快速连画十
 *              几笔只留一条历史，想退中间某一笔就没路了。滑杆那种"一次
 *              拖动只该算一步"的才合并。
 *
 *              没给的位一律当 false（全部参与合并）。
 * @param opts.resetKey  文档身份。变了就代表"换了一份东西"（放了新图、
 *              清空回到起始页），此时必须清空历史 —— 旧栈里那些按旧网格算
 *              出来的绝对下标对新文档毫无意义，撤销一去就写到别的格子上。
 *
 *              为什么是"清空"而不是"记一步"：如果把"换图"也记成一步，
 *              用户按 Ctrl+Z 就会退回空工作区 —— 而空工作区里画布组件整个
 *              不渲染，撤销/重做按钮和快捷键跟着一起没了，用户再也回不去。
 *              打开新文档重置历史，是所有编辑器的一致做法。
 *
 *              比传 `suppressRef` 好在：清栈与"新基准"是同一个原子动作，
 *              不会出现"栈清了但基准还停在旧文档"的中间态。
 * @param opts.suppressRef  一次性吞掉下一次记账。
 *
 *              给"启动恢复"用：刷新后会话恢复会把图源、画布、edits 一次性
 *              补上，那不是用户操作。记进去的话，撤销栈第一步就是"回到空
 *              工作区" —— 用户刷新一下再点撤销，图纸凭空消失。
 *
 *              为什么是 ref 而不是布尔 prop：恢复发生在 effect 里，那些
 *              setState 和 `setSessionBooting(false)` 在同一批里，下一轮渲染
 *              时布尔 prop 已经是 false 了，拦不住。而"恢复 effect 先跑、
 *              历史 effect 后跑"这个顺序是确定的（同一 commit 内按声明顺序），
 *              所以用一个 ref 当"这一枪别记"的信号最可靠。
 */
export function useDocHistory<TDoc>(
  doc: TDoc,
  sig: readonly unknown[],
  apply: (doc: TDoc) => void,
  opts: {
    suppressRef?: { current: boolean };
    immediate?: readonly boolean[];
    resetKey?: unknown;
  } = {},
): DocHistory<TDoc> {
  const suppressRef = opts.suppressRef;
  const immediate = opts.immediate;
  const resetKey = opts.resetKey;
  const pastRef = useRef<TDoc[]>([]);
  const futureRef = useRef<TDoc[]>([]);
  const burstRef = useRef<Burst<TDoc> | null>(null);
  /** 最新文档。事件回调里要拿"此刻"而不是闭包里那次渲染的值 */
  const docRef = useRef<TDoc>(doc);
  docRef.current = doc;
  /** 上一次的文档，用来当"变化之前那份" */
  const prevDocRef = useRef<TDoc>(doc);
  /**
   * 已经记过的那一版意图。
   *
   * 不能直接用"上一次渲染的 sig"：pattern 重算完成的静默变化会把上一版
   * 快照推进到新值，但"上一笔历史的基准意图"没变 —— 拿新的去比会把
   * "意图确实又变了"判成没变。这个 ref 专门记"上次落栈/建包时的意图"。
   */
  const recordedSigRef = useRef<readonly unknown[]>(sig);
  /** 回写守卫：非 null 表示"下一次意图变化是回写造成的，不要记" */
  const guardRef = useRef<number | null>(null);

  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const push = useCallback((base: TDoc) => {
    const past = pastRef.current;
    past.push(base);
    if (past.length > MAX_DEPTH) past.shift();
    futureRef.current = [];
  }, []);

  const flush = useCallback(() => {
    const burst = burstRef.current;
    if (!burst) return;
    if (burst.timer !== null) clearTimeout(burst.timer);
    burstRef.current = null;
    push(burst.base);
    bump();
  }, [push, bump]);

  /*
   * 文档换了身份 → 清空历史。
   *
   * 必须声明在下面那个记账 effect **之前**：两者在同一个 commit 里跑，
   * 顺序就是声明顺序。先清栈并把基准指到"新文档这一版"，记账 effect 再
   * 比就会发现"没变化"，不会把这次身份切换记成一笔。
   *
   * 不清栈的后果是实测出来的：换一张图后按 Ctrl+Z，旧图的下标被当成新图
   * 的格子写进去，画布上冒出几颗从没画过的豆子。
   */
  const resetKeyRef = useRef<unknown>(resetKey);
  useEffect(() => {
    if (Object.is(resetKeyRef.current, resetKey)) return;
    resetKeyRef.current = resetKey;
    const stale = burstRef.current;
    if (stale?.timer != null) clearTimeout(stale.timer);
    burstRef.current = null;
    pastRef.current = [];
    futureRef.current = [];
    guardRef.current = null;
    recordedSigRef.current = sig;
    prevDocRef.current = doc;
    bump();
    // sig/doc 只作为"新基准"的值读一次，不进依赖（每次都新对象，会空转）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, bump]);

  /*
   * 意图指纹变了就准备记一笔。
   *
   * 不直接压栈：扣住"变化之前那份"并开始静默计时，真正压栈在 flush 里。
   * 这样连续变化（拖滑杆）合并成一条。
   */
  useEffect(() => {
    const prev = prevDocRef.current;
    prevDocRef.current = doc;

    // 回写守卫：这一次变化是撤销/重做写回去造成的，不记
    if (guardRef.current !== null) {
      const age = Date.now() - guardRef.current;
      guardRef.current = null;
      if (age <= GUARD_MS) {
        recordedSigRef.current = sig;
        const stale = burstRef.current;
        if (stale?.timer != null) clearTimeout(stale.timer);
        burstRef.current = null;
        bump();
        return;
      }
    }

    const last = recordedSigRef.current;
    let changed = last.length !== sig.length;
    /** 这次变化里有没有"必须单独算一步"的项 */
    let urgent = false;
    if (changed) {
      // 长度都对不上（首次渲染/结构变了），按连发处理，不当作离散动作
      urgent = false;
    } else {
      for (let i = 0; i < sig.length; i++) {
        if (Object.is(last[i], sig[i])) continue;
        changed = true;
        if (immediate?.[i]) urgent = true;
      }
    }
    if (!changed) {
      /*
       * 意图没变，只是派生结果（pattern）被引擎改写。
       * 什么都不记 —— 但 prevDocRef 已经跟上，后来真正变化时拿到的基础
       * 文档才是最新的（带着算完的 pattern）。
       */
      return;
    }

    /*
     * 一次性吞掉：把"这一版"当作新基准，但不压栈。
     *
     * 用在启动恢复那一段 —— 那里会一次补上图源、空白画布、edits，
     * 全都是"回到上次的状态"而不是"用户刚做了什么"。
     */
    if (suppressRef?.current) {
      suppressRef.current = false;
      recordedSigRef.current = sig;
      const stale = burstRef.current;
      if (stale?.timer != null) clearTimeout(stale.timer);
      burstRef.current = null;
      bump();
      return;
    }

    recordedSigRef.current = sig;

    /*
     * 离散动作：立刻落栈，并先把待定的连发收掉。
     *
     * 「拖着色数滑杆 → 松手 → 马上画一笔」是最常见的序列。若不先 flush，
     * 那一笔会覆盖掉滑杆的 base，拖动那一整段就再也撤不回去了。
     */
    if (urgent) {
      flush();
      push(prev);
      bump();
      return;
    }

    const burst = burstRef.current;
    if (!burst) {
      burstRef.current = { base: prev, timer: null };
    } else if (burst.timer !== null) {
      clearTimeout(burst.timer);
    }
    burstRef.current!.timer = setTimeout(() => {
      const b = burstRef.current;
      if (!b) return;
      burstRef.current = null;
      push(b.base);
      bump();
    }, QUIET_MS);
    // sig 是每次渲染新建的数组，不能进依赖（会永远重建）。意图变化一定
    // 伴随 doc 或 sig 内容变化，用 doc.length 不够——显式依赖各 state 的
    // 消费方无法列出，所以这里靠 sig 内容比较本身来守卫，依赖只留 doc。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, bump, push, flush]);

  /* 卸载时清计时器，避免留下 QUIET_MS 后的回调改 ref */
  useEffect(
    () => () => {
      const burst = burstRef.current;
      if (burst?.timer != null) clearTimeout(burst.timer);
    },
    [],
  );

  const step = useCallback(
    (
      from: { current: TDoc[] },
      to: { current: TDoc[] },
    ): boolean => {
      const source = from.current;
      if (source.length === 0) return false;
      const target = source[source.length - 1];
      source.pop();
      to.current.push(docRef.current);
      if (to.current.length > MAX_DEPTH) to.current.shift();
      guardRef.current = Date.now();
      apply(target);
      bump();
      return true;
    },
    [apply, bump],
  );

  const undo = useCallback(() => {
    flush();
    step(pastRef, futureRef);
  }, [flush, step]);

  const redo = useCallback(() => {
    flush();
    step(futureRef, pastRef);
  }, [flush, step]);

  const jumpTo = useCallback(
    (target: TDoc) => {
      flush();
      // 先把"现在"存进过去，再把目标写回去 —— 跳完还能撤销回跳之前
      push(docRef.current);
      guardRef.current = Date.now();
      apply(target);
      bump();
    },
    [flush, push, apply, bump],
  );

  const clear = useCallback(() => {
    const burst = burstRef.current;
    if (burst?.timer != null) clearTimeout(burst.timer);
    burstRef.current = null;
    pastRef.current = [];
    futureRef.current = [];
    guardRef.current = null;
    // 文档换了身份，"现在这一版意图"就是新的基准
    recordedSigRef.current = docRef.current === doc ? sig : recordedSigRef.current;
    bump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bump, doc]);

  void tick;

  return useMemo(
    () => ({
      canUndo: pastRef.current.length > 0 || burstRef.current !== null,
      canRedo: futureRef.current.length > 0,
      undo,
      redo,
      jumpTo,
      clear,
      undoDepth: pastRef.current.length,
      redoDepth: futureRef.current.length,
      flush,
    }),
    // tick 参与依赖：栈变化后要重新算 canUndo / canRedo
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick, undo, redo, jumpTo, clear, flush],
  );
}
