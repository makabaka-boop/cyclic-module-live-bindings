import { count, inc } from './counter.mjs';
import { early } from './snap.mjs';
export function main() {
  let before = count;
  inc();
  inc();
  inc();
  let after = count;
  return (after - before) + (count - early);
}
