#!/usr/bin/env node
// CLI: node src/cli.js <modulesDir> <entry.mjs> [--call <exportedFn>]
//
// Loads the reachable module graph (at most 6 same-directory .mjs modules),
// links bindings, evaluates module bodies once in dependency order, prints the
// initialization trace, and optionally calls one exported zero-argument
// function of the entry module and prints its result.
//
// Output protocol (consumed by tests/oracle):
//   stdout:  "init <module>" per successfully initialized module, in order
//            then "result: <value>" (with --call) or "ok"
//   stderr:  "error: <CODE>: <message>" / "at: <module>" / "chain: a -> b -> c"
// Exit code: 0 success, 1 module error, 2 usage error.

import path from 'node:path';
import { loadGraph, evaluateGraph, callExported, ModuleError } from './interpreter.js';

function usage() {
  console.error('usage: node src/cli.js <modulesDir> <entry.mjs> [--call <exportedFn>]');
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length < 2) usage();

const [dir, entry, ...rest] = args;
let callName = null;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--call' && i + 1 < rest.length) {
    callName = rest[++i];
  } else {
    usage();
  }
}
if (!entry.endsWith('.mjs') || entry.includes('/')) {
  console.error(`error: entry must be a .mjs file name inside <modulesDir>, got '${entry}'`);
  process.exit(2);
}

let graph = null;
let failure = null;
let result;

try {
  graph = loadGraph(path.resolve(dir), entry);
  evaluateGraph(graph);
  if (callName !== null) result = callExported(graph, entry, callName);
} catch (e) {
  failure = e;
}

if (graph) {
  for (const name of graph.trace) console.log(`init ${name}`);
}

if (failure) {
  if (failure instanceof ModuleError) {
    console.error(`error: ${failure.code}: ${failure.message}`);
    if (failure.module) console.error(`at: ${failure.module}`);
    if (failure.chain && failure.chain.length) console.error(`chain: ${failure.chain.join(' -> ')}`);
  } else {
    console.error(`error: INTERNAL: ${failure.stack || failure.message}`);
  }
  process.exit(1);
}

console.log(callName !== null ? `result: ${String(result)}` : 'ok');
