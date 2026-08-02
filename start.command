#!/bin/bash
cd "$(dirname "$0")"
echo "=============================================="
echo " Store Control — локальный сервер (Mac)"
echo "=============================================="
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo " Node.js не установлен."
  echo " Скачайте кнопку LTS с https://nodejs.org , установите и запустите этот файл снова."
  echo ""
  read -p " Нажмите Enter, чтобы закрыть..."
  exit 1
fi
node server-local.js
