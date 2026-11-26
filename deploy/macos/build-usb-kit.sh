#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin || $# -lt 1 || $# -gt 2 ]]; then
  echo "使い方（macOS）: deploy/macos/build-usb-kit.sh <出力フォルダー> [arm64|x64]" >&2
  exit 1
fi
repo="$(cd -- "$(dirname -- "$0")/../.." && pwd -P)"
target="$1"
if [[ "${2:-}" == "universal" ]]; then
  # 兼用キット: ランタイムとネイティブモジュールの取得は build.mjs 側が行う。
  cd "$repo"
  pnpm build
  node deploy/usb-kit/build.mjs universal "$target" "$(command -v node)"
  exit 0
fi
node_version="$(node --version)"
build_arch="$(node -p 'process.arch')"
node_arch="${2:-$build_arch}"
if [[ "$node_arch" != arm64 && "$node_arch" != x64 ]]; then
  echo "アーキテクチャはarm64またはx64です。" >&2
  exit 1
fi
if [[ "$node_version" != v24.* ]]; then
  echo "ビルドにはNode.js 24を使用してください。" >&2
  exit 1
fi
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
archive="node-${node_version}-darwin-${node_arch}.tar.gz"
base="https://nodejs.org/dist/$node_version"
curl -fsSLo "$work/$archive" "$base/$archive"
curl -fsSLo "$work/SHASUMS256.txt" "$base/SHASUMS256.txt"
(cd "$work" && awk -v file="$archive" '$2 == file { print; found = 1 } END { if (!found) exit 1 }' SHASUMS256.txt | shasum -a 256 -c -)
distribution="$work/node-${node_version}-darwin-${node_arch}"
tar -xzf "$work/$archive" -C "$work" "${distribution##*/}/bin/node" "${distribution##*/}/LICENSE"
cd "$repo"
set -- macos "$target" "$distribution/bin/node" "$node_arch"
if [[ "$node_arch" != "$build_arch" ]]; then
  native="@node-usb/usb-darwin-$node_arch"
  version="$(node -p 'require("./apps/printer-host/node_modules/usb/package.json").optionalDependencies[process.argv[1]]' "$native")"
  package="$(npm pack --silent --ignore-scripts --pack-destination "$work" "$native@$version")"
  tar -xzf "$work/$package" -C "$work"
  set -- "$@" "$work/package"
fi
pnpm build
node deploy/usb-kit/build.mjs "$@"
