#!/usr/bin/env bash
# Self-test agent: performs the known fix for fixtures/self-test-cart.
#
# A real agent reads the prompt and works it out. This one exists so the harness
# can be exercised end to end with no model, no network, and no API key. It is
# deliberately independent of the task's reference patch: if the two ever
# disagree, the oracle fails and the self-tests say so.
set -euo pipefail

cat > src/cart.js <<'JS'
/**
 * A deliberately small module used by plumbline's self-tests.
 *
 * It contains one real bug: `totalWithDiscount` subtracts the rate as an absolute
 * amount instead of a proportion of the subtotal. Every self-test task points at
 * this directory, so the harness can be exercised without Xcode or an API key.
 */

export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

export function totalWithDiscount(items, discountRate) {
  return subtotal(items) * (1 - discountRate);
}
JS
