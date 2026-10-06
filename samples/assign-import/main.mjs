import { count } from './counter.mjs';

// Import bindings are read-only: the assignment below throws when called.
export function main() {
  count = count + 1;
  return count;
}
