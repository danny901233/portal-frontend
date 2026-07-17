#!/bin/bash
# Print the flow document to PDF via headless Chrome. --no-pdf-header-footer keeps Chrome's
# default URL/date furniture off the page so the design owns the margins.
set -e
SRC="$1"
OUT="$2"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless \
  --disable-gpu \
  --no-pdf-header-footer \
  --print-to-pdf="$OUT" \
  --virtual-time-budget=10000 \
  "file://$SRC" 2>/dev/null
echo "✓ $OUT ($(du -h "$OUT" | cut -f1))"
