import type { Metadata, Viewport } from 'next';
import { Silkscreen } from 'next/font/google';
import './globals.css';

/**
 * 字体策略
 * - --font-pixel：拉丁/数字用的像素字体（Silkscreen，体积小、字形干净）。
 *   只作用于色号、坐标、计数这类"机械信息"，让它们一眼可辨。
 * - --font-ui / --font-display：中文交给系统字体栈。
 *   理由：中文网络字体动辄 5–10MB，会让首屏和构建都变慢；
 *   而 PingFang SC / 微软雅黑 在目标平台上都已是高质量字形，
 *   配合字重与字距即可做出"手作感"的标题层次。
 */
const silkscreen = Silkscreen({
  variable: '--font-pixel-latin',
  weight: ['400', '700'],
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: '拼豆图纸工坊 · Perler Bead Atelier',
  description:
    '把任意图片变成可拼的拼豆图纸：真实品牌色号、精确颗数统计、带行列标尺的可打印 A4 图纸。',
  applicationName: '拼豆图纸工坊',
  keywords: ['拼豆', '拼豆图纸', 'perler beads', '拼豆色号', 'MARD', 'COCO', '像素画'],
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F8F3F2' },
    { media: '(prefers-color-scheme: dark)', color: '#221A1E' },
  ],
};

/**
 * 在 hydration 前定主题，避免深色模式闪白。
 *
 * 存储值由 `writeStorage` 写入，是 **JSON 编码**的（`"dark"` 带引号），
 * 所以这里不能拿裸字符串直接比 —— 之前就是栽在这上面：初始化脚本永远
 * 判定为"没存过"，于是跟随系统；而页面里的 effect 又用 JSON.parse 读出了
 * 'dark' 并 toggle 一次，两者打架，结果刷新后深色主题时有时无。
 * 现在两种形式都认，并以 JSON 为准。
 */
const themeInit = `
(function(){
  try {
    var raw = localStorage.getItem('pindou.theme');
    var saved = null;
    if (raw) {
      try { saved = JSON.parse(raw); } catch (e) { saved = raw; }
      if (saved !== 'dark' && saved !== 'light') saved = null;
    }
    var dark = saved
      ? saved === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className={`${silkscreen.variable} antialiased`}>{children}</body>
    </html>
  );
}
