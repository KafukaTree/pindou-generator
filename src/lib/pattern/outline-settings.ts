/**
 * 卡通黑边（描边）的用户设置
 * ================================================================
 * 为什么单独一个文件，而不是塞进 `GenerateOptions`：
 *
 * - `GenerateOptions` 会被原样交给 `generatePattern`，它是「怎么把一张图
 *   量化成豆子」的配方。描边不是配方的一部分 —— 它在量化**之后**再改一遍
 *   图纸，用的是另一套完全不同的数据（源图梯度 + 轮廓路径）。
 * - `outline.ts` 是与其他开发者协作的模块，本轮不改它的签名与默认行为；
 *   设置项放在外面，接入层想怎么存、怎么展示都不影响它。
 * - 描边是**纯渲染**偏好：关掉就回到原始图纸，不产生任何计算。做成
 *   options 里的字段会让人以为「改这个参数会重算量化」，其实不会。
 *
 * 默认关闭（`enabled: false`）。这是有意的：描边会额外占一个颜色名额
 * （MARD 的 H07 纯黑），并且改变用户已经在用的图纸外观。用户没点名要，
 * 就不该自作主张地动它。
 */
import type { OutlineStyle } from './outline';

/**
 * 线条的两种画法。用户明确要求把原来「轻描/均衡/浓墨」三档收敛成两种：
 *
 * - `cartoon` 卡通线条：外轮廓 + 内部结构线（眼睛、嘴、颜色交界都描）
 * - `outline` 轮廓黑边：只画最外一圈，内部一格不动
 *
 * 实测这两种的**颗数完全相同**（duck 64 格中档都是 1929 颗），差别只在
 * 覆盖掉多少原色：卡通线条 220 格、轮廓黑边 121 格。也就是说这个开关不花
 * 豆子，纯粹是"要不要动原图细节"的取舍 —— 所以文案必须点明这一点。
 */
export type OutlineLines = 'cartoon' | 'outline';

export interface OutlineSettings {
  /** 必须显式开启；关闭时不产生任何计算 */
  enabled: boolean;
  /** 粗细：0 细 / 1 中 / 2 粗（对应 1×1 / 2×2 / 3×3 核） */
  thickness: number;
  /**
   * 线条画法（见 `OutlineLines`）。引擎层对应 `internal` 开关。
   *
   * `style` 仍然保留并固定为 `adaptive`：它只调阈值，不影响颗数，而
   * 「轻描/浓墨」在用户看来和「粗细」是同一个维度的东西，等于重复了一遍
   * 粗细，反而让人不知道怎么选。收敛成两档后，`style` 不再暴露给用户。
   */
  lines: OutlineLines;
  /** 引擎的阈值档位，用户不再直接设置，恒为 'adaptive' */
  style: OutlineStyle;
  /**
   * 同色部件补线实验。**默认关闭且未通过验收**（耳根 6 项检查只过 1 项），
   * 不要在文案上把它说成"同色部件识别已完成"。
   */
  experimentalParts: boolean;
}

export const DEFAULT_OUTLINE: OutlineSettings = {
  enabled: false,
  thickness: 1,
  lines: 'cartoon',
  style: 'adaptive',
  experimentalParts: false,
};

export const OUTLINE_KEY = 'pindou.outline.v1';

export const THICKNESS_META: { value: number; label: string; hint: string }[] = [
  { value: 0, label: '细', hint: '一格宽，最贴近原图' },
  { value: 1, label: '中', hint: '两格宽，卡通感明显' },
  { value: 2, label: '粗', hint: '三格宽，远看最清楚' },
];

/**
 * 三种线条风格的人话解释。
 *
 * 这里的 `hint` 是给第一次用的人看的 —— 引擎内部的阈值差异（路径接受率、
 * 外侧补线强度）对用户没有意义，能看懂的只有"轻/均衡/重"。
 */
export const OUTLINE_STYLE_META: {
  value: OutlineStyle;
  label: string;
  hint: string;
}[] = [
  { value: 'soft', label: '轻描', hint: '只在最明确的外轮廓补线，线条少、留白多' },
  { value: 'adaptive', label: '均衡', hint: '外轮廓加内部结构线，大多数图案的推荐档' },
  { value: 'ink', label: '浓墨', hint: '线条最多最重，适合色块分明的大图' },
];

/**
 * 两种线条画法的人话解释。
 *
 * 两者颗数相同，所以 hint 不谈豆子多少，只谈"会不会动原图细节"——
 * 这正是用户在意的：勾了轮廓黑边，眼睛和嘴还是原来的颜色。
 */
export const LINES_META: { value: OutlineLines; label: string; hint: string }[] = [
  {
    value: 'cartoon',
    label: '卡通线条',
    hint: '外轮廓和内部结构都描线，眼睛、嘴巴、颜色交界也会变成黑线；卡通感最强',
  },
  {
    value: 'outline',
    label: '轮廓黑边',
    hint: '只在最外面描一圈，内部颜色一格不动；细节保留得最完整',
  },
];

/**
 * 逐字段校验读进来的设置。
 *
 * localStorage 里的东西可能是上一个版本写的、也可能被用户手改过。
 * 这里不信任任何字段：类型不对就退回默认值，而不是让一个 `thickness: "粗"`
 * 一路传到引擎里变成 NaN 核。
 */
export function sanitizeOutline(raw: unknown): OutlineSettings {
  if (!raw || typeof raw !== 'object') return DEFAULT_OUTLINE;
  const r = raw as Record<string, unknown>;
  const style: OutlineStyle =
    r.style === 'soft' || r.style === 'adaptive' || r.style === 'ink'
      ? r.style
      : DEFAULT_OUTLINE.style;
  const thickness =
    typeof r.thickness === 'number' && Number.isFinite(r.thickness)
      ? Math.max(0, Math.min(2, Math.round(r.thickness)))
      : DEFAULT_OUTLINE.thickness;
  return {
    // 严格 `=== true`：字符串 "false" 也应当被当成关闭
    enabled: r.enabled === true,
    thickness,
    lines: r.lines === 'outline' ? 'outline' : 'cartoon',
    style,
    experimentalParts: r.experimentalParts === true,
  };
}
