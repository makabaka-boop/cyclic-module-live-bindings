import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'acorn';
import { validateModule } from './validator.js';
import { ModuleError } from './errors.js';

export const MAX_MODULES = 6;

// Only same-directory relative specifiers like './util.mjs'.
const SPECIFIER_RE = /^\.\/([A-Za-z0-9_-]+\.mjs)$/;

// Sentinel for "function finished without a return statement".
export const VOID = Symbol('void');

// ---------------------------------------------------------------------------
// Bindings and scopes
// ---------------------------------------------------------------------------

class Binding {
  constructor(kind) {
    this.kind = kind; // 'fn' | 'let' | 'const' | 'import'
    this.initialized = false;
    this.value = undefined;
    // For kind === 'import': the binding is a live reference to
    // targetModule's exported slot named targetName. Reads and writes
    // are forwarded, so importers observe later updates (live binding).
    this.targetModule = null;
    this.targetName = null;
  }
}

class Env {
  constructor(parent = null, moduleRec = null) {
    this.vars = new Map();
    this.parent = parent;
    this.module = moduleRec || (parent && parent.module) || null;
  }
  lookup(name) {
    let e = this;
    while (e) {
      if (e.vars.has(name)) return e.vars.get(name);
      e = e.parent;
    }
    return null;
  }
}

class ModuleRecord {
  constructor(absPath, name, ast) {
    this.absPath = absPath;
    this.name = name;
    this.ast = ast;
    this.env = new Env(null, this);
    this.imports = []; // { localName, exportName, specifier, dep }, source order
    this.exports = new Map(); // exportName -> localName
    this.status = 'linked'; // linked | evaluating | evaluated | failed
    this.error = null;
    this.chain = [name]; // import chain from the entry, for diagnostics
  }
}

// ---------------------------------------------------------------------------
// Phase 1: load + parse + validate the full reachable graph (source order)
// ---------------------------------------------------------------------------

export function loadGraph(dir, entryFile) {
  const root = path.resolve(dir);
  const modules = new Map();
  const order = [];

  const load = (relFile, chain) => {
    const abs = path.resolve(root, relFile);
    if (path.dirname(abs) !== root) {
      throw new ModuleError('resolution', `Module '${relFile}' escapes the modules directory`, { chain });
    }
    const name = path.basename(abs);
    if (modules.has(abs)) return modules.get(abs);
    if (modules.size >= MAX_MODULES) {
      throw new ModuleError('limit', `Module graph exceeds the limit of ${MAX_MODULES} modules (while loading '${name}')`, {
        file: name,
        chain: [...chain, name],
      });
    }
    let source;
    try {
      source = fs.readFileSync(abs, 'utf8');
    } catch {
      throw new ModuleError('resolution', `Cannot read module '${name}'`, { file: name, chain: [...chain, name] });
    }
    let ast;
    try {
      ast = parse(source, { ecmaVersion: 2022, sourceType: 'module', locations: true });
    } catch (e) {
      throw new ModuleError('syntax', `Parse error in ${name}: ${e.message}`, {
        file: name,
        chain: [...chain, name],
      });
    }
    const m = new ModuleRecord(abs, name, ast);
    m.chain = [...chain, name];
    try {
      validateModule(ast, name);
    } catch (e) {
      if (e instanceof ModuleError && !e.chain) e.chain = m.chain;
      throw e;
    }
    modules.set(abs, m);
    order.push(m);
    // Visit dependencies in source order.
    for (const stmt of ast.body) {
      if (stmt.type !== 'ImportDeclaration') continue;
      const spec = stmt.source.value;
      const match = SPECIFIER_RE.exec(spec);
      if (!match) {
        throw new ModuleError('resolution', `Unsupported module specifier '${spec}' in ${name}: only same-directory './x.mjs' specifiers are allowed`, {
          file: name,
          line: stmt.loc.start.line,
          col: stmt.loc.start.column + 1,
          chain: m.chain,
        });
      }
      const dep = load('./' + match[1], m.chain);
      for (const s of stmt.specifiers) {
        m.imports.push({ localName: s.local.name, exportName: s.imported.name, specifier: spec, dep });
      }
    }
    return m;
  };

  const entry = load(entryFile, []);
  return { entry, modules: order };
}

// ---------------------------------------------------------------------------
// Phase 2: instantiate — create all bindings for the whole reachable graph,
// hoist functions, then check that every import resolves to a real export.
// ---------------------------------------------------------------------------

function declareIn(env, name, binding, node, m) {
  if (env.vars.has(name)) {
    throw new ModuleError('syntax', `Identifier '${name}' has already been declared`, {
      file: m.name,
      line: node.loc ? node.loc.start.line : null,
      col: node.loc ? node.loc.start.column + 1 : null,
      chain: m.chain,
    });
  }
  env.vars.set(name, binding);
}

function functionValue(node, m) {
  return { type: 'fn', node, module: m };
}

function declareFunction(m, env, node) {
  const b = new Binding('fn');
  b.initialized = true; // hoisted: available before the module body runs
  b.value = functionValue(node, m);
  declareIn(env, node.id.name, b, node, m);
}

function declareVar(m, env, name, kind, node) {
  const b = new Binding(kind); // 'let' | 'const', starts uninitialized (TDZ)
  declareIn(env, name, b, node, m);
}

function registerExport(m, exportedName, localName, node) {
  if (m.exports.has(exportedName)) {
    throw new ModuleError('syntax', `Duplicate export '${exportedName}'`, {
      file: m.name,
      line: node.loc ? node.loc.start.line : null,
      col: node.loc ? node.loc.start.column + 1 : null,
      chain: m.chain,
    });
  }
  m.exports.set(exportedName, localName);
}

export function instantiate(modules) {
  // Pass 1: local bindings; function declarations are initialized immediately.
  for (const m of modules) {
    for (const stmt of m.ast.body) {
      if (stmt.type === 'FunctionDeclaration') {
        declareFunction(m, m.env, stmt);
      } else if (stmt.type === 'VariableDeclaration') {
        for (const d of stmt.declarations) declareVar(m, m.env, d.id.name, stmt.kind, d);
      } else if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) {
        const decl = stmt.declaration;
        if (decl.type === 'FunctionDeclaration') {
          declareFunction(m, m.env, decl);
          registerExport(m, decl.id.name, decl.id.name, decl);
        } else {
          for (const d of decl.declarations) {
            declareVar(m, m.env, d.id.name, decl.kind, d);
            registerExport(m, d.id.name, d.id.name, d);
          }
        }
      }
    }
  }
  // Pass 2: import bindings (live references into the exporter's environment).
  for (const m of modules) {
    for (const imp of m.imports) {
      const b = new Binding('import');
      b.targetModule = imp.dep;
      b.targetName = imp.exportName;
      declareIn(m.env, imp.localName, b, m.ast, m);
    }
  }
  // Pass 3: 'export { x }' / 'export { x as y }' specifiers.
  for (const m of modules) {
    for (const stmt of m.ast.body) {
      if (stmt.type !== 'ExportNamedDeclaration' || stmt.declaration) continue;
      for (const s of stmt.specifiers) {
        const local = s.local.name;
        if (!m.env.vars.has(local)) {
          throw new ModuleError('link', `Module '${m.name}' exports unknown name '${local}'`, {
            file: m.name,
            line: s.loc.start.line,
            col: s.loc.start.column + 1,
            chain: m.chain,
          });
        }
        registerExport(m, s.exported.name, local, s);
      }
    }
  }
  // Pass 4: every import must resolve to an existing export of the dependency.
  for (const m of modules) {
    for (const imp of m.imports) {
      if (!imp.dep.exports.has(imp.exportName)) {
        throw new ModuleError('link', `Module '${imp.dep.name}' does not provide export '${imp.exportName}' (imported by '${m.name}')`, {
          file: m.name,
          chain: m.chain,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 3: evaluation. Each module body runs at most once. A failed module
// stays failed and is never re-executed; dependents re-throw its recorded
// error. Cyclic edges to a module that is currently evaluating are legal:
// they simply observe whatever bindings exist at that point (TDZ applies).
// ---------------------------------------------------------------------------

export function evaluateGraph(modules, trace) {
  for (const m of modules) {
    try {
      evaluateModule(m, trace);
    } catch {
      // Recorded on the module. Keep settling the rest of the graph so that
      // every module ends up either 'evaluated' or 'failed', exactly once.
    }
  }
}

function evaluateModule(m, trace) {
  if (m.status === 'evaluated') return;
  if (m.status === 'failed') throw m.error; // never re-run a failed body
  if (m.status === 'evaluating') return; // cyclic edge: legal, see note above
  m.status = 'evaluating';
  try {
    const seen = new Set();
    for (const imp of m.imports) {
      if (seen.has(imp.dep)) continue;
      seen.add(imp.dep);
      evaluateModule(imp.dep, trace);
    }
    trace.push({ type: 'exec', module: m.name });
    execModuleBody(m);
    m.status = 'evaluated';
    trace.push({ type: 'init', module: m.name });
  } catch (e) {
    m.status = 'failed';
    m.error = e;
    trace.push({ type: 'fail', module: m.name, message: e.message });
    throw e;
  }
}

function execModuleBody(m) {
  for (const stmt of m.ast.body) {
    switch (stmt.type) {
      case 'ImportDeclaration':
      case 'FunctionDeclaration':
        break; // hoisted at instantiation
      case 'VariableDeclaration':
        execVarDecl(m, m.env, stmt);
        break;
      case 'ExportNamedDeclaration':
        if (stmt.declaration && stmt.declaration.type === 'VariableDeclaration') {
          execVarDecl(m, m.env, stmt.declaration);
        }
        break;
      case 'ExpressionStatement':
        execExpressionStatement(m, m.env, stmt.expression);
        break;
    }
  }
}

function execVarDecl(m, env, stmt) {
  for (const d of stmt.declarations) {
    if (!d.init) continue; // 'let x;' stays uninitialized (TDZ until assigned)
    const v = evalExpr(m, env, d.init);
    const b = env.vars.get(d.id.name);
    b.initialized = true;
    b.value = v;
  }
}

function execExpressionStatement(m, env, expr) {
  if (expr.type === 'AssignmentExpression') {
    const v = evalExpr(m, env, expr.right);
    assign(m, env, expr.left.name, v, expr);
    return;
  }
  evalCall(m, env, expr); // CallExpression; result discarded
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

function located(kind, message, node, m) {
  return new ModuleError(kind, message, {
    file: m.name,
    line: node.loc ? node.loc.start.line : null,
    col: node.loc ? node.loc.start.column + 1 : null,
    chain: m.chain,
  });
}

function resolveBinding(b, seen) {
  // Follow import indirections to the concrete slot in the exporting module.
  while (b.kind === 'import') {
    const key = `${b.targetModule.name}#${b.targetName}`;
    if (seen.has(key)) return null; // circular re-export chain
    seen.add(key);
    b = b.targetModule.env.vars.get(b.targetName);
  }
  return b;
}

function readBinding(m, env, node) {
  const name = node.name;
  const raw = env.lookup(name);
  if (!raw) throw located('reference', `'${name}' is not defined`, node, m);
  const b = resolveBinding(raw, new Set());
  if (!b) throw located('link', `circular re-export involving '${name}'`, node, m);
  if (!b.initialized) {
    throw located('tdz', `Cannot access '${name}' before initialization`, node, m);
  }
  return b.value;
}

function assign(m, env, name, value, node) {
  const raw = env.lookup(name);
  if (!raw) throw located('reference', `'${name}' is not defined`, node, m);
  if (raw.kind === 'import') {
    throw located('type', `Cannot assign to imported binding '${name}'`, node, m);
  }
  if (raw.kind === 'const') {
    if (!raw.initialized) throw located('tdz', `Cannot access '${name}' before initialization`, node, m);
    throw located('type', `Assignment to constant variable '${name}'`, node, m);
  }
  raw.initialized = true;
  raw.value = value;
}

function evalExpr(m, env, node) {
  switch (node.type) {
    case 'Literal':
      return node.value;
    case 'Identifier':
      return readBinding(m, env, node);
    case 'BinaryExpression': {
      const l = evalExpr(m, env, node.left);
      const r = evalExpr(m, env, node.right);
      if (typeof l !== 'number' || typeof r !== 'number') {
        throw located('type', `Operator '${node.operator}' requires numeric operands (a function without a return value yields nothing)`, node, m);
      }
      return node.operator === '+' ? l + r : l - r;
    }
    case 'CallExpression':
      return evalCall(m, env, node);
    default:
      throw located('syntax', `Unsupported expression ${node.type}`, node, m);
  }
}

function evalCall(m, env, node) {
  const callee = node.callee;
  const fn = readBinding(m, env, callee);
  if (!fn || fn.type !== 'fn') {
    throw located('type', `'${callee.name}' is not a function`, node, m);
  }
  return callFunction(fn);
}

function callFunction(fn) {
  const m = fn.module;
  const local = new Env(m.env, m);
  // Block-scoped instantiation for the body: hoist nested functions and
  // create uninitialized slots for every let/const declared in the body.
  for (const s of fn.node.body.body) {
    if (s.type === 'FunctionDeclaration') declareFunction(m, local, s);
    else if (s.type === 'VariableDeclaration') {
      for (const d of s.declarations) declareVar(m, local, d.id.name, s.kind, d);
    }
  }
  for (const s of fn.node.body.body) {
    switch (s.type) {
      case 'FunctionDeclaration':
        break;
      case 'VariableDeclaration':
        execVarDecl(m, local, s);
        break;
      case 'ExpressionStatement':
        execExpressionStatement(m, local, s.expression);
        break;
      case 'ReturnStatement':
        return evalExpr(m, local, s.argument);
    }
  }
  return VOID;
}

// ---------------------------------------------------------------------------
// Entry-point helper: fetch an exported zero-arg function and call it.
// ---------------------------------------------------------------------------

export function callExport(entry, name) {
  const localName = entry.exports.get(name);
  if (localName === undefined) {
    throw new ModuleError('link', `Entry module '${entry.name}' does not export '${name}'`, {
      file: entry.name,
      chain: entry.chain,
    });
  }
  const raw = entry.env.vars.get(localName);
  const b = resolveBinding(raw, new Set());
  if (!b || !b.initialized || !b.value || b.value.type !== 'fn') {
    throw new ModuleError('type', `Export '${name}' of '${entry.name}' is not a function`, {
      file: entry.name,
      chain: entry.chain,
    });
  }
  return callFunction(b.value);
}
