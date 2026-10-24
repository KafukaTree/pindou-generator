# 正在开发 · 可选卡通描边（请勿清理）

状态：进行中。用户于 2026-10-24 明确要求设置协作提示，避免 DSH 并行整理时删除算法代码。

当前负责范围：

- `src/lib/pattern/outline.ts`：在原有可选描边实验上补齐内部结构分界，重点验证粉色熊的肚子/衣服、粉色/深蓝、头/胳膊交界。
- `src/lib/pattern/fuse.ts`：保留熨烫外观独立模块，本轮不重写。
- `AGENTS.md` 与本文件：协作提示和进度。

约束：描边默认关闭；开启只使用独立派生图纸；不修改原图纸 cells/palette；不开启默认网页功能。

请不要把这些文件当作测试残留清理。本轮会把它们纳入 Git，并单独提交实际算法改进。其他页面/组件/PDF 工作不属于本轮，请继续各自修改，不用替本轮整理。

实验与可下载结果保存位置：
`/Users/shaobowen/Documents/Codex/2026-10-24/referenced-chatgpt-conversation-this-is-an/outputs/outline-v2/`

旧版对照与失败证据保留在同一任务的 `outputs/outline-lab/`，不会覆盖旧结果。
