#!/usr/bin/env sh
set -eu
: "${PRINTER_DEVICE:?PRINTER_DEVICE is required}"
: "${PRINTER_EVIDENCE_DIR:?PRINTER_EVIDENCE_DIR is required}"
take_device=false
if [ "${1:-}" = "--take-device" ]; then take_device=true; fi
if [ "$take_device" != true ]; then
  echo "--take-device is required because this stops the existing printer service and sends DLE EOT/fixture bytes" >&2
  exit 2
fi
service_name=${DISCORD_PRINTER_SERVICE:-discord-printer-bot}
mkdir -p "$PRINTER_EVIDENCE_DIR"
git -C /opt/discord-printer-bot rev-parse HEAD > "$PRINTER_EVIDENCE_DIR/debian-reference-commit.txt"
systemctl cat "$service_name" > "$PRINTER_EVIDENCE_DIR/service-before.txt"
systemctl status "$service_name" --no-pager > "$PRINTER_EVIDENCE_DIR/status-before.txt" || true
systemctl stop "$service_name"
trap 'systemctl start "$service_name"; systemctl status "$service_name" --no-pager > "$PRINTER_EVIDENCE_DIR/status-after.txt" || true; journalctl -u "$service_name" --no-pager -n 200 > "$PRINTER_EVIDENCE_DIR/journal-after.txt" || true' EXIT
if command -v fuser >/dev/null 2>&1 && fuser "$PRINTER_DEVICE" > "$PRINTER_EVIDENCE_DIR/device-holders.txt" 2>&1; then
  echo "printer device is still held; refusing probe" >&2
  exit 1
fi
pnpm --filter @event-pos/printer-host hardware-test
pnpm --filter @event-pos/printer-host hardware-test -- --run
