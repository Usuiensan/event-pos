#!/bin/bash
set -eu

kit="$(cd -- "$(dirname -- "$0")" && pwd -P)"
cd "$kit"
# 兼用キットはアーキテクチャ別のNodeを同梱する。Mac単体キット（runtime/node のみ）にも対応する。
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
exec "$node" "$kit/server/dist/start.mjs"
