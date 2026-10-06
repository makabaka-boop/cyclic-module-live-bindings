# Restricted Module Interpreter

A CLI tool that reads real `.mjs` files and interprets a restricted ES-module
language — with **live bindings**: a module that imports a counter sees its
later updates, not a snapshot copy taken at import time.

Acorn provides the AST; export bindings and the module lifecycle (link →
evaluate) are managed by the interpreter itself. Native `import` and
`vm.SourceTextModule` are never used to execute sample code.

## Usage

```sh
node src/cli.js <modulesDir> <entry.mjs> [--call <exportedFn>]
```

* Loads the reachable module graph from `<modulesDir>` — at most **6 modules**,
  all in the same directory (specifiers must be `./name.mjs`).
* **Link phase** (before any code runs): parses every reachable module in
  source order of its imports, creates bindings for the whole graph, hoists
  function declarations, and checks that every import resolves to a real
  export. Missing exports fail here — nothing executes.
* **Evaluate phase**: runs module bodies once, in dependency order. Legal
  cycles are allowed (live bindings + hoisted functions make them useful);
  each body executes exactly once, and a failed module stays failed for the
  rest of the run — it is never re-executed or treated as successful.
* Prints the module initialization trace (`init <name>` per module), then the
  result of the exported zero-argument function when `--call` is given.
* Errors are reported with the file (`at:`) and the import chain from the
  entry module (`chain:`).

Example:

```
$ node src/cli.js samples/cases/counter main.mjs --call main
init counter.mjs
init snap.mjs
init main.mjs
result: 6
```

## Supported syntax (everything else is rejected explicitly)

* named imports: `import { a, b as c } from './x.mjs';`
* named exports: `export { a, b as c };` and `export let/const/function ...`
* `let` / `const` declarations
* zero-parameter function declarations (module top level)
* assignments to identifiers, zero-argument function calls, `return`
* expressions: numbers, identifiers, `+`, `-`, parentheses

Semantics follow native ESM: function declarations are hoisted, reading an
uninitialized `let`/`const` throws a TDZ error, and imported bindings cannot
be assigned to.

## Tests

```sh
npm test
```

Every sample case runs twice in isolated Node child processes: once through
the interpreter CLI, and once through **native Node ESM** (the oracle) on the
same raw sample files. The suite compares initialization traces, results, and
error classes for cyclic function calls, read-before-initialization (TDZ),
read-after-update, and failure propagation — including the same exported
value changing correctly between read moments. White-box checks assert that
failed modules are never re-run and that each module body executes once.

## Docker (Compose)

The tool container mounts the module directory **read-only**:

```sh
docker compose run --rm interp            # runs samples/cases/counter
docker compose run --rm interp /modules main.mjs --call main
```

Mount any other case directory by editing `docker-compose.yml` (the `:ro`
suffix is what guarantees the read-only mount).
