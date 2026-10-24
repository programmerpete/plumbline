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
  return subtotal(items) - discountRate;
}
