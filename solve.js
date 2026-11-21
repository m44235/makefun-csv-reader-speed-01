// Fast drop-in replacement for csv-reader 1.0.0's readCsv — v2.
// Same semantics as v1, but the field readers return the string directly and
// report how the field ended through the shared `ended` local (no per-field
// tuple allocation). `junkAdded` carries the junk path's appended-char count.

const COMMA_END = 0;
const BREAK_END = 1;
const EOF_END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  let ended = EOF_END;
  let junkAdded = 0;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // Reads an unquoted field starting at pos. `parts` is null for a fresh field
  // (fast path: a single slice) or an array of pieces already collected.
  // Sets `ended`; for the junk path also sets `junkAdded`.
  function readUnquoted(parts, recordLine, recordRow) {
    let added = 0;
    let segStart = pos;
    for (;;) {
      if (pos >= n) {
        ended = EOF_END;
        const tail = text.slice(segStart, n);
        if (parts === null) { junkAdded = added + tail.length; return tail; }
        added += tail.length;
        parts.push(tail);
        junkAdded = added;
        return parts.join('');
      }
      const c = text.charCodeAt(pos);
      if (c === 44) { // ,
        ended = COMMA_END;
        const tail = text.slice(segStart, pos);
        pos += 1;
        if (parts === null) { junkAdded = added + tail.length; return tail; }
        added += tail.length;
        parts.push(tail);
        junkAdded = added;
        return parts.join('');
      }
      if (c === 10) { // \n
        ended = BREAK_END;
        const tail = text.slice(segStart, pos);
        pos += 1;
        line += 1;
        if (parts === null) { junkAdded = added + tail.length; return tail; }
        added += tail.length;
        parts.push(tail);
        junkAdded = added;
        return parts.join('');
      }
      if (c === 13) { // \r
        if (pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
          ended = BREAK_END;
          const tail = text.slice(segStart, pos);
          pos += 2;
          line += 1;
          if (parts === null) { junkAdded = added + tail.length; return tail; }
          added += tail.length;
          parts.push(tail);
          junkAdded = added;
          return parts.join('');
        }
        // stray CR: dropped, error, field continues
        if (parts === null) parts = [];
        added += pos - segStart;
        parts.push(text.slice(segStart, pos));
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos += 1;
        segStart = pos;
        continue;
      }
      pos += 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Sets `ended`.
  function readQuoted(recordLine, recordRow) {
    const open = pos;
    const openLine = line;
    let parts = null;
    let segStart = pos + 1;
    pos += 1;
    let closed = false;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 34) { // "
        if (pos + 1 < n && text.charCodeAt(pos + 1) === 34) {
          if (parts === null) parts = [];
          parts.push(text.slice(segStart, pos), '"');
          pos += 2;
          segStart = pos;
          continue;
        }
        pos += 1;
        closed = true;
        break;
      }
      if (c === 13) { // \r or \r\n inside quotes -> one \n, one line
        if (parts === null) parts = [];
        parts.push(text.slice(segStart, pos), '\n');
        line += 1;
        pos += pos + 1 < n && text.charCodeAt(pos + 1) === 10 ? 2 : 1;
        segStart = pos;
        continue;
      }
      if (c === 10) line += 1;
      pos += 1;
    }
    if (!closed) {
      // Unterminated: the quote is a literal char; re-read the rest unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted(['"'], recordLine, recordRow);
    }
    let value;
    if (parts === null) value = text.slice(segStart, pos - 1);
    else {
      parts.push(text.slice(segStart, pos - 1));
      value = parts.join('');
    }
    if (pos >= n) { ended = EOF_END; return value; }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      ended = COMMA_END;
      return value;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      ended = BREAK_END;
      return value;
    }
    if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      ended = BREAK_END;
      return value;
    }
    // Junk after the closing quote: appended via the unquoted reader.
    const v = readUnquoted([value], recordLine, recordRow);
    if (junkAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return v;
  }

  for (;;) {
    // Skip lines with no characters (LF / CRLF only).
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else break;
    }
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      fields.push(quoted ? readQuoted(recordLine, recordRow) : readUnquoted(null, recordLine, recordRow));
    } while (ended === COMMA_END);

    // A record of one unquoted empty field is no record (its errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
