# 拼豆图纸工坊 · Perler Bead Atelier

把任意图片变成能真的照着一颗一颗拼出来的图纸 —— 真实品牌色号、精确颗数、带行列标尺的 A4 打印页。

## 这个工具在解决什么

网上的"像素化生成器"很多，但绝大多数不能用来真的拼豆。它们有三个共同问题：

1. **颜色是编出来的。** 输出的 RGB 落在色卡之外，你拿着色号去买豆，买到的是另一种颜色。
2. **颗粒数是错的。** 界面上说"12 色 300 颗"，导出的图纸数出来是 1574 颗，两个数谁也不认。
3. **印出来的图纸没法照做。** 50×50 的图印在 A4 上每格只有 3.6mm，色号印不进去，也没有行列标尺 —— 拼到第 30 行就不知道自己第几列了。

这个版本把三件事都当硬指标做：色号必须来自真实色卡（MARD / COCO / 漫漫 / 盼盼 / 咪小窝，各 291 色）；屏幕、图例、PDF、历史记录读的是同一份 `PatternResult`；PDF 按 100% 打印比例分页，每页都有全局行列标尺和跨页重叠带。

## 主要能力

| 能力 | 说明 |
|---|---|
| 网格 16–320 | 320 格 ≈ 8.7 万颗，大图会自动提示分板制作 |
| 四种精细度 | 均衡 / 锐利 / 粗块 / 圆润，分别针对照片、像素画、低分辨率素材、手绘角色 |
| 背景处理 | 自动裁背景 / 忽略背景 / 抖动混色，避免整图补白成正方形浪费豆子 |
| 区域重算 | 刷子拖动选区 → 应用重建，只重算选中区域，支持羽化过渡带 |
| 手工编辑 | 手绘 / 橡皮 / 取色器 / 油漆桶，291 色色卡浮层，Ctrl+Z 撤销 |
| 打印图纸 | A4 分页、全局标尺、每格色号或大色块标注、封面与用料清单 |
| 历史记录 | 同图多次调参归档为版本，不刷屏；localStorage 压缩存储 |

## 快速开始

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm build        # 生产构建
npx tsc --noEmit  # 类型检查
npx eslint src    # 代码检查
```

示例素材在 `public/samples/`，直接在页面上点"先放图"即可试。

## 技术栈

Next.js 16（App Router）· React 19 · TypeScript · Tailwind v4 · Radix UI · jsPDF · quantize

## 目录

```
src/
  app/
    page.tsx              工作台主页面（布局、状态、导出接线）
    api/pdf/route.ts      PDF 生成（服务端 jsPDF，分页与标注）
    globals.css           设计系统（双主题、纸面五层、像素风工具类）
  components/
    image-upload/         上传与示例素材
    settings/             网格、颜色数、品牌、适配方式、精细度
    pattern-rendering/    画布渲染器（缩放/平移/标尺/色号/工具提示）+ 编辑与刷区域
    palette/              用料清单
    pdf-export/           导出按钮与请求
    history/              历史记录弹窗
    scenery/              像素场景装饰与吉祥物
  lib/
    colors.ts             色卡读取与 OKLab 距离
    colorMapping.json     291 色 × 5 品牌色号对照
    pattern/
      generate.ts         量化引擎（17 步流水线，含特征救援）
      features.ts         源图结构特征检测
      resample.ts         超采样 / 双边滤波 / 裁切
      regions.ts          区域重算场解算
      detail.ts           四档精细度参数
      edits.ts            手工编辑叠加层与撤销
  hooks/
    useHistory.ts         历史记录单例 store
tools/
  engine-lab/             无头引擎测试台 + 两个验收门禁
```

## 引擎验收门禁

引擎改动必须同时通过两组门禁，命令在 `tools/engine-lab/`：

```bash
node tools/engine-lab/regress.mjs   # 四图 × 两档 的画面质量基线，8/8 才算过
node tools/engine-lab/eye.mjs       # 鸭吉吉眼睛在 64/80/96 三档都要保住白眼球与黑瞳，3/3 才算过
```

`regress.mjs` 锁死的是"碎块数不增加、色号数不增加"，防止为了救局部细节把整张图切成噪点；
`eye.mjs` 锁死的是"小面积高对比特征不能丢"，这类特征在众数表决里最容易消失。

## 设计

界面走"温暖手作工坊"：纸面质感的暖白、硬边阴影（没有模糊）、像素字形只用于色号和坐标这类机械信息。
双主题（日间工作台 / 夜灯工作台），吉祥物是一只趴在画布边沿看图的像素小鸭。

## 部署

推到 `main` 分支后由 Vercel 自动构建。当前仓库未初始化 CI，两个门禁需要手动跑或后续接进 GitHub Actions。
