import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "麦麦取餐交接官 · 帮我取一下",
  description: "选好麦当劳订单，把门店、餐品和取餐码发给朋友。取餐前再刷新一次，信息就清楚了。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
