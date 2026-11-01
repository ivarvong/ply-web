import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filter,
  find,
  flatMap,
  isNone,
  isSome,
  map,
  match,
  none,
  orElse,
  orNull,
  some,
  unwrapOr,
} from "../src/option.ts";

test("some and none are the only absence values", () => {
  assert.deepEqual(some(1), { tag: "some", value: 1 });
  assert.deepEqual(none(), { tag: "none" });
  assert.equal(none(), none());
  assert.equal(isSome(some(1)), true);
  assert.equal(isSome(none()), false);
  assert.equal(isNone(none()), true);
  assert.equal(isNone(some(1)), false);
});

test("map, flatMap, and filter stay on the present value", () => {
  assert.deepEqual(map(some(2), (n) => n + 1), some(3));
  assert.deepEqual(map(none<number>(), (n) => n + 1), none());
  assert.deepEqual(flatMap(some(2), (n) => some(n * 2)), some(4));
  assert.deepEqual(flatMap(some(2), () => none<number>()), none());
  assert.deepEqual(flatMap(none<number>(), (n) => some(n)), none());
  assert.deepEqual(filter(some(2), (n) => n > 1), some(2));
  assert.deepEqual(filter(some(2), (n) => n > 5), none());
  assert.deepEqual(filter(none<number>(), () => true), none());
});

test("unwrapOr, orElse, orNull, and match cover both tags", () => {
  assert.equal(unwrapOr(none<string>(), "fallback"), "fallback");
  assert.equal(unwrapOr(some("a"), "fallback"), "a");
  assert.deepEqual(orElse(none<number>(), some(3)), some(3));
  assert.deepEqual(orElse(some(1), some(3)), some(1));
  assert.equal(orNull(none<string>()), null);
  assert.equal(orNull(some("a")), "a");
  assert.equal(match(some("a"), (value) => value, () => "z"), "a");
  assert.equal(match(none<string>(), (value) => value, () => "z"), "z");
});

test("find returns the first kept element", () => {
  assert.deepEqual(find([1, 2, 3], (n) => n > 2), some(3));
  assert.deepEqual(find([1, 2], (n) => n > 5), none());
  assert.deepEqual(find([], () => true), none());
});
