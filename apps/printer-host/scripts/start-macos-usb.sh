#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
if [[ ! -f "$repo_root/.env" ]]; then
  echo "リポジトリ直下に .env を作成してください" >&2
  exit 1
fi

set -a
source "$repo_root/.env"
set +a

if [[ -z "${PRINTER_HOST_TOKEN:-}" ]]; then
  echo "PrinterHostをネットワーク公開するため、.envにPRINTER_HOST_TOKENを設定してください" >&2
  exit 1
fi

export PRINTER_BACKEND=macos-usb
export PRINTER_HOST_BIND="${PRINTER_HOST_BIND:-0.0.0.0}"
export PORT=4318
export PRINTER_USB_VENDOR_ID=0x04b8
export PRINTER_USB_PRODUCT_ID=0x0202
export PRINTER_USB_SERIAL_NUMBER=544444460135950000

cd "$repo_root"
exec pnpm --filter @event-pos/printer-host dev
