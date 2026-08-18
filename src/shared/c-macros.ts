const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_PART = /[A-Za-z0-9_]/;

/**
 * Expand object-like macro identifiers while preserving strings, character
 * literals, and comments. The resolver deliberately excludes function-like
 * macros because expanding those safely requires argument substitution.
 */
export function expandObjectLikeMacros(
  expression: string,
  resolve: (name: string) => string | undefined,
  maximumDepth = 24,
): string {
  const expand = (value: string, stack: ReadonlySet<string>, depth: number): string => {
    if (depth >= maximumDepth) return value;
    let output = '';
    let index = 0;
    while (index < value.length) {
      const current = value[index]!;
      const next = value[index + 1] ?? '';

      if (current === '"' || current === "'") {
        const quote = current;
        const start = index++;
        while (index < value.length) {
          if (value[index] === '\\') { index += 2; continue; }
          const character = value[index++]!;
          if (character === quote) break;
        }
        output += value.slice(start, index);
        continue;
      }
      if (current === '/' && next === '/') {
        output += value.slice(index);
        break;
      }
      if (current === '/' && next === '*') {
        const end = value.indexOf('*/', index + 2);
        const stop = end < 0 ? value.length : end + 2;
        output += value.slice(index, stop);
        index = stop;
        continue;
      }
      if (IDENTIFIER_START.test(current)) {
        const start = index++;
        while (index < value.length && IDENTIFIER_PART.test(value[index]!)) index += 1;
        const name = value.slice(start, index);
        const replacement = stack.has(name) ? undefined : resolve(name);
        if (replacement === undefined) {
          output += name;
        } else {
          const nested = new Set(stack);
          nested.add(name);
          output += expand(replacement, nested, depth + 1);
        }
        continue;
      }
      output += current;
      index += 1;
    }
    return output;
  };

  return expand(expression, new Set(), 0);
}
