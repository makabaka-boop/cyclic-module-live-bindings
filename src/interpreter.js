// Restricted .mjs module interpreter.
//
// Acorn is used only to produce the AST. Export bindings, module records and
// the module lifecycle (link -> evaluate, hoisting, TDZ, live bindings,
// cycles, single-execution, failure latching) are all managed here. Native
// `import` and `vm.SourceTextModule` are never used to execute sample code.
//
// Supported syntax (everything else is rejected explicitly):
//   - named imports:            import { a, b as c } from './x.mjs';
//   - named exports:            export { a, b as c };  export let/const/function ...
//   - let / const declarations
//   - zero-parameter function declarations (module top level only)
//   - assignments to identifiers
//   - zero-argument function calls
//   - return (inside functions only)
//   - expressions: numbers, identifiers, +, -, parentheses

import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';

export const MAX_MODULES = 6;

const SPECIFIER_RE = /^\.\/[A-Za-z0-9_-]+\.mjs$/;

export class ModuleError extends Error {
  constructor(code, message, moduleName = null) {
    super(message);
    this.name = 'ModuleError';
    this.code = code;              // e.g. 'TDZ', 'MISSING_EXPORT', ...
    this.module = moduleName;      // file where the error is located
    this.chain = moduleName ? [moduleName] : []; // entry-first import chain
  }
}

class Binding {
  constructor(kind) {
    this.kind = kind;              // 'let' | 'const' | 'function'
    this.initialized = false;      // false => temporal dead zone
    this.value = undefined;
  }
}

const FN = Symbol('fn');

// ---------------------------------------------------------------------------
// Parsing + whitelist validation
// ---------------------------------------------------------------------------

function parseAndValidate(source, moduleName) {
  let ast;
  try {
    ast = acorn.parse(source, { ecmaVersion: '2022', sourceType: 'module' });
  } catch (e) {
    throw new ModuleError('SYNTAX', `parse error: ${e.message}`, moduleName);
  }

  const mod = {
    name: moduleName,
    imports: [],        // { local, imported, source } in source order
    exportEntries: [],  // { exported, local }
    decls: [],          // top-level { kind:'let'|'const'|'function', name, node }
    body: [],           // executable top-level statements, in order
  };

  const declared = new Set();
  const declareName = (name, what) => {
    if (declared.has(name)) {
      throw new ModuleError('SYNTAX', `Identifier '${name}' has already been declared`, moduleName);
    }
    declared.add(name);
  };

  const validateExpr = (node) => {
    switch (node.type) {
      case 'Literal':
        if (typeof node.value !== 'number') {
          throw new ModuleError('SYNTAX', 'only numeric literals are supported', moduleName);
        }
        return;
      case 'Identifier':
        return;
      case 'BinaryExpression':
        if (node.operator !== '+' && node.operator !== '-') {
          throw new ModuleError('SYNTAX', `unsupported operator '${node.operator}' (only + and -)`, moduleName);
        }
        validateExpr(node.left);
        validateExpr(node.right);
        return;
      case 'CallExpression':
        if (node.callee.type !== 'Identifier') {
          throw new ModuleError('SYNTAX', 'only direct calls to named functions are supported', moduleName);
        }
        if (node.arguments.length !== 0) {
          throw new ModuleError('SYNTAX', 'only zero-argument calls are supported', moduleName);
        }
        return;
      default:
        throw new ModuleError('SYNTAX', `unsupported expression: ${node.type}`, moduleName);
    }
  };

  const validateStatementExpression = (node) => {
    if (node.type === 'AssignmentExpression') {
      if (node.operator !== '=') {
        throw new ModuleError('SYNTAX', `unsupported assignment operator '${node.operator}'`, moduleName);
      }
      if (node.left.type !== 'Identifier') {
        throw new ModuleError('SYNTAX', 'only assignment to a plain identifier is supported', moduleName);
      }
      validateExpr(node.right);
      return;
    }
    if (node.type === 'CallExpression') {
      validateExpr(node);
      return;
    }
    throw new ModuleError('SYNTAX', `unsupported statement expression: ${node.type}`, moduleName);
  };

  const validateFunction = (node) => {
    if (node.params.length !== 0) {
      throw new ModuleError('SYNTAX', `function '${node.id.name}' must have zero parameters`, moduleName);
    }
    const locals = new Set();
    for (const stmt of node.body.body) {
      switch (stmt.type) {
        case 'VariableDeclaration':
          if (stmt.kind !== 'let' && stmt.kind !== 'const') {
            throw new ModuleError('SYNTAX', `unsupported declaration kind '${stmt.kind}'`, moduleName);
          }
          for (const d of stmt.declarations) {
            if (d.id.type !== 'Identifier') {
              throw new ModuleError('SYNTAX', 'destructuring is not supported', moduleName);
            }
            if (stmt.kind === 'const' && d.init === null) {
              throw new ModuleError('SYNTAX', `missing initializer in const declaration '${d.id.name}'`, moduleName);
            }
            if (d.init) validateExpr(d.init);
            if (locals.has(d.id.name)) {
              throw new ModuleError('SYNTAX', `Identifier '${d.id.name}' has already been declared`, moduleName);
            }
            locals.add(d.id.name);
          }
          break;
        case 'ExpressionStatement':
          validateStatementExpression(stmt.expression);
          break;
        case 'ReturnStatement':
          if (stmt.argument) validateExpr(stmt.argument);
          break;
        default:
          throw new ModuleError('SYNTAX', `unsupported statement in function body: ${stmt.type}`, moduleName);
      }
    }
  };

  const handleDeclaration = (node) => {
    if (node.type === 'VariableDeclaration') {
      if (node.kind !== 'let' && node.kind !== 'const') {
        throw new ModuleError('SYNTAX', `unsupported declaration kind '${node.kind}'`, moduleName);
      }
      for (const d of node.declarations) {
        if (d.id.type !== 'Identifier') {
          throw new ModuleError('SYNTAX', 'destructuring is not supported', moduleName);
        }
        if (d.kind === 'const' && d.init === null) {
          throw new ModuleError('SYNTAX', `missing initializer in const declaration '${d.id.name}'`, moduleName);
        }
        if (d.init) validateExpr(d.init);
        declareName(d.id.name);
        mod.decls.push({ kind: node.kind, name: d.id.name, node: d });
      }
      mod.body.push({ type: 'var', node });
      return node.declarations.map((d) => d.id.name);
    }
    if (node.type === 'FunctionDeclaration') {
      if (!node.id) throw new ModuleError('SYNTAX', 'anonymous function declarations are not supported', moduleName);
      validateFunction(node);
      declareName(node.id.name);
      mod.decls.push({ kind: 'function', name: node.id.name, node });
      // hoisted at link time; not part of the executable body
      return [node.id.name];
    }
    throw new ModuleError('SYNTAX', `unsupported declaration: ${node.type}`, moduleName);
  };

  for (const stmt of ast.body) {
    switch (stmt.type) {
      case 'ImportDeclaration': {
        if (stmt.specifiers.length === 0) {
          throw new ModuleError('SYNTAX', 'side-effect imports are not supported', moduleName);
        }
        const src = stmt.source.value;
        if (typeof src !== 'string' || !SPECIFIER_RE.test(src)) {
          throw new ModuleError('SYNTAX', `unsupported module specifier '${src}' (only './name.mjs' in the same directory)`, moduleName);
        }
        for (const spec of stmt.specifiers) {
          if (spec.type !== 'ImportSpecifier') {
            throw new ModuleError('SYNTAX', `unsupported import form: ${spec.type} (only named imports)`, moduleName);
          }
          declareName(spec.local.name);
          mod.imports.push({
            local: spec.local.name,
            imported: spec.imported.name ?? spec.imported.value,
            source: src,
          });
        }
        break;
      }
      case 'ExportNamedDeclaration': {
        if (stmt.source) {
          throw new ModuleError('SYNTAX', "'export ... from' re-exports are not supported", moduleName);
        }
        if (stmt.declaration) {
          const names = handleDeclaration(stmt.declaration);
          for (const n of names) mod.exportEntries.push({ exported: n, local: n });
        } else {
          if (stmt.specifiers.length === 0) {
            throw new ModuleError('SYNTAX', 'empty export lists are not supported', moduleName);
          }
          for (const spec of stmt.specifiers) {
            mod.exportEntries.push({
              exported: spec.exported.name ?? spec.exported.value,
              local: spec.local.name,
            });
          }
        }
        break;
      }
      case 'VariableDeclaration':
      case 'FunctionDeclaration':
        handleDeclaration(stmt);
        break;
      case 'ExpressionStatement':
        validateStatementExpression(stmt.expression);
        mod.body.push({ type: 'expr', node: stmt.expression });
        break;
      default:
        throw new ModuleError('SYNTAX', `unsupported statement: ${stmt.type}`, moduleName);
    }
  }

  const seenExports = new Set();
  for (const e of mod.exportEntries) {
    if (seenExports.has(e.exported)) {
      throw new ModuleError('SYNTAX', `duplicate export '${e.exported}'`, moduleName);
    }
    seenExports.add(e.exported);
  }
  return mod;
}

// ---------------------------------------------------------------------------
// Graph loading (parse every reachable module, in source order of imports)
// ---------------------------------------------------------------------------

export function loadGraph(dir, entryName) {
  const modules = new Map();

  const visit = (name, stack) => {
    if (modules.has(name)) return modules.get(name);
    if (modules.size >= MAX_MODULES) {
      const e = new ModuleError('LIMIT', `module limit exceeded: at most ${MAX_MODULES} modules per graph`, name);
      e.chain = [...stack, name];
      throw e;
    }
    const file = path.join(dir, name);
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      const e = new ModuleError('IO', `cannot read module file '${name}'`, name);
      e.chain = [...stack, name];
      throw e;
    }
    let parsed;
    try {
      parsed = parseAndValidate(source, name);
    } catch (e) {
      if (e instanceof ModuleError) e.chain = [...stack, name];
      throw e;
    }
    const rec = {
      name,
      parsed,
      discoveredVia: [...stack],   // entry-first path of importers
      locals: new Map(),           // local name -> Binding
      importAliases: new Map(),    // local name -> { source, imported }
      exportMap: new Map(),        // exported name -> local name
      deps: [],                    // module records, source order, deduped
      status: 'new',               // new | executing | executed | failed
      error: null,
    };
    modules.set(name, rec);
    const depNames = [...new Set(parsed.imports.map((i) => i.source.slice(2)))];
    for (const dn of depNames) {
      rec.deps.push(visit(dn, [...stack, name]));
    }
    return rec;
  };

  const entry = visit(entryName, []);
  const graph = { dir, entry, modules, trace: [] };
  link(graph);
  return graph;
}

// ---------------------------------------------------------------------------
// Linking: create bindings for the whole reachable graph, initialize hoisted
// functions, and check that every import resolves to a real export — all
// before any module body executes.
// ---------------------------------------------------------------------------

function link(graph) {
  for (const rec of graph.modules.values()) {
    for (const d of rec.parsed.decls) {
      if (d.kind === 'function') {
        const b = new Binding('function');
        b.value = { [FN]: true, name: d.name, body: d.node.body.body, module: rec };
        b.initialized = true; // function declarations are hoisted
        rec.locals.set(d.name, b);
      } else {
        rec.locals.set(d.name, new Binding(d.kind)); // let/const: TDZ
      }
    }
    for (const imp of rec.parsed.imports) {
      rec.importAliases.set(imp.local, { source: imp.source.slice(2), imported: imp.imported });
    }
    for (const e of rec.parsed.exportEntries) {
      rec.exportMap.set(e.exported, e.local);
    }
  }

  for (const rec of graph.modules.values()) {
    for (const [local, alias] of rec.importAliases) {
      const target = graph.modules.get(alias.source);
      if (!resolveExport(graph, target, alias.imported)) {
        const e = new ModuleError(
          'MISSING_EXPORT',
          `'${alias.source}' does not provide an export named '${alias.imported}' (imported as '${local}')`,
          rec.name,
        );
        e.chain = [...rec.discoveredVia, rec.name];
        throw e;
      }
    }
    for (const [exported, local] of rec.exportMap) {
      if (!rec.locals.has(local) && !rec.importAliases.has(local)) {
        const e = new ModuleError('SYNTAX', `export '${exported}' refers to undefined local '${local}'`, rec.name);
        e.chain = [...rec.discoveredVia, rec.name];
        throw e;
      }
    }
  }
}

// Resolve an exported name to the concrete (non-import) binding, following
// indirect re-export chains. Returns null when the name is not exported or
// the chain is circular.
function resolveExport(graph, rec, exported, seen = new Set()) {
  const key = rec.name + ':' + exported;
  if (seen.has(key)) return null;
  seen.add(key);
  const local = rec.exportMap.get(exported);
  if (local === undefined) return null;
  if (rec.locals.has(local)) return { module: rec, binding: rec.locals.get(local) };
  const alias = rec.importAliases.get(local);
  if (!alias) return null;
  return resolveExport(graph, graph.modules.get(alias.source), alias.imported, seen);
}

function resolveName(graph, rec, name) {
  if (rec.locals.has(name)) return { module: rec, binding: rec.locals.get(name) };
  const alias = rec.importAliases.get(name);
  if (alias) return resolveExport(graph, graph.modules.get(alias.source), alias.imported);
  return null;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export function evaluateGraph(graph) {
  evaluateModule(graph.entry, graph);
  return graph.trace;
}

function evaluateModule(rec, graph) {
  if (rec.status === 'executed') return;          // body runs at most once
  if (rec.status === 'executing') return;         // legal cycle: live bindings already exist
  if (rec.status === 'failed') throw rec.error;   // failed modules are never re-run
  rec.status = 'executing';
  try {
    for (const dep of rec.deps) evaluateModule(dep, graph);
    execModuleBody(rec, graph);
    rec.status = 'executed';
    graph.trace.push(rec.name);
  } catch (e) {
    rec.status = 'failed';
    rec.error = e;
    if (e instanceof ModuleError && e.chain[0] !== rec.name) e.chain.unshift(rec.name);
    throw e;
  }
}

function execModuleBody(rec, graph) {
  const env = { module: rec, locals: null, graph };
  for (const item of rec.parsed.body) {
    if (item.type === 'var') execVarDecl(item.node, env);
    else execExprStatement(item.node, env);
  }
}

function execVarDecl(node, env) {
  for (const d of node.declarations) {
    const value = d.init ? evalExpr(d.init, env) : undefined;
    const target = env.locals ? env.locals.get(d.id.name) : env.module.locals.get(d.id.name);
    target.value = value;
    target.initialized = true;
  }
}

function execExprStatement(node, env) {
  if (node.type === 'AssignmentExpression') {
    writeName(node.left.name, evalExpr(node.right, env), env);
    return;
  }
  evalExpr(node, env); // call expression, result discarded
}

function execFunctionStatement(stmt, env) {
  switch (stmt.type) {
    case 'VariableDeclaration':
      execVarDecl(stmt, env);
      return null;
    case 'ExpressionStatement':
      execExprStatement(stmt.expression, env);
      return null;
    case 'ReturnStatement':
      return { returned: true, value: stmt.argument ? evalExpr(stmt.argument, env) : undefined };
    default:
      throw new ModuleError('SYNTAX', `unsupported statement in function body: ${stmt.type}`, env.module.name);
  }
}

function callFunction(fn, graph) {
  const locals = new Map();
  for (const stmt of fn.body) {
    if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations) locals.set(d.id.name, new Binding(stmt.kind));
    }
  }
  const env = { module: fn.module, locals, graph };
  for (const stmt of fn.body) {
    const r = execFunctionStatement(stmt, env);
    if (r && r.returned) return r.value;
  }
  return undefined;
}

function evalExpr(node, env) {
  switch (node.type) {
    case 'Literal':
      return node.value;
    case 'Identifier':
      return readName(node.name, env);
    case 'BinaryExpression': {
      const l = evalExpr(node.left, env);
      const r = evalExpr(node.right, env);
      return node.operator === '+' ? l + r : l - r;
    }
    case 'CallExpression': {
      const fn = readName(node.callee.name, env);
      if (!fn || fn[FN] !== true) {
        throw new ModuleError('NOT_FUNCTION', `'${node.callee.name}' is not a function`, env.module.name);
      }
      return callFunction(fn, env.graph);
    }
    default:
      throw new ModuleError('SYNTAX', `unsupported expression: ${node.type}`, env.module.name);
  }
}

function readName(name, env) {
  if (env.locals && env.locals.has(name)) {
    const b = env.locals.get(name);
    if (!b.initialized) {
      throw new ModuleError('TDZ', `Cannot access '${name}' before initialization`, env.module.name);
    }
    return b.value;
  }
  const res = resolveName(env.graph, env.module, name);
  if (!res) throw new ModuleError('REF', `'${name}' is not defined`, env.module.name);
  if (!res.binding.initialized) {
    throw new ModuleError('TDZ', `Cannot access '${name}' before initialization`, env.module.name);
  }
  return res.binding.value;
}

function writeName(name, value, env) {
  if (env.locals && env.locals.has(name)) {
    const b = env.locals.get(name);
    if (b.kind === 'const') {
      throw new ModuleError('CONST_ASSIGN', `Assignment to constant variable '${name}'`, env.module.name);
    }
    if (!b.initialized) {
      throw new ModuleError('TDZ', `Cannot access '${name}' before initialization`, env.module.name);
    }
    b.value = value;
    return;
  }
  const rec = env.module;
  if (rec.locals.has(name)) {
    const b = rec.locals.get(name);
    if (b.kind === 'const') {
      throw new ModuleError('CONST_ASSIGN', `Assignment to constant variable '${name}'`, rec.name);
    }
    if (!b.initialized) {
      throw new ModuleError('TDZ', `Cannot access '${name}' before initialization`, rec.name);
    }
    b.value = value; // 'let' and 'function' bindings are mutable
    return;
  }
  if (rec.importAliases.has(name)) {
    throw new ModuleError('ASSIGN_IMPORT', `Cannot assign to imported binding '${name}'`, rec.name);
  }
  throw new ModuleError('REF', `'${name}' is not defined`, rec.name);
}

// ---------------------------------------------------------------------------
// Public helpers (used by the CLI and the white-box tests)
// ---------------------------------------------------------------------------

export function getExport(graph, moduleName, exportName) {
  const rec = graph.modules.get(moduleName);
  if (!rec) throw new ModuleError('IO', `unknown module '${moduleName}'`, moduleName);
  const res = resolveExport(graph, rec, exportName);
  if (!res) {
    throw new ModuleError('MISSING_EXPORT', `'${moduleName}' does not provide an export named '${exportName}'`, moduleName);
  }
  if (!res.binding.initialized) {
    throw new ModuleError('TDZ', `Cannot access '${exportName}' before initialization`, res.module.name);
  }
  return res.binding.value;
}

export function callExported(graph, moduleName, exportName) {
  const fn = getExport(graph, moduleName, exportName);
  if (!fn || fn[FN] !== true) {
    throw new ModuleError('NOT_FUNCTION', `'${exportName}' is not a function`, moduleName);
  }
  return callFunction(fn, graph);
}
