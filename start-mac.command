#!/bin/bash
# Mini Metro 复刻版 · macOS 单机启动
# 双击本文件即可（第一次可能需要先执行一次 chmod +x，见 README-mac.md）

cd "$(dirname "$0")" || exit 1

echo ""
echo "  Mini Metro 复刻版 · 单机"
echo "  ────────────────────────────────"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  找不到 Node.js。"
  echo ""
  echo "  Mac 上装 Node.js 最简单的两种办法："
  echo "    1) 到 https://nodejs.org 下载 macOS 安装包（选 LTS），装完重开这个文件"
  echo "    2) 如果装了 Homebrew，在终端执行：  brew install node"
  echo ""
  echo "  只想先随便玩玩的话，其实不用装 Node："
  echo "  直接双击 dist/minimetro.html 就能离线玩单机。"
  echo ""
  read -n 1 -s -r -p "  按任意键关闭…"
  exit 1
fi

echo "  Node.js: $(node -v)"
echo "  正在启动，浏览器会自动打开…"
echo "  关闭这个终端窗口 = 停止服务。"
echo ""

node tools/serve.mjs
