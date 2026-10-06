// Test runner. Two kinds of tests:
//
//  1. Oracle cases: each sample directory is executed twice in isolated child
//     processes — once by our interpreter (src/cli.js), once by real Node
//     (dynamic import of the same files). Results / error classes must agree.
//  2. In-process unit tests for limits, syntax rejection and lifecycle rules.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph, instantiate, evaluateGraph, callExport } from '../src/interpreter.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(e.message).split('\n').join('\n     ')}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertThrows(fn, pattern, what) {
  try {
    fn();
  } catch (e) {
    assert(pattern.test(e.message), `${what}: expected error matching ${pattern}, got: ${e.message}`);
    return;
  }
  throw new Error(`${what}: expected an error matching ${pattern}, but none was thrown`);
}

// --- child-process helpers -------------------------------------------------

function runCli(dir, entry, call) {
  const args = [CLI, dir, entry];
  if (call) args.push('--call', call);
  const res = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function runOracle(dir, entry, call) {
  const script =
    `import('./' + ${JSON.stringify(entry)}).then((m) => {` +
    `  const r = m[${JSON.stringify(call)}]();` +
    `  console.log('RESULT:' + String(r));` +
    `}).catch((e) => {` +
    `  console.log('ERROR:' + e.constructor.name);` +
    `  process.exitCode = 3;` +
    `});`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8' });
  const out = res.stdout + res.stderr;
  const rmatch = /^RESULT:(.*)$/m.exec(out);
  const ematch = /^ERROR:(.*)$/m.exec(out);
  if (rmatch) return { ok: true, value: rmatch[1] };
  if (ematch) return { ok: false, errorName: ematch[1].trim() };
  throw new Error(`oracle produced unparseable output (exit ${res.status}): ${out}`);
}

function cliResult(stdout) {
  const m = /^result: \w+\(\) = (.*)$/m.exec(stdout);
  return m ? m[1] : null;
}

function traceLines(stdout, type) {
  return stdout.split('\n').filter((l) => l.startsWith(`trace: ${type} `));
}

// --- oracle cases ------------------------------------------------------------

const oracleCases = [
  {
    name: 'oracle/cycle: cyclic function calls across a module cycle',
    dir: 'samples/cycle',
    expect: { result: '23', initOrder: ['b.mjs', 'a.mjs', 'main.mjs'] },
  },
  {
    name: 'oracle/live: same export read at different times sees updates',
    dir: 'samples/live',
    expect: { result: '2', initOrder: ['counter.mjs', 'main.mjs'] },
  },
  {
    name: 'oracle/tdz: read before initialization inside a cycle',
    dir: 'samples/tdz',
    expect: { error: /Cannot access 'ax' before initialization/, oracleError: 'ReferenceError' },
  },
  {
    name: 'oracle/failure: evaluation failure propagates, failed body runs once',
    dir: 'samples/failure',
    expect: { error: /'missing' is not defined/, oracleError: 'ReferenceError', execOnce: 'bad.mjs' },
  },
  {
    name: 'oracle/missing-export: link-time missing export check',
    dir: 'samples/missing-export',
    expect: { error: /does not provide export 'y'/, oracleError: 'SyntaxError' },
  },
  {
    name: 'oracle/assign-import: import bindings are read-only',
    dir: 'samples/assign-import',
    expect: { error: /Cannot assign to imported binding 'count'/, oracleError: 'TypeError' },
  },
];

for (const c of oracleCases) {
  test(c.name, () => {
    const dir = path.join(ROOT, c.dir);
    const ours = runCli(dir, 'main.mjs', 'main');
    const oracle = runOracle(dir, 'main.mjs', 'main');
    if (c.expect.result !== undefined) {
      assert(ours.code === 0, `CLI exited ${ours.code}: ${ours.stderr}`);
      assert(cliResult(ours.stdout) === c.expect.result, `expected result ${c.expect.result}, got ${cliResult(ours.stdout)}`);
      assert(oracle.ok, `oracle failed: ${oracle.errorName}`);
      assert(oracle.value === c.expect.result, `oracle result ${oracle.value} != expected ${c.expect.result}`);
    } else {
      assert(ours.code === 1, `CLI should fail, exited ${ours.code}: ${ours.stdout}`);
      assert(c.expect.error.test(ours.stderr), `CLI error mismatch.\nstderr: ${ours.stderr}`);
      assert(!oracle.ok, 'oracle should fail too');
      assert(oracle.errorName === c.expect.oracleError, `oracle error ${oracle.errorName} != ${c.expect.oracleError}`);
    }
    if (c.expect.initOrder) {
      const inits = traceLines(ours.stdout, 'init').map((l) => l.split(' ')[2]);
      assert(JSON.stringify(inits) === JSON.stringify(c.expect.initOrder), `init order ${JSON.stringify(inits)}`);
    }
    if (c.expect.execOnce) {
      const execs = traceLines(ours.stdout, 'exec').filter((l) => l.endsWith(` ${c.expect.execOnce}`));
      assert(execs.length === 1, `${c.expect.execOnce} body executed ${execs.length} times, expected exactly 1`);
    }
  });
}

// --- in-process unit tests ---------------------------------------------------

function withModules(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'micromod-'));
  try {
    for (const [name, src] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), src);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runInProcess(dir, entry = 'main.mjs') {
  const trace = [];
  const graph = loadGraph(dir, entry);
  instantiate(graph.modules);
  evaluateGraph(graph.modules, trace);
  return { ...graph, trace };
}

function chainFiles(n) {
  const files = {};
  for (let i = n; i >= 1; i--) {
    if (i === n) files[`f${i}.mjs`] = 'export let v = 1;\n';
    else files[`f${i}.mjs`] = `import { v as w } from './f${i + 1}.mjs';\nexport let v = w + 1;\n`;
  }
  files['f1.mjs'] += 'export function main() { return v; }\n';
  return files;
}

test('unit/limit: 6 modules accepted, 7th rejected', () => {
  withModules(chainFiles(6), (dir) => {
    const { entry } = runInProcess(dir, 'f1.mjs');
    assert(entry.status === 'evaluated', `entry status ${entry.status}`);
    assert(callExport(entry, 'main') === 6, 'chain of 6 should sum to 6');
  });
  withModules(chainFiles(7), (dir) => {
    assertThrows(() => loadGraph(dir, 'f1.mjs'), /limit of 6 modules/, 'module limit');
  });
});

const syntaxRejections = [
  ['const x = 1 * 2;\n', /operator '\*' is not supported/],
  ['let x = 1;\nif (x) { x = 2; }\n', /IfStatement is not supported/],
  ["import * as ns from './x.mjs';\n", /only named imports/],
  ['export default 1;\n', /ExportDefaultDeclaration is not supported/],
  ['let x = -1;\n', /UnaryExpression is not supported/],
  ['const f = () => 1;\n', /ArrowFunctionExpression is not supported/],
  ['let s = "hi";\n', /only numeric literals/],
  ['while (1) {}\n', /WhileStatement is not supported/],
  ['function g(a) { return a; }\n', /only zero-parameter functions/],
  ['let x = 1;\nx += 1;\n', /assignment operator '\+=' is not supported/],
  ['function f() { return 1; }\nlet y = f(1);\n', /only zero-argument calls/],
  ['let x = 1;\nlet x = 2;\n', /already been declared/],
  // Both of these are also caught by acorn's own early-error checks; either
  // the parser's or the validator's message is acceptable.
  ['export { nosuch };\n', /unknown name 'nosuch'|Export 'nosuch' is not defined/],
  ['let x = 1;\nreturn x;\n', /return is only allowed inside a function|'return' outside of function/],
];

for (const [src, pattern] of syntaxRejections) {
  test(`unit/syntax: rejects ${JSON.stringify(src.trim().slice(0, 40))}`, () => {
    withModules({ 'main.mjs': src }, (dir) => {
      assertThrows(() => loadGraph(dir, 'main.mjs'), pattern, 'syntax rejection');
    });
  });
}

test('unit/hoisting: function usable before its declaration position', () => {
  withModules(
    { 'main.mjs': 'export let r = f();\nfunction f() { return 9; }\nexport function main() { return r; }\n' },
    (dir) => {
      const { entry } = runInProcess(dir);
      assert(entry.status === 'evaluated', `entry status ${entry.status}: ${entry.error}`);
      assert(callExport(entry, 'main') === 9, 'hoisted call should yield 9');
    },
  );
});

test('unit/tdz: uninitialized let read throws', () => {
  withModules({ 'main.mjs': 'export function main() { let x; return x; }\n' }, (dir) => {
    const { entry } = runInProcess(dir);
    assertThrows(() => callExport(entry, 'main'), /Cannot access 'x' before initialization/, 'TDZ read');
  });
});

test('unit/const: assignment to const throws', () => {
  withModules({ 'main.mjs': 'const x = 1;\nexport function main() { x = 2; return x; }\n' }, (dir) => {
    const { entry } = runInProcess(dir);
    assertThrows(() => callExport(entry, 'main'), /Assignment to constant variable 'x'/, 'const assignment');
  });
});

test('unit/import-assign: top-level assignment to import binding fails the module', () => {
  withModules(
    {
      'd.mjs': 'export let x = 1;\n',
      'main.mjs': "import { x } from './d.mjs';\nx = 3;\n",
    },
    (dir) => {
      const { entry } = runInProcess(dir);
      assert(entry.status === 'failed', `entry status ${entry.status}`);
      assert(/Cannot assign to imported binding 'x'/.test(entry.error.message), entry.error.message);
    },
  );
});

test('unit/diamond: shared dependency body executes exactly once', () => {
  withModules(
    {
      'c.mjs': 'export let v = 1;\n',
      'l.mjs': "import { v } from './c.mjs';\nexport let l = v + 1;\n",
      'r.mjs': "import { v } from './c.mjs';\nexport let r = v + 1;\n",
      'main.mjs': "import { l } from './l.mjs';\nimport { r } from './r.mjs';\nexport function main() { return l + r; }\n",
    },
    (dir) => {
      const { entry, trace } = runInProcess(dir);
      assert(entry.status === 'evaluated', `entry status ${entry.status}`);
      assert(callExport(entry, 'main') === 4, 'diamond should sum to 4');
      const execs = trace.filter((t) => t.type === 'exec' && t.module === 'c.mjs');
      assert(execs.length === 1, `c.mjs executed ${execs.length} times`);
    },
  );
});

test('unit/failure: failed module keeps recorded error, dependents fail without re-running it', () => {
  const dir = path.join(ROOT, 'samples', 'failure');
  const { entry, modules, trace } = runInProcess(dir);
  const bad = modules.find((m) => m.name === 'bad.mjs');
  assert(bad.status === 'failed', 'bad.mjs should be failed');
  assert(entry.status === 'failed', 'entry should be failed');
  for (const name of ['left.mjs', 'right.mjs', 'main.mjs']) {
    const m = modules.find((x) => x.name === name);
    assert(m.status === 'failed', `${name} should be failed`);
    assert(m.error === bad.error, `${name} should carry bad.mjs's recorded error`);
  }
  const execs = trace.filter((t) => t.type === 'exec' && t.module === 'bad.mjs');
  assert(execs.length === 1, `bad.mjs body ran ${execs.length} times, expected exactly 1`);
});

test('unit/call-non-function: calling a non-function binding throws', () => {
  withModules({ 'main.mjs': 'let x = 1;\nexport function main() { return x(); }\n' }, (dir) => {
    const { entry } = runInProcess(dir);
    assertThrows(() => callExport(entry, 'main'), /'x' is not a function/, 'call non-function');
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
