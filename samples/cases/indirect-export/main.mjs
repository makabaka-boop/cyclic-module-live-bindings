import { readN, doBump } from './c.mjs';
import { n } from './b.mjs';
export function main() {
  let x = readN();
  doBump();
  let y = n;
  return y - x;
}
