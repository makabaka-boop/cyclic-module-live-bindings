import { ModuleError } from './errors.js';

// Validates that a parsed module only uses the supported subset:
//   - named imports / named exports
//   - let/const declarations
//   - zero-parameter function declarations
//   - assignment and function-call expression statements
//   - return (with a value, inside functions only)
//   - expressions built from numbers, identifiers, +, - and parentheses
// Anything else is rejected with an explicit, located error.

function reject(node, file, detail) {
  throw new ModuleError('syntax', `Unsupported syntax in ${file}: ${detail}`, {
    file,
    line: node.loc ? node.loc.start.line : null,
    col: node.loc ? node.loc.start.column + 1 : null,
  });
}

function validateExpression(node, file) {
  switch (node.type) {
    case 'Literal':
      if (typeof node.value !== 'number') {
        reject(node, file, `only numeric literals are allowed, got ${JSON.stringify(node.value)}`);
      }
      return;
    case 'Identifier':
      return;
    case 'BinaryExpression':
      if (node.operator !== '+' && node.operator !== '-') {
        reject(node, file, `operator '${node.operator}' is not supported (only '+' and '-')`);
      }
      validateExpression(node.left, file);
      validateExpression(node.right, file);
      return;
    case 'CallExpression':
      validateCall(node, file);
      return;
    default:
      reject(node, file, `${node.type} is not supported in expressions`);
  }
}

function validateCall(node, file) {
  if (node.callee.type !== 'Identifier') {
    reject(node, file, 'only calls to plain identifiers are allowed');
  }
  if (node.arguments.length !== 0) {
    reject(node, file, 'only zero-argument calls are allowed');
  }
}

function validateVarDecl(node, file) {
  if (node.kind !== 'let' && node.kind !== 'const') {
    reject(node, file, `declaration kind '${node.kind}' is not supported (use let/const)`);
  }
  for (const d of node.declarations) {
    if (d.id.type !== 'Identifier') {
      reject(d, file, 'destructuring declarations are not supported');
    }
    if (d.init) validateExpression(d.init, file);
  }
}

function validateFunction(node, file) {
  if (node.params.length !== 0) {
    reject(node, file, `function '${node.id.name}' has parameters; only zero-parameter functions are supported`);
  }
  for (const stmt of node.body.body) {
    validateStatement(stmt, file, true);
  }
}

function validateStatement(node, file, inFunction) {
  switch (node.type) {
    case 'ImportDeclaration': {
      if (inFunction) reject(node, file, 'import declarations are only allowed at module top level');
      for (const s of node.specifiers) {
        if (s.type !== 'ImportSpecifier') {
          reject(node, file, 'only named imports are allowed (import { x } from "./m.mjs")');
        }
      }
      return;
    }
    case 'ExportNamedDeclaration': {
      if (inFunction) reject(node, file, 'export declarations are only allowed at module top level');
      if (node.source) reject(node, file, 're-exporting from another module is not supported');
      if (node.declaration) {
        if (node.declaration.type === 'VariableDeclaration') validateVarDecl(node.declaration, file);
        else if (node.declaration.type === 'FunctionDeclaration') validateFunction(node.declaration, file);
        else reject(node.declaration, file, `cannot export a ${node.declaration.type}`);
      }
      return;
    }
    case 'VariableDeclaration':
      validateVarDecl(node, file);
      return;
    case 'FunctionDeclaration':
      validateFunction(node, file);
      return;
    case 'ReturnStatement':
      if (!inFunction) reject(node, file, 'return is only allowed inside a function');
      if (!node.argument) reject(node, file, 'return must produce a value');
      validateExpression(node.argument, file);
      return;
    case 'ExpressionStatement': {
      const e = node.expression;
      if (e.type === 'AssignmentExpression') {
        if (e.operator !== '=') reject(e, file, `assignment operator '${e.operator}' is not supported`);
        if (e.left.type !== 'Identifier') reject(e, file, 'can only assign to a plain identifier');
        validateExpression(e.right, file);
        return;
      }
      if (e.type === 'CallExpression') {
        validateCall(e, file);
        return;
      }
      reject(node, file, 'expression statements must be assignments or function calls');
      return;
    }
    default:
      reject(node, file, `${node.type} is not supported`);
  }
}

export function validateModule(ast, file) {
  for (const stmt of ast.body) {
    validateStatement(stmt, file, false);
  }
}
