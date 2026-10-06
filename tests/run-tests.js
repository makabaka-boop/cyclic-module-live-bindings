// Test runner.
//
// Part 1 (oracle): for every sample case, the interpreter CLI runs in an
// isolated Node child process, and the SAME raw sample files run natively in
// another isolated Node child process (tests/oracle-runner.mjs) as the
// semantic oracle. Outcomes are compared:
//   - module initialization trace (observed natively via appended log lines
//     on temp copies; the raw samples on disk are never modified),
//   - result value of the entry's exported function, or
//   - error class (TDZ / missing export / const-or-import assignment / ...)
//     plus the file the error is located in.
//   Cases with case.json { "oracle": false } are interpreter-only features
//   (syntax rejection, module limit) and are checked against expectations.
//
// Part 2 (white-box): drives src/interpreter.js directly to assert lifecycle
// invariants the CLI cannot observe: failed modules are never re-executed,
// module bodies run exactly once, and live bindings reflect later updates.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadGraph,
  evaluateGraph,
  callExported,
  getExport,
  ModuleError,
} from '../src/interpreter.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const ORACLE = path.join(ROOT, 'tests', 'oracle-runner.mjs');
const CASES = path.join(ROOT, 'samples', 'cases');

let passed = 0;
let failed = 0;
const failures = [];

function check(label, cond, detail = '') {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`${label}${detail ? `\n    ${detail}` : ''}`);
  }
}

function runChild(args) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout.trimEnd(), stderr: r.stderr.trimEnd() };
}

// interpreter JSON-ish output -> normalized record
function normalizeInterp(out) {
  const lines = [...out.stdout.split('\n'), ...out.stderr.split('\n')].filter(Boolean);
  const rec = { inits: [], result: null, error: null, at: null, chain: null };
  for (const line of lines) {
    let m;
    if ((m = line.match(/^init (.+)$/))) rec.inits.push(m[1]);
    else if ((m = line.match(/^result: (.*)$/))) rec.result = m[1];
    else if ((m = line.match(/^error: ([A-Z_]+):/))) rec.error = m[1];
    else if ((m = line.match(/^at: (.+)$/))) rec.at = m[1];
    else if ((m = line.match(/^chain: (.+)$/))) rec.chain = m[1].split(' -> ');
  }
  return rec;
}

function normalizeOracle(stdout) {
  const rec = { inits: [], result: null, error: null, at: null };
  for (const line of stdout.split('\n').filter(Boolean)) {
    let m;
    if ((m = line.match(/^init (.+)$/))) rec.inits.push(m[1]);
    else if ((m = line.match(/^result: (.*)$/))) rec.result = m[1];
    else if ((m = line.match(/^error: (.+)$/))) rec.error = m[1];
    else if ((m = line.match(/^at: (.+)$/))) rec.at = m[1];
  }
  return rec;
}

// interpreter error codes -> oracle error classes
const CODE_TO_ORACLE = {
  TDZ: 'TDZ',
  MISSING_EXPORT: 'MISSING_EXPORT',
  CONST_ASSIGN: 'CONST_ASSIGN',
  ASSIGN_IMPORT: 'CONST_ASSIGN', // native ESM: "Assignment to constant variable."
  NOT_FUNCTION: 'NOT_FUNCTION',
  REF: 'REF',
};

function copyCase(srcDir, dstDir) {
  for (const f of fs.readdirSync(srcDir)) {
    if (f.endsWith('.mjs')) fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
  }
}

function instrument(dir) {
  // Append (never prepend) an init marker so it fires exactly when the module
  // body has finished evaluating — matching the interpreter's trace semantics.
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.mjs')) {
      fs.appendFileSync(path.join(dir, f), `\nconsole.log('init ${f}');\n`);
    }
  }
}

function runCase(caseName) {
  const dir = path.join(CASES, caseName);
  const cfgPath = path.join(dir, 'case.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  const entry = cfg.entry ?? 'main.mjs';
  const call = cfg.call ?? 'main';

  const interp = runChild([CLI, dir, entry, '--call', call]);
  const got = normalizeInterp(interp);

  if (cfg.oracle === false) {
    const exp = cfg.expect ?? {};
    check(`${caseName}: exit code`, interp.code === (exp.exit ?? 1),
      `expected exit ${exp.exit ?? 1}, got ${interp.code} (${interp.stderr})`);
    check(`${caseName}: error code`, got.error === exp.code,
      `expected ${exp.code}, got ${got.error} (${interp.stderr})`);
    if (exp.message) {
      check(`${caseName}: message`, interp.stderr.includes(exp.message),
        `expected substring '${exp.message}' in stderr: ${interp.stderr}`);
    }
    return;
  }

  // Oracle, round 1: raw samples, unmodified.
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), `oracle-raw-${caseName}-`));
  copyCase(dir, rawDir);
  const raw = normalizeOracle(runChild([ORACLE, rawDir, entry, call]).stdout);

  // Oracle, round 2: same samples + appended init markers for the trace.
  const instDir = fs.mkdtempSync(path.join(os.tmpdir(), `oracle-inst-${caseName}-`));
  copyCase(dir, instDir);
  instrument(instDir);
  const inst = normalizeOracle(runChild([ORACLE, instDir, entry, call]).stdout);

  // Sanity: instrumentation must not change the outcome.
  check(`${caseName}: oracle raw == instrumented outcome`,
    raw.result === inst.result && raw.error === inst.error,
    `raw=${JSON.stringify(raw)} inst=${JSON.stringify(inst)}`);

  // Trace: interpreter init order must equal native module-body completion order.
  check(`${caseName}: init trace`, JSON.stringify(got.inits) === JSON.stringify(inst.inits),
    `interp=${JSON.stringify(got.inits)} native=${JSON.stringify(inst.inits)}`);

  // Outcome.
  if (inst.result !== null) {
    check(`${caseName}: result`, got.result === inst.result,
      `interp=${got.result} native=${inst.result}`);
    check(`${caseName}: exit 0`, interp.code === 0, `exit=${interp.code} stderr=${interp.stderr}`);
  } else {
    check(`${caseName}: error class`, got.error !== null && CODE_TO_ORACLE[got.error] === inst.error,
      `interp=${got.error} (-> ${CODE_TO_ORACLE[got.error]}) native=${inst.error}`);
    check(`${caseName}: error file`, got.at === inst.at,
      `interp at=${got.at} native at=${inst.at}`);
    check(`${caseName}: exit 1`, interp.code === 1, `exit=${interp.code}`);
  }

  // Import chain: always entry-first and ending at the module the error is
  // located in (only asserted on the interpreter side; native has no chain).
  if (got.error) {
    check(`${caseName}: chain endpoints`,
      got.chain !== null && got.chain[0] === entry && got.chain[got.chain.length - 1] === got.at,
      `chain=${JSON.stringify(got.chain)} at=${got.at}`);
  }
}

// ---------------------------------------------------------------------------
// Part 1: sample cases
// ---------------------------------------------------------------------------

const caseNames = fs.readdirSync(CASES).filter((f) => fs.statSync(path.join(CASES, f)).isDirectory()).sort();
for (const name of caseNames) runCase(name);

// ---------------------------------------------------------------------------
// Part 2: white-box lifecycle invariants
// ---------------------------------------------------------------------------

function caseDir(n) { return path.join(CASES, n); }

// (a) A failed module is never re-executed within the same run, and is never
//     treated as a successfully evaluated module.
{
  const graph = loadGraph(caseDir('failure-propagation'), 'main.mjs');
  let err1 = null;
  try { evaluateGraph(graph); } catch (e) { err1 = e; }
  check('failure: first evaluation throws TDZ', err1 instanceof ModuleError && err1.code === 'TDZ',
    `got ${err1 && err1.code}`);
  check('failure: failing module latched as failed', graph.modules.get('d.mjs').status === 'failed');
  check('failure: importers latched as failed',
    graph.modules.get('a.mjs').status === 'failed' && graph.modules.get('main.mjs').status === 'failed');
  check('failure: unvisited module stays untouched', graph.modules.get('b.mjs').status === 'new');
  check('failure: side effect ran exactly once', getExport(graph, 'e.mjs', 'attempts') === 1,
    `attempts=${getExport(graph, 'e.mjs', 'attempts')}`);
  check('failure: trace holds only fully initialized modules', JSON.stringify(graph.trace) === JSON.stringify(['e.mjs']),
    `trace=${JSON.stringify(graph.trace)}`);

  let err2 = null;
  try { evaluateGraph(graph); } catch (e) { err2 = e; }
  check('failure: re-evaluation rethrows the recorded error', err2 === err1,
    `got ${err2 && err2.code}`);
  check('failure: failed module body did not re-run', getExport(graph, 'e.mjs', 'attempts') === 1,
    `attempts=${getExport(graph, 'e.mjs', 'attempts')}`);
  check('failure: trace unchanged after re-evaluation', JSON.stringify(graph.trace) === JSON.stringify(['e.mjs']));
}

// (b) Each module body executes exactly once, even when re-evaluated.
{
  const graph = loadGraph(caseDir('counter'), 'main.mjs');
  evaluateGraph(graph);
  const trace1 = [...graph.trace];
  evaluateGraph(graph);
  check('once: second evaluation is a no-op', JSON.stringify(graph.trace) === JSON.stringify(trace1),
    `trace=${JSON.stringify(graph.trace)}`);
}

// (c) Live bindings: the same export reads differently at different times.
{
  const graph = loadGraph(caseDir('counter'), 'main.mjs');
  evaluateGraph(graph);
  const before = getExport(graph, 'counter.mjs', 'count');
  const result = callExported(graph, 'main.mjs', 'main');
  const after = getExport(graph, 'counter.mjs', 'count');
  check('live: counter is 0 before the call', before === 0, `before=${before}`);
  check('live: entry function observes updates through its imports', result === 6, `result=${result}`);
  check('live: same export reads 3 after the updates', after === 3, `after=${after}`);
}

// (d) Legal cycles are accepted and initialize in dependency order.
{
  const graph = loadGraph(caseDir('cycle-ok'), 'main.mjs');
  evaluateGraph(graph);
  check('cycle: init order is b, a, main', JSON.stringify(graph.trace) === JSON.stringify(['b.mjs', 'a.mjs', 'main.mjs']),
    `trace=${JSON.stringify(graph.trace)}`);
  check('cycle: cross-module cyclic function calls work', callExported(graph, 'main.mjs', 'main') === 30,
    `result=${callExported(graph, 'main.mjs', 'main')}`);
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
