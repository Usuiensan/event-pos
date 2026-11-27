#!/bin/bash
kit="$(cd -- "$(dirname -- "$0")" && pwd -P)"
cd "$kit"
# 更新で .new へ退避された新版があれば、実行前に差し替える（Update-USB-Kit.bat と同じ方式）。
if [ -f "$kit/Update-USB-Kit.command.new" ]; then
  if ! mv -f "$kit/Update-USB-Kit.command.new" "$kit/Update-USB-Kit.command"; then
    echo "更新ランチャーの差し替えに失敗しました: $kit/Update-USB-Kit.command.new" >&2
    echo "キーを押すと閉じます。"
    read -n 1 -s -r
    exit 1
  fi
  chmod +x "$kit/Update-USB-Kit.command"
  exec "$kit/Update-USB-Kit.command" "$@"
fi
if [ ! -f "$kit/update-usb-kit.mjs" ] && [ -f "$kit/update-usb-kit.mjs.prev" ]; then
  mv -f "$kit/update-usb-kit.mjs.prev" "$kit/update-usb-kit.mjs"
fi
if [ -f "$kit/update-usb-kit.mjs.new" ]; then
  if [ -f "$kit/update-usb-kit.mjs" ]; then
    mv -f "$kit/update-usb-kit.mjs" "$kit/update-usb-kit.mjs.prev"
  fi
  if ! mv -f "$kit/update-usb-kit.mjs.new" "$kit/update-usb-kit.mjs"; then
    echo "アップデーター本体の差し替えに失敗しました: $kit/update-usb-kit.mjs.new" >&2
    echo "キーを押すと閉じます。"
    read -n 1 -s -r
    exit 1
  fi
fi
if [ ! -f "$kit/update-usb-kit.mjs" ]; then
  echo "アップデーター本体が見つかりません: $kit/update-usb-kit.mjs" >&2
  echo "キーを押すと閉じます。"
  read -n 1 -s -r
  exit 1
fi
case "$(uname -m)" in
  arm64) node="$kit/runtime/node-arm64" ;;
  x86_64) node="$kit/runtime/node-x64" ;;
  *) echo "未対応のアーキテクチャです: $(uname -m)" >&2; exit 1 ;;
esac
if [ ! -x "$node" ]; then
  if [ -x "$kit/runtime/node" ]; then
    node="$kit/runtime/node"
  else
    echo "Nodeランタイムが見つかりません: $node" >&2
    exit 1
  fi
fi
"$node" "$kit/update-usb-kit.mjs" "$@"
rc=$?
if [ $rc -ne 0 ]; then
  echo
  echo "エラーで終了しました。内容を確認して、キーを押すと閉じます。"
  read -n 1 -s -r
  exit $rc
fi
echo
echo "終了しました。このウィンドウは10秒後に閉じます（何かキーを押すとすぐ閉じます）。"
read -t 10 -n 1 -s -r || true
exit 0
