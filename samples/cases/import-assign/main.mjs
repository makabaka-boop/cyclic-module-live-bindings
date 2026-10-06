import { count, inc } from './counter.mjs';
export function main() {
  inc();
  count = 99;
  return count;
}
