import { getA } from './a.mjs';
export let bVal = getA() + 1;
export function fb() { return getA() + bVal; }
