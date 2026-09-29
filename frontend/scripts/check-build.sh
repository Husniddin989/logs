#!/bin/sh
# Fails when a production build would expose the original source code.
set -eu

BUILD_DIR="${1:-build}"
status=0

maps=$(find "$BUILD_DIR" -type f -name '*.map')
if [ -n "$maps" ]; then
  echo "ERROR: source maps found in $BUILD_DIR:" >&2
  echo "$maps" >&2
  status=1
fi

refs=$(find "$BUILD_DIR" -type f \( -name '*.js' -o -name '*.css' \) -exec grep -l 'sourceMappingURL=' {} + || true)
if [ -n "$refs" ]; then
  echo "ERROR: sourceMappingURL references found in:" >&2
  echo "$refs" >&2
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "Build check passed: no source maps in $BUILD_DIR"
fi
exit "$status"
