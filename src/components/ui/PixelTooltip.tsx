'use client';

import { useEffect, useState } from 'react';

/**
 * 把全站原生 `title` 提示条换成自绘的像素气泡。
 *
 * ---------------------------------------------------------------------------
 * 为什么必须换
 * ---------------------------------------------------------------------------
 * 用户截图里，窄屏编辑态悬停「退出编辑」时，浏览器弹出那条深黑色实心长条
 * —— 不换行、能横跨整屏、直接压在下面一排「均衡 / 保细节」按钮上，把两个
 * 还没点的按钮盖住。那不是我们的样式，是 Chrome / Safari 对 `title` 属性的
 * 默认渲染，**CSS 改不动它**：位置、配色、宽度全由浏览器决定。
 *
 * ---------------------------------------------------------------------------
 * 为什么是"一次性迁移"而不是"悬停时摘掉、移开再装回"
 * ---------------------------------------------------------------------------
 * 先试过后一种：pointerover 时把 title 挪进 dataset，移开时装回去。实测
 * **不可靠** —— pointerover 会在整条祖先链上触发，从一个按钮移向空白区域时
 * 会先经过若干带 title 的祖先，两边的隐藏/恢复互相踩，最后有 2 个元素卡在
 * 「title 已被摘掉」的状态，它们的提示永远不再出现。而且每次悬停都要做一次
 * 全文档 querySelectorAll，鼠标横扫工具条时开销白白翻倍。
 *
 * 现在改成：挂载时扫一遍，把 `title` 就地改成 `data-tip-title`，**之后永不
 * 装回**。原生条从此没有触发的可能，气泡的位置/换行/配色全归我们管。
 *
 * ---------------------------------------------------------------------------
 * 无障碍：不能只是把 title 删掉
 * ---------------------------------------------------------------------------
 * `title` 在没有任何其它命名来源时，就是那个控件的**可访问名**（全站有 53
 * 处 title、64 处 aria-label，两者并不一一对应）。直接删掉，读屏用户听到的
 * 就只剩"按钮"两个字。所以迁移时若是元素没有 aria-label / aria-labelledby，
 * 就把 title 原文写进 aria-label —— 名字保住了，而且是比 title 更规范的来源
 * （title 在触屏和键盘场景里本来就读不出来）。
 *
 * 用 MutationObserver 盯 title 属性变化，后加进 DOM 的元素（弹窗、portal、
 * 条件渲染的分支）同样会被迁移，不需要各处记得来登记。
 *
 * ---------------------------------------------------------------------------
 * 位置规则
 * ---------------------------------------------------------------------------
 * 默认放元素下方 6px；下方放不下就翻到上方。水平方向以元素中心对齐，再夹进
 * 视口留 8px 边距 —— 窄屏工具条最右边那几个按钮的提示条就是靠这条夹取才没
 * 有出界。文本最宽 260px、超出换行；原生条不换行正是它盖住一整行的原因。
 */
export function PixelTooltip() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; w: number } | null>(
    null,
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // 触屏没有悬停态，原生 title 本来也不会弹；气泡只在真悬停设备上启用
    if (!window.matchMedia('(hover: hover)').matches) return;

    const ATTR = 'data-tip-title';

    /** 把一个元素的 title 迁到 dataset（并补 aria-label），幂等 */
    const migrate = (el: Element) => {
      const raw = el.getAttribute('title');
      if (raw === null) return;
      const text = raw.trim();
      if (!text) {
        el.removeAttribute('title');
        return;
      }
      el.setAttribute(ATTR, text);
      /*
       * 只有"没有其它命名来源"时才补 aria-label。已经有了就不动 ——
       * aria-label 通常比 title 写得更短更准（按钮文本是"导出"，title 是
       * "导出图纸（45×64，4 个色号）"，读屏该念的是短的那个）。
       */
      if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) {
        el.setAttribute('aria-label', text);
      }
      el.removeAttribute('title');
    };

    const scan = (root: ParentNode) => {
      root.querySelectorAll?.('[title]').forEach(migrate);
      if (root instanceof Element) migrate(root);
    };

    scan(document.body);

    const observer = new MutationObserver((records) => {
      for (const rec of records) {
        if (rec.type === 'attributes' && rec.attributeName === 'title') {
          if (rec.target instanceof Element) migrate(rec.target);
        } else {
          rec.addedNodes.forEach((n) => {
            if (n instanceof Element) scan(n);
          });
        }
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributeFilter: ['title'],
    });

    /** 找指针下最近的可提示元素（含祖先兜底：图标常常套在一层 wrapper 里） */
    const ownerOf = (node: EventTarget | null): HTMLElement | null => {
      if (!(node instanceof Element)) return null;
      const el = node.closest<HTMLElement>(`[${ATTR}]`);
      if (!el) return null;
      if (el.closest('[data-pixel-tooltip]')) return null;
      return el;
    };

    let raf = 0;
    const show = (el: HTMLElement) => {
      const text = el.getAttribute(ATTR) ?? '';
      if (!text) return;

      /*
       * ------------------------------------------------------------------
       * 抑制"说的是它自己"的提示
       * ------------------------------------------------------------------
       * 色号块身上挂的 title 就是 `H17 · #F1EDE3`，而它自己显示的就是
       * `H17` + `#F1EDE3`（宽屏会被 CSS 截断成 `#F1EDE…`）。悬停弹一条
       * 内容一模一样的浮层，既不多给信息，又在密排的调色板里把旁边那个
       * 色号块盖住 —— 实测桌面端这类"压住邻居"的告警有 60 多条，绝大多数
       * 是这一类。
       *
       * 判据只看"提示内容是不是已经被元素自己说完了"：两边都去掉空白和
       * 标点后，若可见文字占了提示的大部分长度且是它的子串，就认为重复。
       *
       * 门槛特意留得松 —— `网格`（可见 2 字）配 `显示/隐藏网格线`（8 字）
       * 只占 25%，不会被误杀；`退出编辑`（4 字）配 20 字的说明也只占 20%。
       * 真正会被抑制的只有色号块这种"标题即内容"的情形。
       * ------------------------------------------------------------------
       */
      const squash = (v: string) => v.replace(/[^\p{L}\p{N}]/gu, '');
      const tipKey = squash(text);
      const ownKey = squash(el.textContent ?? '');
      if (ownKey.length >= 4 && ownKey.length >= tipKey.length * 0.6 && tipKey.includes(ownKey)) {
        return;
      }

      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;

      const PAD = 8;
      const GAP = 6;
      const MAXW = Math.min(260, window.innerWidth - PAD * 2);

      /*
       * 先估宽再定位。用 canvas 量会不准（字体栈和字重都不同），所以按
       * 字符类别估：中文/全角每字约 12px，ASCII 约 6.8px。
       *
       * 这里的 CHROME = 22 是**盒子的非文本开销**：左右 padding 各 9px、
       * 左右边框各 2px（`box-sizing: border-box` 下 width 含这三项）。
       * 一开始写的是 18，漏掉了边框 —— 结果"先放一张图"这种 5 个字的短
       * 文本被算成 81px，内容区只剩 59px 而 5 个汉字要 60px，差 1px 就
       * 折了行，气泡高 32px 变成 50px。宁可贵 2px 也不要折行，取 24。
       *
       * 误差由 max-width 的换行兜住 —— 估宽只影响水平位置，不影响正确性。
       */
      const CHROME = 24;
      let est = 0;
      for (const ch of text) est += ch.charCodeAt(0) > 0x2e80 ? 12 : 6.8;
      const w = Math.min(est + CHROME, MAXW);

      let x = r.left + r.width / 2 - w / 2;
      x = Math.max(PAD, Math.min(x, window.innerWidth - w - PAD));

      const lines = Math.max(1, Math.ceil(est / (MAXW - CHROME)));
      const h = lines * 18 + 14;

      /*
       * ------------------------------------------------------------------
       * 不挡东西：候选位打分，而不是"下方优先"
       * ------------------------------------------------------------------
       * 用户截图里那句「悬空选定之后」说的就是这件事 —— 窄屏编辑态工具条
       * 排得极密（「退出编辑 / 色号 / 网格 / 标尺」一行、「抓手 / 手绘 /
       * 橡皮 / 取色 / 油漆桶」紧贴下一行，行距只有 6px），气泡一旦固定往
       * 下弹，就直接压在下面那排还等着点的工具按钮正中。
       *
       * 光"下方放不下就翻到上方"不够：下方**放得下**，只是放下去会盖住
       * 别的按钮。所以这里枚举候选位，给每个候选数一数它会压住几个可点
       * 元素，优先选**压住最少**的那个。
       *
       * 每个方向给三个对齐位置（下：左齐/居中/右齐，右：上齐/居中/下齐…），
       * 一共 12 个候选。只给"居中"一个位置是不够的 —— 实测窄屏编辑态里
       * 「显示/隐藏网格线」这类按钮右边就是画布，"正下方居中"必然压住上一
       * 行的「参数」，而"正下方右齐"能整个落空。多两个对齐位就把这些情况
       * 解决掉了，代价只是 12 次 × 几十个矩形的比较，可以忽略。
       *
       * 12 个全都会压住东西时，选遮挡面积最小的 —— 总比固定压住下面一排
       * 强。先后顺序（下 > 上 > 右 > 左，同方向内 居中 > 左齐/上齐 > 右齐/
       * 下齐）通过遍历顺序落实，等价时保留先遍历到的那个。
       * ------------------------------------------------------------------
       */
      type Cand = { x: number; y: number; bad: number; span: number; dist: number };

      /*
       * 收集可点元素。只查一次可交互和可提示的元素，而不是全 DOM：气泡只
       * 可能"挡住能点/能提示的东西"，而这类元素数量在几十个量级，12 个候
       * 选位扫一遍也才几百次矩形比较。
       */
      const actives: DOMRect[] = [];
      document
        .querySelectorAll<HTMLElement>('button, a, input, select, [role="button"], [data-tip-title]')
        .forEach((node) => {
          if (node === el || node.contains(el)) return;
          if (node.closest('[data-pixel-tooltip]')) return;
          const b = node.getBoundingClientRect();
          if (b.width > 0 && b.height > 0) actives.push(b);
        });
      /*
       * 锚点自己也进罚分表。
       *
       * 一开始把锚点整个跳过了 —— 想当然认为"提示条当然不会盖住触发它的
       * 东西"。实测会：窄屏「参数」按钮（x 348、宽 66，右边紧贴视口边）
       * 的四个方向全被别的按钮占满，剩余候选被夹进视口后正好落在它自己
       * 身上，气泡把「参数」两个字整个盖住 —— 用户悬停它反而看不见它。
       * 盖住锚点比盖住邻居更糟，所以给它单独的罚分。
       */
      actives.push(r);

      const countOverlap = (bx: number, by: number) => {
        let bad = 0;
        let span = 0;
        for (const b of actives) {
          // 相交面积 > 0 才算挡住；只擦边 1px 不记
          const ox = Math.min(bx + w, b.right) - Math.max(bx, b.left);
          const oy = Math.min(by + h, b.bottom) - Math.max(by, b.top);
          if (ox > 1 && oy > 1) {
            bad++;
            span += ox * oy;
          }
        }
        return { bad, span };
      };

      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const xs = [cx - w / 2, r.left, r.right - w]; // 居中 / 左齐 / 右齐
      const ys = [cy - h / 2, r.top, r.bottom - h]; // 居中 / 上齐 / 下齐

      /*
       * 距离档位：6px 是紧贴，42 / 78 / 114 是"再退一个按钮高度"。
       *
       * 为什么要多退几档：窄屏编辑态的工具条是横滑的，右边几个按钮被滚出
       * 视口（实测「显示/隐藏网格线」的 x=376、宽 52，而视口只有 430），
       * 它们的四个方向全被同一行的邻居占满。贴近放一定压住东西，退开一档
       * 就能落到上方「图纸 45×64」那条空白带里。距离记进打分，越近越优先
       * —— 只有近处全被占满时才会退到远处。
       */
      const gaps = [GAP, GAP + 36, GAP + 72, GAP + 108];
      const raw: { x: number; y: number; dist: number }[] = [];
      for (const [i, d] of gaps.entries()) {
        raw.push({ x: xs[0], y: r.bottom + d, dist: i });
        raw.push({ x: xs[0], y: r.top - d - h, dist: i });
      }
      // 左右两侧只在最近一档尝试：远距离的左右会脱开语义，看着像另一处的提示
      raw.push({ x: r.right + GAP, y: ys[0], dist: 0 });
      raw.push({ x: r.right + GAP, y: ys[1], dist: 0 });
      raw.push({ x: r.right + GAP, y: ys[2], dist: 0 });
      raw.push({ x: r.left - GAP - w, y: ys[0], dist: 0 });
      raw.push({ x: r.left - GAP - w, y: ys[1], dist: 0 });
      raw.push({ x: r.left - GAP - w, y: ys[2], dist: 0 });

      let best: Cand | null = null;
      for (const c of raw) {
        // 出视口就夹回来（夹取可能改变覆盖情况，所以先夹再量）
        const px = Math.max(PAD, Math.min(c.x, window.innerWidth - w - PAD));
        const py = Math.max(PAD, Math.min(c.y, window.innerHeight - h - PAD));
        const { bad, span } = countOverlap(px, py);
        const cand: Cand = { x: px, y: py, bad, span, dist: c.dist };
        /*
         * 打分依次比：压住几个 > 遮挡面积 > 距离档位。用严格小于，等价时
         * 保留先出现的那一个，所以 raw 的书写顺序就是最终偏好顺序。
         */
        if (
          best === null ||
          cand.bad < best.bad ||
          (cand.bad === best.bad && cand.span < best.span) ||
          (cand.bad === best.bad && cand.span === best.span && cand.dist < best.dist)
        ) {
          best = cand;
        }
      }

      const bx = best ? best.x : Math.max(PAD, Math.min(x, window.innerWidth - w - PAD));
      const by = best ? best.y : r.bottom + GAP;

      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setTip({ text, x: bx, y: by, w }));
    };

    const hide = () => {
      cancelAnimationFrame(raf);
      setTip(null);
    };

    /*
     * 从按钮移到气泡上、或两个按钮之间只隔 2px 缝隙时，不希望在中间那
     * 零帧里闪一下又回来。60ms 的延迟足够跨过缝隙，又不至于让"离开"
     * 显得拖沓。
     */
    let hideTimer = 0;
    const hideSoon = () => {
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(hide, 60);
    };
    const cancelHide = () => window.clearTimeout(hideTimer);

    const onOver = (e: PointerEvent) => {
      const el = ownerOf(e.target);
      if (el) {
        cancelHide();
        show(el);
      } else {
        hideSoon();
      }
    };

    const onFocusIn = (e: FocusEvent) => {
      const el = ownerOf(e.target);
      if (el) {
        cancelHide();
        show(el);
      }
    };

    /** 这些动作会让气泡的位置失效，直接收掉而不是等下次 pointerover */
    const onVanish = () => {
      cancelHide();
      hide();
    };

    document.addEventListener('pointerover', onOver, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('pointerdown', onVanish, true);
    document.addEventListener('scroll', onVanish, true);
    document.addEventListener('keydown', onVanish, true);
    window.addEventListener('resize', onVanish);
    window.addEventListener('blur', onVanish);

    return () => {
      observer.disconnect();
      onVanish();
      document.removeEventListener('pointerover', onOver, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('pointerdown', onVanish, true);
      document.removeEventListener('scroll', onVanish, true);
      document.removeEventListener('keydown', onVanish, true);
      window.removeEventListener('resize', onVanish);
      window.removeEventListener('blur', onVanish);
    };
  }, []);

  if (!tip) return null;

  return (
    <div
      data-pixel-tooltip
      role="tooltip"
      style={{
        position: 'fixed',
        left: tip.x,
        top: tip.y,
        zIndex: 90,
        width: tip.w,
        maxWidth: 'calc(100vw - 16px)',
        padding: '5px 9px',
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--ink)',
        background: 'var(--paper-hi)',
        border: '2px solid var(--line-strong)',
        boxShadow: 'var(--shadow-px)',
        pointerEvents: 'none',
        whiteSpace: 'normal',
        wordBreak: 'break-word',
      }}
    >
      {tip.text}
    </div>
  );
}

export default PixelTooltip;
