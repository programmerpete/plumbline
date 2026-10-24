#!/usr/bin/env bash
# Self-test agent: reads the prompt, changes nothing, exits cleanly.
#
# This is the shape of a real failure mode: the agent believes it is done and the
# checkout disagrees. The harness must classify it as no_change, not tests_failed.
set -euo pipefail

cat > /dev/null
exit 0
