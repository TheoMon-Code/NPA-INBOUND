#!/usr/bin/env bash
# Runs the whole Playwright test suite against a local copy of the app --
# used by .github/workflows/test.yml (CI, on every push) and just as usable
# by hand.
#
# Expects a plain HTTP server already serving the repo root at
# http://127.0.0.1:8934/ (the app's ES modules refuse to load over file://,
# so something has to serve it) -- this script does NOT start/stop that
# server itself, so it can be started once and left running across several
# runs of this script. From the repo root:
#   python3 -m http.server 8934 &
#   bash tests/run_all.sh
#
# Each test is a small standalone script (asyncio + Playwright, no pytest)
# that mocks the Supabase REST/Storage calls itself (see any test_v2_*.py).
set -u
cd "$(dirname "$0")/.."

PORT=8934
if ! curl -fs "http://127.0.0.1:$PORT/index.html" > /dev/null; then
  echo "Nothing answering on http://127.0.0.1:$PORT/ -- start the local server first, e.g.:"
  echo "  python3 -m http.server $PORT &"
  exit 1
fi

FAILED=0
for f in tests/test_v2_*.py; do
  echo "=== $f ==="
  if ! timeout 120 python3 "$f"; then
    echo "!!! FAILED: $f"
    FAILED=1
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo "One or more test suites failed -- see above."
else
  echo "All test suites passed."
fi
exit "$FAILED"
