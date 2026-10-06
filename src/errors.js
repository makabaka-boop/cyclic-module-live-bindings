// Error type used across the interpreter. Carries enough context to locate
// the failure: kind, file, line/col and the import chain from the entry
// module to the module where the error was raised.
export class ModuleError extends Error {
  constructor(kind, message, { file = null, line = null, col = null, chain = null } = {}) {
    super(message);
    this.name = 'ModuleError';
    this.kind = kind; // 'syntax' | 'resolution' | 'link' | 'limit' | 'tdz' | 'reference' | 'type'
    this.file = file;
    this.line = line;
    this.col = col;
    this.chain = chain; // array of module names, entry first
  }
}

export function formatError(err) {
  const lines = [];
  const loc = err.file
    ? `${err.file}${err.line != null ? `:${err.line}:${err.col}` : ''}`
    : null;
  lines.push(`error: [${err.kind || 'error'}] ${err.message}`);
  if (loc) lines.push(`  at ${loc}`);
  if (err.chain && err.chain.length > 0) {
    lines.push(`  import chain: ${err.chain.join(' -> ')}`);
  }
  return lines.join('\n');
}
