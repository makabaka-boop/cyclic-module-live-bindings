import { count, bump } from './counter.mjs';

// Reads the same imported binding twice, before and after updates.
// Live bindings: before = 0, after = 2, result = 2.
// A snapshot-at-import semantics would wrongly compute 0.
export function main() {
  let before = count;
  bump();
  bump();
  let after = count;
  return after - before;
}
