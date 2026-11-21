// csv-fast: a fast drop-in for make.fun's csv-reader 1.0.0.
//
// run(input) answers exactly as csv-reader 1.0.0 does for {text, header}:
// {columns, rows, errors}. The reference reads one character at a time and
// builds every field a character at a time; this reader instead slices whole
// fields out of the text with indexOf, so the common cases never touch a
// character loop:
//
//   - a clean line (no quote, no stray CR) is split on commas in one go;
//   - an unquoted field is the slice up to the next comma or line break,
//     with stray CRs (rare) fixed up after the fact;
//   - a quoted field is the slice up to the next quote that is not doubled,
//     with "" collapsed to one quote and CR / CRLF inside it read as LF.
//
// Three forward-only caches (the next quote, the next CR and the next LF at
// or after the read position) keep the total scanning linear: a cache is
// recomputed only once the read position passes it, so the quote / CR / LF
// searches together touch each character O(1) times instead of rescanning
// to the end of the line for every field.
//
// The broken-row policy is csv-reader's own, followed exactly:
// a U+FEFF at the very start is dropped; a record ends at LF or CRLF and a
// line left with no characters is no record; outside quotes a CR not
// followed by LF is dropped (stray_cr); a field that opens with a quote runs
// to the next quote that is not doubled, "" inside it is one quote, each
// CRLF or lone CR inside it is read as LF, and what follows its closing
// quote up to the next comma or line break is appended as it stands
// (quote_junk, when the field ends); a quote that never closes is a literal
// character and the text after it is read again as unquoted
// (unterminated_quote); a quote inside an unquoted field is a literal
// character; fields stay strings, never trimmed or converted. columns is
// the first record when header is true, else null; rows holds the records
// after it (every record when header is false), each padded with empty
// strings (short_row, with fields: its field count) or cut (long_row, with
// extra: the cut fields) to the first record's width. Each error is
// {code, line, row}, in the order met, a record's short_row or long_row
// when it ends: line the 1-based line its record starts on, counting every
// LF, CRLF and lone CR inside quotes, and row its record's index in rows,
// null for the header.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next.

const COMMA = 0;
const BREAK = 1;
const END = 2;

const CC_QUOTE = 34; // "
const CC_COMMA = 44; // ,
const CC_CR = 13; // \r
const CC_LF = 10; // \n
const CC_BOM = 0xfeff;

/** Occurrences of a one-character needle in s, found by indexOf jumps. */
function countOcc(s, ch) {
  let n = 0;
  let i = s.indexOf(ch);
  while (i !== -1) {
    n++;
    i = s.indexOf(ch, i + 1);
  }
  return n;
}

/**
 * Line breaks inside one quoted segment: each LF, each CRLF and each lone
 * CR counts once, so breaks = LF + CR - CRLF, each counted by indexOf
 * jumps. Callers pass hasCR when they already know whether s holds a CR.
 */
function breaksIn(s, hasCR) {
  const lf = countOcc(s, '\n');
  if (!hasCR) return lf;
  return lf + countOcc(s, '\r') - countOcc(s, '\r\n');
}

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  const NONE = len + 1; // cache sentinel: no such character at or after pos
  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === CC_BOM) pos = 1;

  // Forward-only caches: the next quote / CR / LF at or after the last
  // position they were computed for, NONE when there is none, -1 when not
  // yet computed for the current position. A cache is recomputed only when
  // the read position passes it, which keeps total scanning linear.
  let nq = -1;
  let ncr = -1;
  let nlf = -1;
  function nextQuote(p) {
    if (nq < p) {
      const i = text.indexOf('"', p);
      nq = i === -1 ? NONE : i;
    }
    return nq;
  }
  function nextCr(p) {
    if (ncr < p) {
      const i = text.indexOf('\r', p);
      ncr = i === -1 ? NONE : i;
    }
    return ncr;
  }
  function nextLf(p) {
    if (nlf < p) {
      const i = text.indexOf('\n', p);
      nlf = i === -1 ? NONE : i;
    }
    return nlf;
  }

  /**
   * Reads unquoted characters from `start`, appending them to `value`, up
   * to the next comma or line break. A CR not followed by LF is dropped
   * (one stray_cr error each). Returns [value, ended, added, pos,
   * lineDelta]: ended is COMMA, BREAK or END; added counts the characters
   * kept; pos is where reading stopped; lineDelta is 1 when the field
   * ended at a break. Used for the text after a closing quote (quote junk)
   * and for the re-read of a quote that never closes; the hot path (a
   * plain unquoted field) is inlined in the field loop below.
   */
  function scanUnquoted(start, value, recordLine, recordRow) {
    const before = value.length;
    const commaAt = text.indexOf(',', start);
    const lfAt = nextLf(start);
    let end = len;
    let ended = END;
    if (commaAt !== -1 && commaAt < lfAt) {
      end = commaAt;
      ended = COMMA;
    } else if (lfAt !== NONE) {
      end = lfAt;
      ended = BREAK;
    }
    let chunk = text.slice(start, end);
    // A CR just before the LF is the CRLF line break, not part of the field.
    if (ended === BREAK && chunk.charCodeAt(chunk.length - 1) === CC_CR) chunk = chunk.slice(0, -1);
    if (chunk.indexOf('\r') !== -1) {
      const parts = chunk.split('\r');
      for (let i = 1; i < parts.length; i++) {
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      }
      chunk = parts.join('');
    }
    value += chunk;
    let npos;
    let lineDelta = 0;
    if (ended === COMMA) npos = end + 1;
    else if (ended === BREAK) {
      npos = end + 1;
      lineDelta = 1;
    } else npos = len;
    return [value, ended, value.length - before, npos, lineDelta];
  }

  while (pos < len) {
    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;

    // Fast path: the line up to the next LF, with a CRLF's CR stripped.
    // A line with no quote and no stray CR is one whole record: split it.
    // The caches answer "quote or CR before the line end" without slicing
    // or rescanning the line.
    const lfAt = nextLf(pos);
    const rawEnd = lfAt === NONE ? len : lfAt;
    let lineEnd = rawEnd;
    if (lfAt !== NONE && lineEnd > pos && text.charCodeAt(lineEnd - 1) === CC_CR) lineEnd -= 1;
    if (nextQuote(pos) >= lineEnd && nextCr(pos) >= lineEnd) {
      if (lineEnd === pos) {
        // A line left with no characters is no record.
        pos = lfAt === NONE ? len : lfAt + 1;
        line += 1;
        continue;
      }
      const fields = text.slice(pos, lineEnd).split(',');
      if (width < 0) width = fields.length;
      if (header && columns === null) {
        columns = fields;
      } else {
        if (fields.length < width) {
          errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
          while (fields.length < width) fields.push('');
        } else if (fields.length > width) {
          errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
        }
        rows.push(fields);
      }
      pos = lfAt === NONE ? len : lfAt + 1;
      line += 1;
      continue;
    }

    // General path: the line holds a quote or a stray CR, so read the
    // record field by field. A quoted field may run past this line.
    const fields = [];
    let lastQuoted = false;
    let ended;
    do {
      let value = '';
      if (text.charCodeAt(pos) === CC_QUOTE) {
        lastQuoted = true;
        const open = pos;
        let segStart = pos + 1;
        let pendingLines = 0;
        let closedAt = -1;
        while (true) {
          const q = text.indexOf('"', segStart);
          if (q === -1) break;
          if (text.charCodeAt(q + 1) === CC_QUOTE) {
            // A doubled quote: the segment up to it, plus one quote.
            const seg = text.slice(segStart, q);
            const hasCR = seg.indexOf('\r') !== -1;
            if (hasCR) value += seg.replace(/\r\n?/g, '\n') + '"';
            else value += seg + '"';
            pendingLines += breaksIn(seg, hasCR);
            segStart = q + 2;
            continue;
          }
          closedAt = q;
          break;
        }
        if (closedAt === -1) {
          // The quote never closes: it is a literal character, and the
          // text after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          const r = scanUnquoted(open + 1, '"', recordLine, recordRow);
          value = r[0];
          ended = r[1];
          pos = r[3];
          line += r[4];
        } else {
          // The closing segment, up to the closing quote.
          const seg = text.slice(segStart, closedAt);
          const hasCR = seg.indexOf('\r') !== -1;
          if (hasCR) value += seg.replace(/\r\n?/g, '\n');
          else value += seg;
          pendingLines += breaksIn(seg, hasCR);
          line += pendingLines;
          pos = closedAt + 1;
          if (pos >= len) {
            ended = END;
          } else {
            const c = text.charCodeAt(pos);
            if (c === CC_COMMA) {
              pos += 1;
              ended = COMMA;
            } else if (c === CC_LF) {
              pos += 1;
              line += 1;
              ended = BREAK;
            } else if (c === CC_CR && text.charCodeAt(pos + 1) === CC_LF) {
              pos += 2;
              line += 1;
              ended = BREAK;
            } else {
              // What follows the closing quote is appended as it stands,
              // up to the next comma or line break.
              const r = scanUnquoted(pos, value, recordLine, recordRow);
              value = r[0];
              ended = r[1];
              if (r[2] > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              pos = r[3];
              line += r[4];
            }
          }
        }
      } else {
        // Unquoted field: the slice up to the next comma or line break.
        // The line break comes from the cache, so the LF search is not
        // repeated for every field of the line.
        lastQuoted = false;
        const commaAt = text.indexOf(',', pos);
        const lfAt2 = nextLf(pos);
        let end = len;
        ended = END;
        if (commaAt !== -1 && commaAt < lfAt2) {
          end = commaAt;
          ended = COMMA;
        } else if (lfAt2 !== NONE) {
          end = lfAt2;
          ended = BREAK;
        }
        value = text.slice(pos, end);
        if (ended === BREAK && value.charCodeAt(value.length - 1) === CC_CR) value = value.slice(0, -1);
        if (value.indexOf('\r') !== -1) {
          const parts = value.split('\r');
          for (let i = 1; i < parts.length; i++) {
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          }
          value = parts.join('');
        }
        if (ended === COMMA) pos = end + 1;
        else if (ended === BREAK) {
          pos = end + 1;
          line += 1;
        } else pos = len;
      }
      fields.push(value);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

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
