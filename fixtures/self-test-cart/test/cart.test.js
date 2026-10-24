import { expect, test } from "bun:test";
import { subtotal, totalWithDiscount } from "../src/cart.js";

test("subtotal multiplies price by quantity", () => {
  expect(
    subtotal([
      { price: 10, quantity: 2 },
      { price: 5, quantity: 1 },
    ]),
  ).toBe(25);
});

test("a percentage discount applies to the subtotal", () => {
  expect(totalWithDiscount([{ price: 10, quantity: 2 }], 0.25)).toBe(15);
});

test("a zero discount leaves the subtotal alone", () => {
  expect(totalWithDiscount([{ price: 3, quantity: 4 }], 0)).toBe(12);
});
