#!/usr/bin/env bash
# Self-test agent: fails before doing any work.
set -euo pipefail

cat > /dev/null
echo "stub-error: no model configured" >&2
exit 3
