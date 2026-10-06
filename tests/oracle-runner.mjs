// Oracle runner: executes a case directory with NATIVE Node ESM semantics and
// prints the outcome in the same format the test harness compares against.
// Usage: node tests/oracle-runner.mjs <dir> <entry.mjs> <exportedFn>
//
// The harness copies the raw sample files into a temp dir (optionally with an
// appended `console.log('init <name>')` line to observe initialization order)
// and points this runner at that dir. Samples on disk are never modified.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [dir, entry, fn] = process.argv.slice(2);

function classify(e) {
  const m = (e && e.message) || '';
  if (e instanceof ReferenceError && /before initialization/.test(m)) return 'TDZ';
  if (e instanceof ReferenceError) return 'REF';
  if (e instanceof SyntaxError && /does not provide an export named/.test(m)) return 'MISSING_EXPORT';
  if (e instanceof TypeError && /Assignment to constant variable/.test(m)) return 'CONST_ASSIGN';
  if (e instanceof TypeError && /is not a function/.test(m)) return 'NOT_FUNCTION';
  return `OTHER:${e && e.constructor ? e.constructor.name : '?'}:${m}`;
}

function topFile(e) {
  for (const line of String((e && e.stack) || '').split('\n')) {
    const mm = line.match(/file:\/\/[^)\s]*?\/([A-Za-z0-9_-]+\.mjs)/);
    if (mm) return mm[1];
  }
  return '';
}

try {
  const mod = await import(pathToFileURL(path.join(dir, entry)).href);
  try {
    const v = mod[fn]();
    console.log(`result: ${String(v)}`);
  } catch (e) {
    console.log(`error: ${classify(e)}`);
    const f = topFile(e);
    if (f) console.log(`at: ${f}`);
  }
} catch (e) {
  console.log(`error: ${classify(e)}`);
  const f = topFile(e);
  if (f) console.log(`at: ${f}`);
}
