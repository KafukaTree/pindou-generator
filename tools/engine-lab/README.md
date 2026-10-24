# 引擎实验台（engine-lab）

无头运行拼豆量化引擎，不开浏览器、不开 dev server。算法改动的所有客观
验收都在这里，**不要靠肉眼看网页来验证算法**。

## 用法

```bash
node tools/engine-lab/regress.mjs   # 四图回归门禁（必须 ALL PASS）
node tools/engine-lab/eye.mjs       # 鸭吉吉眼睛专项（64/80/96 三档都必须 PASS）
node tools/engine-lab/render.mjs duck /tmp/duck.png   # 渲染对比图看效果
```

退出码：全通过 0，有失败 1。可以直接进 CI。

## 原理

`engine.mjs` 从 `src/lib/pattern/generate.ts` 出发收集依赖图，用项目自带的
`typescript.transpileModule` 转成 CJS 写进临时目录，注入最小的
`ImageData` / `document` 垫片，再用 `sharp` 把 PNG 解成 RGBA。**跑的是真实
源码**，改完 `generate.ts` 立刻生效，不需要编译，也不需要重启任何东西。

## 测试素材

`public/samples/` 下四张：`cat.png`（洛克猫）、`duck.png`（鸭吉吉）、
`leaf.png`（草叶兽）、`turtle.png`（乌龟）。风格差异覆盖了：纯色块卡通、
近白小特征、细线条、多色渐变甲壳。

## 导出 API

```js
import { loadImage, generate, stats, renderPng, SAMPLES, cleanup } from './engine.mjs';

const img = await loadImage(SAMPLES.duck);
const p = generate(img, {
  gridSize: 96,          // 目标长边格数
  aspect: img.width / img.height,
  brand: 'MARD',
  colorLimit: 24,
  fit: 'contain',
  smoothing: 0.6,
  autoCrop: true,
  background: 'ignore',
  chromaBoost: 1.1,
  detail: 'balanced',    // 'balanced' | 'crisp' | 'chunky' | 'chibi'
});
// p = { cols, rows, cells: Int16Array(-1=空), palette: [{hex,code,lab}], totalBeads, meanDeltaE, meta }
cleanup();
```

`stats(p)` 返回 `{ cols, rows, filled, colors, blocks, micro, biggest,
isolatedRate, edgeRate, totalBeads, meanDeltaE }`。

- `blocks` = 4 邻域同色连通块总数（越少画面越整）
- `micro` = 面积 < 3 格的连通块数（碎点，越少越好）

## 其他脚本（按需）

| 脚本 | 用途 |
|---|---|
| `eyeloc.mjs` | 把白/黑豆的坐标 dump 出来，看它们落在眼部哪个位置 |
| `eyecount.mjs` | 按理论面积预算对比实际白豆数 |
| `verify-white.mjs` | 直接统计源图的近白/近黑像素连通分量（不含引擎） |
| `duck64.mjs` | gs × colorLimit 扫描，只报有没有白 |
| `vfy2.mjs` → 已被 `regress.mjs` 取代 |

## 注意

- 这些脚本只读 `public/samples/` 和 `src/`，不改任何生产文件。
- `.work/` 是更早的临时调试目录，已在 `.gitignore` 里，可以忽略。
