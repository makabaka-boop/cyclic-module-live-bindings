import { ax } from './a.mjs';

// 'ax' is still in the temporal dead zone while b.mjs evaluates
// (a.mjs is on the cyclic evaluation stack), so this read throws.
export let bx = ax + 1;
