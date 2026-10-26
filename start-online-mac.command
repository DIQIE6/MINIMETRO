#!/bin/bash
# Mini Metro 复刻版 · macOS 联机主机
# 当主机的人双击本文件。局域网里的其他人不需要任何操作，用浏览器打开打印的地址即可。

cd "$(dirname "$0")" || exit 1

echo ""
echo "  Mini Metro 复刻版 · 联机主机（同图竞速）"
echo "  ────────────────────────────────────────"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  找不到 Node.js，联机模式必须要它。"
  echo ""
  echo "    1) 到 https://nodejs.org 下载 macOS 安装包（选 LTS），装完重开这个文件"
  echo "    2) 如果装了 Homebrew，在终端执行：  brew install node"
  echo ""
  read -n 1 -s -r -p "  按任意键关闭…"
  exit 1
fi

echo "  Node.js: $(node -v)"
echo ""
echo "  启动后浏览器会自动打开，把下面打印的「局域网」地址发给其他人。"
echo "  其他人用浏览器打开那个地址 → 选「联机模式」→ 输入你屏幕上的 4 位房间号。"
echo "  关闭这个终端窗口 = 停止主机。"
echo ""

node tools/net-server.mjs
