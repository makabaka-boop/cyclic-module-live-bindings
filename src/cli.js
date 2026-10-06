#!/usr/bin/env node
import { loadGraph, instantiate, evaluateGraph, callExport, VOID } from './interpreter.js';
import { ModuleError, formatError } from './errors.js';

const USAGE = `Usage: node src/cli.js <modules-dir> <entry-file> [--call <exported-fn>]

Runs a restricted ES-module interpreter over at most 6 same-directory .mjs
files. Prints the module initialization trace, then (with --call) the result
of invoking one exported zero-argument function of the entry module.`;

function parseArgs(argv) {
  const positional = [];
  let call = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--call') {
      if (i + 1 >= argv.length) throw new Error('--call requires a function name');
      call = argv[++i];
    } else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (a.startsWith('--')) {
      throw new Error(`unknown option: ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 2) throw new Error('expected <modules-dir> and <entry-file>');
  return { dir: positional[0], entry: positional[1], call };
}

function printTrace(trace) {
  for (const ev of trace) {
    if (ev.type === 'exec') console.log(`trace: exec ${ev.module}`);
    else if (ev.type === 'init') console.log(`trace: init ${ev.module}`);
    else if (ev.type === 'fail') console.log(`trace: fail ${ev.module}: ${ev.message}`);
  }
}

function report(err) {
  if (err instanceof ModuleError) {
    console.error(formatError(err));
  } else {
    console.error(`error: [internal] ${err && err.stack ? err.stack : err}`);
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}`);
    console.error(USAGE);
    process.exit(2);
  }

  const trace = [];
  let entry;
  try {
    const graph = loadGraph(args.dir, args.entry);
    entry = graph.entry;
    instantiate(graph.modules); // bindings + missing-export check for the whole graph
    evaluateGraph(graph.modules, trace); // each module body runs at most once
  } catch (e) {
    printTrace(trace);
    report(e);
    process.exit(1);
  }

  printTrace(trace);

  if (entry.status === 'failed') {
    report(entry.error);
    process.exit(1);
  }

  if (args.call !== null) {
    let result;
    try {
      result = callExport(entry, args.call);
    } catch (e) {
      report(e);
      process.exit(1);
    }
    const shown = result === VOID ? '(no return value)' : String(result);
    console.log(`result: ${args.call}() = ${shown}`);
  }
  process.exit(0);
}

main();
