/**
 * Remove C/C++ comments without touching comment-looking text inside string,
 * character, or raw-string literals. Newlines inside comments are retained so
 * the result stays easy to compare with the original source.
 */
export function removeCComments(source: string): string {
  let output = '';
  let index = 0;
  let quote: '"' | "'" | null = null;

  while (index < source.length) {
    if (quote) {
      const char = source[index]!;
      output += char;
      index += 1;
      if (char === '\\' && index < source.length) {
        output += source[index]!;
        index += 1;
      } else if (char === quote) quote = null;
      continue;
    }

    const raw = source.slice(index).match(/^(?:(?:u8|u|U|L)?R")([^\s\\()]*)\(/);
    if (raw) {
      const endToken = `)${raw[1]}"`;
      const end = source.indexOf(endToken, index + raw[0].length);
      const stop = end < 0 ? source.length : end + endToken.length;
      output += source.slice(index, stop);
      index = stop;
      continue;
    }

    const char = source[index]!;
    const next = source[index + 1];
    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      output += ' ';
      index += 2;
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      output += ' ';
      index += 2;
      while (index < source.length) {
        if (source[index] === '*' && source[index + 1] === '/') {
          index += 2;
          break;
        }
        if (source[index] === '\r') {
          output += '\r';
          index += 1;
          if (source[index] === '\n') { output += '\n'; index += 1; }
        } else if (source[index] === '\n') {
          output += '\n';
          index += 1;
        } else index += 1;
      }
      continue;
    }
    output += char;
    index += 1;
  }

  return output;
}
