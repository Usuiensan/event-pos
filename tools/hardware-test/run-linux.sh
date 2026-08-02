#!/usr/bin/env sh
set -eu
: "${PRINTER_DEVICE:?PRINTER_DEVICE is required}"
: "${PRINTER_EVIDENCE_DIR:?PRINTER_EVIDENCE_DIR is required}"
pnpm --filter @event-pos/printer-host hardware-test
pnpm --filter @event-pos/printer-host hardware-test -- --run
