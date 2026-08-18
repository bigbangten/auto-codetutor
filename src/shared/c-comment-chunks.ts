export interface CommentTextChunk {
  text: string;
  startLineOffset: number;
  endLineOffset: number;
}

/**
 * Split a large source selection on line boundaries. A blank line or a closing
 * brace near the size boundary is preferred so one AI request rarely cuts a
 * function in the middle. Joining the returned text with "\n" reconstructs
 * the original normalized source exactly.
 */
export function splitCommentText(text: string, maximumCharacters = 48_000): CommentTextChunk[] {
  if (!Number.isFinite(maximumCharacters) || maximumCharacters < 1_000) throw new Error('주석 분할 크기는 1,000자 이상이어야 합니다.');
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const chunks: CommentTextChunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let length = 0;
    while (end < lines.length) {
      const added = lines[end]!.length + (end > start ? 1 : 0);
      if (end > start && length + added > maximumCharacters) break;
      length += added;
      end += 1;
      if (length >= maximumCharacters) break;
    }
    if (end < lines.length && end - start >= 8) {
      const earliest = start + Math.floor((end - start) * 0.6);
      for (let candidate = end - 1; candidate >= earliest; candidate -= 1) {
        const trimmed = lines[candidate]!.trim();
        if (!trimmed || /^}\s*;?$/.test(trimmed)) { end = candidate + 1; break; }
      }
    }
    if (end <= start) end = start + 1;
    chunks.push({
      text: lines.slice(start, end).join('\n'),
      startLineOffset: start,
      endLineOffset: end - 1,
    });
    start = end;
  }
  return chunks;
}
