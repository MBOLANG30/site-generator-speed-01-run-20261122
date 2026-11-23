// A fast drop-in for makefun-site 1.0.0.
//
// Written from the makefun-site README and its vendor source as the behavioural
// reference. The build below mirrors the documented pipeline — sort the files,
// parse front matter, hand out permalinks, render Markdown, group posts and
// tags, run every page through its layout, then write the report — but each
// stage is written for speed: hand-rolled scanners instead of per-line regular
// expressions, one-pass HTML escaping, ASCII fast paths for slugs, and output
// accumulated in arrays and joined once.

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const RESERVED_DIRS = ['posts', 'tags', 'page'];

// Code-unit order, never locale order.
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ------------------------------------------------------------------ escaping

// HTML escape entities indexed by character code; only five characters escape.
const ENT = [];
ENT[38] = '&amp;';
ENT[60] = '&lt;';
ENT[62] = '&gt;';
ENT[34] = '&quot;';
ENT[39] = '&#39;';

// Append `s` to `out` with the five HTML escapes applied in a single pass.
// `out` is an array of string chunks; the caller joins it once. Strings with
// nothing to escape take the fast path and are pushed whole.
const ESC_TEST = /[&<>"']/;
function escInto(s, out) {
  if (!ESC_TEST.test(s)) {
    out.push(s);
    return;
  }
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const e = ENT[s.charCodeAt(i)];
    if (e !== undefined) {
      if (i > start) out.push(s.slice(start, i));
      out.push(e);
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
}

// ------------------------------------------------------------------ whitespace

// True for the characters JavaScript's \s matches.
function isWsCode(code) {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function hasWs(s) {
  for (let i = 0; i < s.length; i++) if (isWsCode(s.charCodeAt(i))) return true;
  return false;
}

// ------------------------------------------------------------------ slugs

// The slug of `text`: NFKD, combining marks dropped, A-Z lowered, each run of
// characters outside a-z and 0-9 collapsed to one "-", none at either end, cut
// to 64 characters with a "-" left at the cut dropped, "untitled" when nothing
// is left. Pure-ASCII input takes a fast path (NFKD is the identity there and
// ASCII holds no combining marks); anything else goes through normalisation.
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 127) {
      ascii = false;
      break;
    }
    let keep = -1;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (!ascii) {
    plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = '';
    gap = false;
    for (let i = 0; i < plain.length; i++) {
      const code = plain.charCodeAt(i);
      let keep = -1;
      if (code >= 65 && code <= 90) keep = code + 32;
      else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
      if (keep === -1) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  }
  if (out.length > 64) out = out.slice(0, 64);
  while (out.endsWith('-')) out = out.slice(0, -1);
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

// `slug` made unique against `taken` (and added to it).
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

// A YYYY-MM-DD date in words, from the string alone.
function longDate(date, cache) {
  const hit = cache.get(date);
  if (hit !== undefined) return hit;
  const out =
    Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
  cache.set(date, out);
  return out;
}

// Count the words of a body (runs of non-whitespace) with one scan. Below
// code 128 only space and \t\n\v\f\r are whitespace, so those are tested
// inline and the full table is consulted only for higher codes.
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13) || (c > 127 && isWsCode(c))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ------------------------------------------------------------------ front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysIn(y, m) {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

// A quoted or bare string value, or why it is refused.
function stringValue(raw) {
  if (raw.charCodeAt(0) === 34) {
    // Opens on a double quote.
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
      return { error: 'a quoted string is not closed' };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

// One key's value, or why it is refused.
function keyValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringValue(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      let y = 0;
      let mo = 0;
      let d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        y = Number(raw.slice(0, 4));
        mo = Number(raw.slice(5, 7));
        d = Number(raw.slice(8, 10));
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = [];
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t[j];
          if (c === '"' || c === '[' || c === ']') {
            return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
          }
        }
        tags.push(t);
      }
      return { value: tags };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        const ok =
          (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
        if (!ok) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Parse a source's front matter and body: { data, body }, or { error } with
// the first reason it is refused. `text` already has "\n" line ends.
function parseFrontMatter(text) {
  let firstEnd = text.indexOf('\n');
  if (firstEnd === -1) firstEnd = text.length;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  const data = {};
  let pos = firstEnd === text.length ? text.length : firstEnd + 1;
  let lineNo = 1;
  let bodyStart = -1;
  while (pos <= text.length) {
    let end = text.indexOf('\n', pos);
    if (end === -1) end = text.length;
    const line = text.slice(pos, end);
    lineNo++;
    if (line === '---') {
      bodyStart = end === text.length ? text.length : end + 1;
      break;
    }
    if (isBlankLine(line) || line.charCodeAt(0) === 35) {
      // Blank or a comment: skip.
    } else {
      // A "key: value" line: key of a-z and _, a colon, one space, the value.
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      if (k === 0 || line.charCodeAt(k) !== 58) {
        return { error: 'line ' + lineNo + ' is not "key: value"' };
      }
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: 'line ' + lineNo + ' is not "key: value"' };
      let e = raw.length;
      while (e > 0) {
        const c = raw.charCodeAt(e - 1);
        if (c === 32 || c === 9) e--;
        else break;
      }
      raw = raw.slice(0, e);
      const key = line.slice(0, k);
      if (!FM_KEYS.includes(key)) return { error: 'unknown key "' + key + '"' };
      if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
      if (raw === '') return { error: 'key "' + key + '" has no value' };
      const v = keyValue(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (end === text.length) break;
    pos = end + 1;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ------------------------------------------------------------------ Markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return line.slice(a, b);
}

function restIsSpaces(line, from) {
  for (let i = from; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isLangChar(code) {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code === 43 ||
    code === 45
  );
}

// A fence-open line: its language, or null. A fence-close line is one of
// three backticks and spaces or tabs only.
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  if (!restIsSpaces(line, j)) return null;
  return line.slice(3, j);
}

function isFenceClose(line) {
  return (
    line.length >= 3 &&
    line.charCodeAt(0) === 96 &&
    line.charCodeAt(1) === 96 &&
    line.charCodeAt(2) === 96 &&
    restIsSpaces(line, 3)
  );
}

// A heading line: { depth, text }, or null.
function headingOf(line) {
  let c = 0;
  while (c < line.length && line.charCodeAt(c) === 35) c++;
  if (c < 1 || c > 6) return null;
  if (c >= line.length) return null;
  const s = line.charCodeAt(c);
  if (s !== 32 && s !== 9) return null;
  let j = c;
  while (j < line.length) {
    const code = line.charCodeAt(j);
    if (code === 32 || code === 9) j++;
    else break;
  }
  let e = line.length;
  while (e > j) {
    const code = line.charCodeAt(e - 1);
    if (code === 32 || code === 9) e--;
    else break;
  }
  if (e === j) return null;
  return { depth: c, text: line.slice(j, e) };
}

function isHr(line) {
  if (line.length < 3) return false;
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const d = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && d === 45) || (a === 42 && b === 42 && d === 42))) return false;
  return restIsSpaces(line, 3);
}

// Whether `line` ends a paragraph: blank, a fence, a heading or a break.
function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

// A bullet line's item text, or null. An ordered line's { num, text }, or null.
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

function orderedOf(line) {
  let d = 0;
  while (d < line.length) {
    const c = line.charCodeAt(d);
    if (c >= 48 && c <= 57) d++;
    else break;
  }
  if (d < 1 || d > 9) return null;
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return { num: Number(line.slice(0, d)), text: line.slice(d + 2) };
}

// A line of two or more spaces then a non-space continues a list item.
function isContinued(line) {
  let s = 0;
  while (s < line.length && line.charCodeAt(s) === 32) s++;
  return s >= 2 && s < line.length && !isWsCode(line.charCodeAt(s));
}

// The first index from `from` where `s` holds `what` outside a backslash
// escape, or -1.
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

// The first single * from `from` (one whose run is not **), outside an
// escape, or -1.
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

// The characters that interrupt a plain run of inline text.
const INLINE_RE = /[\\`*\[&<>"']/g;

// Render `s` inline into the chunk array `out`; `link(target)` resolves a
// link's href. A single regex scan jumps straight to the next character that
// needs attention, so plain runs of characters are pushed as whole slices
// instead of being walked one by one. `lastIndex` is set before every exec,
// which keeps the shared regex safe across the recursive calls below.
function inlineInto(s, link, out) {
  let i = 0;
  const n = s.length;
  let run = 0;
  while (i < n) {
    INLINE_RE.lastIndex = i;
    const m = INLINE_RE.exec(s);
    if (m === null) break;
    const j = m.index;
    const code = s.charCodeAt(j);
    if (j > run) out.push(s.slice(run, j));
    if (code === 92) {
      // Backslash: an escapable character after it is written escaped.
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        const e = ENT[s.charCodeAt(j + 1)];
        out.push(e !== undefined ? e : s[j + 1]);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
      run = i;
      continue;
    }
    if (code === 96) {
      // A code span runs to the next backtick, with at least one char inside.
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out.push('<code>');
        escInto(s.slice(j + 1, k), out);
        out.push('</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
      run = i;
      continue;
    }
    if (code === 42) {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out.push('<strong>');
          inlineInto(s.slice(j + 2, k), link, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out.push('<em>');
          inlineInto(s.slice(j + 1, k), link, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
      run = i;
      continue;
    }
    if (code === 91) {
      // [text](target): the first unescaped ] closes the text, ( must follow
      // at once, and the next ) closes a non-empty target with no whitespace.
      const k = findUnescaped(s, ']', j + 1);
      const p = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = p === -1 ? '' : s.slice(k + 2, p);
      if (target !== '' && !hasWs(target)) {
        out.push('<a href="');
        escInto(link(target), out);
        out.push('">');
        inlineInto(s.slice(j + 1, k), link, out);
        out.push('</a>');
        i = p + 1;
      } else {
        out.push('[');
        i = j + 1;
      }
      run = i;
      continue;
    }
    // One of the five escapable characters.
    out.push(ENT[code]);
    i = j + 1;
    run = i;
  }
  if (run < n) out.push(s.slice(run));
}

function inlineStr(s, link) {
  const out = [];
  inlineInto(s, link, out);
  return out.join('');
}

// Render one body to HTML, with its table of contents and excerpt. `link` is
// the source's link resolver; `ctx` carries the per-build slug cache.
function renderMarkdown(src, link, ctx) {
  const lines = src.split('\n');
  const n = lines.length;
  const parts = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      // A fenced block: each body line escaped in one pass, ending in \n.
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) {
        escInto(lines[i], body);
        body.push('\n');
        i++;
      }
      i++;
      parts.push('<pre><code');
      if (lang !== '') parts.push(' class="language-' + lang + '"');
      parts.push('>');
      parts.push(body.join(''));
      parts.push('</code></pre>\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text, ctx.slugCache), ids);
      const html = inlineStr(heading.text, link);
      parts.push('<h' + heading.depth + ' id="' + id + '">' + html + '</h' + heading.depth + '>\n');
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      parts.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      // A blockquote: the > and one space after it dropped, lines trimmed,
      // empty ones dropped.
      const inner = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        l = trimLine(l);
        if (l !== '') inner.push(l);
        i++;
      }
      if (inner.length === 0) parts.push('<blockquote>\n</blockquote>\n');
      else parts.push('<blockquote>\n<p>' + inlineStr(inner.join('\n'), link) + '</p>\n</blockquote>\n');
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      let start = 1;
      if (isOrdered) start = ordered.num;
      while (i < n) {
        let m;
        if (isOrdered) {
          m = orderedOf(lines[i]);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
            continue;
          }
        } else {
          m = bulletOf(lines[i]);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
            continue;
          }
        }
        if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? '<ol start="' + start + '">' : '<' + tag + '>';
      const li = [];
      for (let k = 0; k < items.length; k++) {
        li.push('<li>' + inlineStr(items[k].join('\n'), link) + '</li>\n');
      }
      parts.push(open + '\n' + li.join('') + '</' + tag + '>\n');
      continue;
    }
    // A paragraph: lines up to a blank line, a fence, a heading or a break.
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineStr(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    parts.push('<p>' + html + '</p>\n');
  }
  return { html: parts.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ------------------------------------------------------------------ templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) {
    throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  }
  return text.split('.');
}

function onlySpaces(src, from, to) {
  for (let i = from; i < to; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Split a template source into tokens: text, {{ }}, {{{ }}} and {% %}.
// A {% %} tag alone on its line takes the whole line with it.
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) {
        throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      }
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone =
      onlySpaces(src, lineStart, open) && onlySpaces(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Parse a template source into a tree of nodes, or throw a TemplateError.
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) {
          throw new TemplateError('template "' + name + '": an else outside an if');
        }
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body =
          parent.kind === 'root'
            ? parent.body
            : parent.kind === 'for'
              ? parent.body
              : parent.else !== null && parent.else !== undefined
                ? parent.else
                : parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
        body.push({ kind: 'include', name: m[1] });
      } else {
        throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
      }
    }
  }
  if (stack.length > 1) {
    throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  }
  return root.body;
}

// The value at `path` in the scope chain: its first name from the nearest
// scope holding it, then own properties of the value so far.
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

// Write a value as text into the chunk array `out`: a string itself, a
// number in JavaScript's digits, true or false, an array's items joined by
// ", ", anything else nothing. Strings are escaped on the way out when
// `escaped` is set, instead of building the text first and scanning it again.
function writeValue(v, out, escaped) {
  if (typeof v === 'string') {
    if (escaped) escInto(v, out);
    else out.push(v);
    return;
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    out.push(String(v));
    return;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out.push(', ');
      writeValue(v[i], out, escaped);
    }
  }
}

// Whether a value counts as true in an if.
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Render `nodes` in `scope` into the chunk array `out`. Includes nest at
// most 8 deep; one deeper renders nothing.
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let n = 0; n < nodes.length; n++) {
    const nd = nodes[n];
    if (nd.kind === 'text') {
      out.push(nd.text);
    } else if (nd.kind === 'var') {
      writeValue(lookup(scope, nd.path), out, true);
    } else if (nd.kind === 'raw') {
      writeValue(lookup(scope, nd.path), out, false);
    } else if (nd.kind === 'if') {
      const v = truthy(lookup(scope, nd.path));
      const branch = v !== nd.not ? nd.then : nd.else;
      if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
    } else if (nd.kind === 'for') {
      const xs = lookup(scope, nd.path);
      if (!Array.isArray(xs)) continue;
      const len = xs.length;
      // One scope frame and one loop record for the whole run, mutated per
      // element: nothing here outlives the iteration it is read in, and a
      // re-entrant run of the same node builds its own pair. The element is
      // bound before `loop` so that, as in the reference, a loop variable
      // named `loop` still reads the loop record.
      const vars = {};
      const loop = { index: 0, first: false, last: false, length: len };
      const child = { vars, parent: scope };
      for (let k = 0; k < len; k++) {
        vars[nd.name] = xs[k];
        vars.loop = loop;
        loop.index = k + 1;
        loop.first = k === 0;
        loop.last = k === len - 1;
        renderNodes(nd.body, child, ctx, depth, out);
      }
    } else if (nd.kind === 'include') {
      const t = ctx.templates.get(nd.name);
      if (t !== undefined && depth < 8) renderNodes(t, scope, ctx, depth + 1, out);
    }
  }
}

// ------------------------------------------------------------------ the build

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

// `rel` (a link's path) from the directory `dir`, or null when it climbs out
// of the root.
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// True when `target` opens with a scheme (https:, mailto: ...).
function hasScheme(target) {
  if (target.length === 0) return false;
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) ||
      c === 43 ||
      c === 45 ||
      c === 46
    ) {
      continue;
    }
    return false;
  }
  return false;
}

// A source's tags, each slug once, in its own order.
function ownTagNames(s, ctx) {
  const seen = new Set();
  const out = [];
  const tags = s.data.tags === undefined ? [] : s.data.tags;
  for (let i = 0; i < tags.length; i++) {
    const sl = slugify(tags[i], ctx.slugCache);
    if (!seen.has(sl)) {
      seen.add(sl);
      out.push(tags[i]);
    }
  }
  return out;
}

// A page's card, as lists show it; computed once per source and reused.
function cardOf(s, ctx) {
  if (s.card !== undefined) return s.card;
  const c = {
    title: s.data.title,
    url: s.url,
    date: s.data.date === undefined ? '' : s.data.date,
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, ctx.dateCache),
    summary: s.data.summary === undefined ? '' : s.data.summary,
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
  s.card = c;
  return c;
}

function linkOf(s, ctx) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date === undefined ? '' : s.data.date,
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, ctx.dateCache),
  };
}

// One site's output tree: path -> text.
export function run(input) {
  const ctx = {
    slugCache: new Map(),
    dateCache: new Map(),
    templates: new Map(),
    bySource: new Map(),
    staticPaths: new Set(),
    broken: new Set(),
  };
  let base = input.site.base_url;
  let e = base.length;
  while (e > 0 && base.charCodeAt(e - 1) === 47) e--;
  base = base.slice(0, e);
  ctx.base = base;

  const report = [];

  // Templates, parsed in code-unit order of name; one that does not parse is
  // reported and left out.
  const templateNames = Object.keys(input.templates).sort(cmp);
  for (let i = 0; i < templateNames.length; i++) {
    const name = templateNames[i];
    try {
      ctx.templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }

  // Sources, sorted by path in code-unit order; .md files are sources with
  // line ends made "\n", the rest are static.
  const files = [...input.files].sort((a, b) => cmp(a.path, b.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      // Normalise line ends, skipping the pass entirely when no \r is there.
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else {
      statics.push(f);
      ctx.staticPaths.add(f.path);
    }
  }

  // Front matter, in source order; the first failing check is reported.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout !== undefined ? s.data.layout : s.post ? 'post' : 'page';
    if (!ctx.templates.has(layout)) {
      report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each slug made unique in its directory, in source order.
  const taken = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED_DIRS : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugify(s.data.title, ctx.slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    ctx.bySource.set(s.path, s);
  }

  // Markdown, each source's body rendered with its links resolved.
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const link = (target) => {
      if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && ctx.bySource.has(path)) return ctx.bySource.get(path).url + frag;
      if (path !== null && ctx.staticPaths.has(path)) return base + '/' + path + frag;
      ctx.broken.add('broken-link ' + s.path + ' -> ' + target);
      return target;
    };
    const md = renderMarkdown(s.body, link, ctx);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts newest date first, equal dates by slug.
  const posts = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].post) posts.push(kept[i]);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags, grouped by slug, named as first met walking posts in collection
  // order, ordered by post count desc then slug.
  const bySlug = new Map();
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const names = ownTagNames(p, ctx);
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      const slug = slugify(name, ctx.slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const names = ownTagNames(s, ctx);
    s.tagRefs = names.map((name) => {
      const slug = slugify(name, ctx.slugCache);
      const tag = bySlug.get(slug);
      return tag !== undefined ? tag : { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort(
    (x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug),
  );

  // Layouts: every page through its layout, the index pages, the tag pages
  // and the tags page, then the static files.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p, ctx));
  const render = (name, rootVars) => {
    const nodes = ctx.templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: rootVars, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const card = cardOf(s, ctx);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer === undefined ? null : s.newer, ctx),
      older: linkOf(s.older === undefined ? null : s.older, ctx),
      is_post: s.post,
    };
    output[s.outDir + '/index.html'] = render(s.layout, { site, tags: allTags, recent, page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      site,
      tags: allTags,
      recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p, ctx)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const html = render('tag', {
      site,
      tags: allTags,
      recent,
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p, ctx)) },
    });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', { site, tags: allTags, recent });
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // The report: every reported line plus each broken link, sorted in
  // code-unit order, then the counts.
  const lines = [...report, ...ctx.broken].sort(cmp);
  let pageCount = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].post) pageCount++;
  lines.push(
    'built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files',
  );
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}

export default run;
