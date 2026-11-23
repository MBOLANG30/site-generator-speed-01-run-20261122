// A fast drop-in for makefun-site 1.0.0.
//
// Written from the makefun-site README and its reference behaviour: the same
// front matter, Markdown subset, template dialect, slug rule and report, byte
// for byte, but built for speed. The whole build runs in one pass over each
// source where the reference lexes first and renders second: Markdown blocks
// are recognised straight off the raw body text, inline markup is rendered
// by one scanner over index ranges (no sliced copies for nested spans), and
// each template is compiled once per case into a flat op list that renders
// against a single mutable bindings object instead of a chain of scopes.
//
// Nothing is cached between cases: every per-case table (slug cache,
// compiled templates, page views) is built fresh inside run().

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// ------------------------------------------------------------------ text

const ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const ESC_RE = /[&<>"']/;

// Escape the five HTML characters. The common case (no special character at
// all) is caught by one native scan and the string is returned untouched;
// only a string that really holds one is rebuilt.
function esc(s) {
  if (!ESC_RE.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const e = ENTITIES[s[i]];
    if (e !== undefined) {
      out += s.slice(start, i);
      out += e;
      start = i + 1;
    }
  }
  return out + s.slice(start);
}

// The slug of a string: NFKD, combining marks dropped, A-Z lowered, every
// run of other characters one "-", none at either end, at most 64 chars (a
// "-" left at the cut dropped), "untitled" when nothing is left.
function slugifyRaw(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

// The first of slug, slug-2, slug-3 ... not yet taken (and taken now).
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out = slug + '-2';
  while (taken.has(out)) {
    n++;
    out = slug + '-' + n;
  }
  taken.add(out);
  return out;
}

// A YYYY-MM-DD date in words, from the string alone.
function longDate(date) {
  return (
    Number(date.slice(8, 10)) +
    ' ' +
    MONTHS[Number(date.slice(5, 7)) - 1] +
    ' ' +
    date.slice(0, 4)
  );
}

// The JavaScript whitespace set as a table: WS_TABLE[c] is 1 when the
// character with code c is whitespace (9-13, 32, 160, 0x1680, 0x2000-0x200a,
// 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff), else 0.
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;

// The characters that stop a plain inline run: backslash, backtick, star,
// [, &, <, >, " and '.
const SPECIAL = new Uint8Array(65536);
for (const c of [92, 96, 42, 91, 38, 60, 62, 34, 39]) SPECIAL[c] = 1;

// Runs of characters other than whitespace, counted without a regex: one
// table lookup per character.
function countWords(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

function hasWS(t) {
  for (let i = 0; i < t.length; i++) {
    if (WS_TABLE[t.charCodeAt(i)] === 1) return true;
  }
  return false;
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

// `rel` from the directory `dir`, or null when it climbs out of the root.
// Built on the strings themselves, with no split or join.
function resolvePath(dir, rel) {
  let out = dir;
  let i = 0;
  const n = rel.length;
  while (i < n) {
    let j = rel.indexOf('/', i);
    if (j === -1) j = n;
    const seg = rel.slice(i, j);
    if (seg === '' || seg === '.') {
      // skipped
    } else if (seg === '..') {
      if (out === '') return null;
      const k = out.lastIndexOf('/');
      out = k === -1 ? '' : out.slice(0, k);
    } else {
      out = out === '' ? seg : out + '/' + seg;
    }
    i = j + 1;
  }
  return out;
}

// ------------------------------------------------------------------ front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function validDate(raw) {
  if (raw.length !== 10 || raw[4] !== '-' || raw[7] !== '-') return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = Number(raw.slice(0, 4));
  const mo = Number(raw.slice(5, 7));
  const d = Number(raw.slice(8, 10));
  if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysIn(y, mo);
}

// A template name: a-z, 0-9 and "-", at least one character.
function validName(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) return false;
  }
  return true;
}

// A slug: a-z and 0-9, single "-" between, at most 64 characters.
function validSlug(raw) {
  if (raw.length === 0 || raw.length > 64) return false;
  let prevDash = true;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '-') {
      if (prevDash) return false;
      prevDash = true;
    } else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
      prevDash = false;
    } else {
      return false;
    }
  }
  return !prevDash;
}

// A string value: "..." whose only escapes are \" and \\, or bare (never
// opening on " or [). Returns { value } or { error } with the bare reason.
function parseString(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') {
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
      } else {
        out += c;
      }
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

// One key's value, or { error } with the full reason.
function valueOf(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = parseString(raw);
    if (s.error !== undefined) return { error: `key "${key}": ${s.error}` };
    return s;
  }
  if (key === 'date') {
    if (!validDate(raw)) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw.length < 2 || raw[0] !== '[' || raw[raw.length - 1] !== ']') {
      return { error: 'key "tags": not a list [a, b]' };
    }
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const parts = inner.split(',');
    const out = [];
    for (let part of parts) {
      part = part.trim();
      if (part === '') {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      for (let i = 0; i < part.length; i++) {
        const c = part[i];
        if (c === '"' || c === '[' || c === ']') {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      out.push(part);
    }
    return { value: out };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    if (!validName(raw)) return { error: 'key "layout": not a template name' };
    return { value: raw };
  }
  if (!validSlug(raw)) return { error: 'key "slug": not a slug' };
  return { value: raw };
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// A source's front matter and body: { data, body }, or { error } with the
// first reason it is refused. `text` already has "\n" line ends.
function parseFM(text) {
  if (
    text.length < 3 || text[0] !== '-' || text[1] !== '-' || text[2] !== '-' ||
    (text.length > 3 && text[3] !== '\n')
  ) {
    return { error: 'no front matter' };
  }
  // The closing line: a line that is exactly "---".
  let closeLine = -1;
  let bodyStart = -1;
  let from = 3;
  for (;;) {
    const idx = text.indexOf('\n---', from);
    if (idx === -1) break;
    const after = idx + 4;
    if (after === text.length) {
      closeLine = idx + 1;
      bodyStart = text.length;
      break;
    }
    if (text[after] === '\n') {
      closeLine = idx + 1;
      bodyStart = after + 1;
      break;
    }
    from = idx + 1;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  const regionEnd = closeLine - 1;
  let pos = 4;
  let lineNo = 2;
  while (pos <= regionEnd) {
    let e = text.indexOf('\n', pos);
    if (e === -1 || e > regionEnd) e = regionEnd;
    const line = text.slice(pos, e);
    if (!isBlank(line) && line[0] !== '#') {
      let k = 0;
      while (k < line.length) {
        const c = line[k];
        if ((c >= 'a' && c <= 'z') || c === '_') k++;
        else break;
      }
      if (k === 0 || line[k] !== ':') {
        return { error: `line ${lineNo} is not "key: value"` };
      }
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line[k + 1] === ' ') raw = line.slice(k + 2);
      else return { error: `line ${lineNo} is not "key: value"` };
      let re = raw.length;
      while (re > 0 && (raw[re - 1] === ' ' || raw[re - 1] === '\t')) re--;
      raw = raw.slice(0, re);
      if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if (v.error !== undefined) return v;
      data[key] = v.value;
    }
    pos = e + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ------------------------------------------------------------------ Markdown

// Spaces and tabs at either end dropped.
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

// A fence opening: ``` plus an optional language, then spaces/tabs only.
// Returns the language, or null when the line is not one.
function fenceLang(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let i = 3;
  while (i < line.length) {
    const c = line[i];
    if (
      (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
      (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-'
    ) {
      i++;
    } else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    if (line[i] !== ' ' && line[i] !== '\t') return null;
    i++;
  }
  return lang;
}

// A fence closing: ``` then spaces or tabs only.
function isFenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let i = 3; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

// A heading line's level and text, or null (a heading's text is never empty).
function headingOf(line) {
  let k = 0;
  while (k < line.length && line[k] === '#') k++;
  if (k === 0 || k > 6) return null;
  let j = k;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  if (j === k || j >= line.length) return null;
  let end = line.length;
  while (end > j && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  if (end === j) return null;
  return { depth: k, text: line.slice(j, end) };
}

// A thematic break: --- or ***, then spaces or tabs only.
function isHR(line) {
  if (line.length < 3) return false;
  const c = line[0];
  if (c !== '-' && c !== '*') return false;
  if (line[1] !== c || line[2] !== c) return false;
  for (let i = 3; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

// An ordered list's opening: 1 to 9 digits, ". ", and the item's text.
function orderedStart(line) {
  let k = 0;
  while (k < line.length && line[k] >= '0' && line[k] <= '9') k++;
  if (k === 0 || k > 9) return null;
  if (line[k] !== '.' || line[k + 1] !== ' ') return null;
  return { num: Number(line.slice(0, k)), rest: line.slice(k + 2) };
}

// A list continuation: two or more spaces, then a non-space.
function isContinued(line) {
  let k = 0;
  while (k < line.length && line[k] === ' ') k++;
  if (k < 2 || k >= line.length) return false;
  return WS_TABLE[line.charCodeAt(k)] !== 1;
}

// Line kinds, classified once per line so a line is never scanned twice:
// blank, fence opening, heading, thematic break, blockquote, bullet item,
// ordered item, anything else (a paragraph line).
const L_BLANK = 0;
const L_FENCE = 1;
const L_HEADING = 2;
const L_HR = 3;
const L_QUOTE = 4;
const L_BULLET = 5;
const L_ORDERED = 6;
const L_TEXT = 7;

// One pass over `line`, dispatching on its first character (the block kinds
// are disjoint by first character, and the order below is the reference's
// check order). Returns the kind only; a block re-derives its own data from
// the line when it consumes it, so a line that is only peeked costs nothing
// but the classification.
function classify(line) {
  if (line.length === 0) return L_BLANK;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) {
    for (let i = 1; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) return L_TEXT;
    }
    return L_BLANK;
  }
  if (c0 === 96) return fenceLang(line) === null ? L_TEXT : L_FENCE;
  if (c0 === 35) return headingOf(line) === null ? L_TEXT : L_HEADING;
  if (c0 === 45 || c0 === 42) {
    if (isHR(line)) return L_HR;
    if (line.charCodeAt(1) === 32) return L_BULLET;
    return L_TEXT;
  }
  if (c0 === 62) return L_QUOTE;
  if (c0 >= 48 && c0 <= 57) return orderedStart(line) === null ? L_TEXT : L_ORDERED;
  return L_TEXT;
}

const ESCAPABLE = new Set([
  '\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>',
]);

// The first index from `from` where `s` holds `what` outside a backslash
// escape, or -1. `hi` bounds the range being rendered.
function findUnescaped(s, what, from, hi) {
  const wlen = what.length;
  for (let j = from; j <= hi - wlen; j++) {
    if (s[j] === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

// The first single * from `from` (one whose run is not **), outside an
// escape, or -1.
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
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

// `s[lo..hi]` rendered inline; `link(target)` resolves a link's href.
// Nested spans recurse over index ranges and return their strings, so no
// sliced copy of the span text is ever made. Plain runs are scanned by
// character code, and the result is built by concatenation, so each
// character is copied once, when the finished string is flattened.
function inlineStr(s, lo, hi, link) {
  let out = '';
  let i = lo;
  while (i < hi) {
    // A run of plain characters: no escape, no markup starter. One table
    // lookup per character.
    let j = i;
    while (j < hi && SPECIAL[s.charCodeAt(j)] !== 1) j++;
    if (j > i) {
      out += s.slice(i, j);
      i = j;
    }
    if (i >= hi) break;
    const c = s[i];
    if (c === '&') {
      out += '&amp;';
      i++;
      continue;
    }
    if (c === '<') {
      out += '&lt;';
      i++;
      continue;
    }
    if (c === '>') {
      out += '&gt;';
      i++;
      continue;
    }
    if (c === '"') {
      out += '&quot;';
      i++;
      continue;
    }
    if (c === "'") {
      out += '&#39;';
      i++;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < hi && ESCAPABLE.has(s[i + 1])) {
        // The escaped character is written escaped: ">" is both escapable
        // and one of the five HTML characters, so "\>" is "&gt;".
        out += s[i + 1] === '>' ? '&gt;' : s[i + 1];
        i += 2;
      } else {
        out += '\\';
        i++;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k !== -1 && k < hi && k > i + 1) {
        out += '<code>' + esc(s.slice(i + 1, k)) + '</code>';
        i = k + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2, hi);
        if (k > i + 2) {
          out += '<strong>' + inlineStr(s, i + 2, k, link) + '</strong>';
          i = k + 2;
        } else {
          out += '**';
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(s, i + 1, hi);
      if (k > i + 1) {
        out += '<em>' + inlineStr(s, i + 1, k, link) + '</em>';
        i = k + 1;
      } else {
        out += '*';
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, hi);
      let m = -1;
      if (k !== -1 && s[k + 1] === '(') {
        const t = s.indexOf(')', k + 2);
        if (t !== -1 && t < hi) m = t;
      }
      if (m !== -1) {
        const target = s.slice(k + 2, m);
        if (target !== '' && !hasWS(target)) {
          out += '<a href="' + esc(link(target)) + '">' + inlineStr(s, i + 1, k, link) + '</a>';
          i = m + 1;
          continue;
        }
      }
      out += '[';
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// `src` rendered: its HTML, its table of contents (level 2 and 3 headings)
// and its excerpt (the first paragraph's inline HTML, or ""). Blocks are
// read straight off the body text through a one-line lookahead: each line
// is sliced and classified once, then consumed by exactly one block.
function renderMarkdown(src, link, slugOf) {
  const n = src.length;
  let html = '';
  const toc = [];
  const ids = new Set();
  let excerpt = '';
  let haveExcerpt = false;
  let p = 0;
  let valid = false;
  let pl = '';
  let pk = 0;
  let pn = 0;
  const peek = () => {
    if (valid) return true;
    if (p > n) return false;
    let e = src.indexOf('\n', p);
    if (e === -1) e = n;
    pl = src.slice(p, e);
    pn = e + 1;
    pk = classify(pl);
    valid = true;
    return true;
  };
  const take = () => {
    p = pn;
    valid = false;
  };
  while (peek()) {
    if (pk === L_BLANK) {
      take();
      continue;
    }
    if (pk === L_FENCE) {
      const lang = fenceLang(pl);
      take();
      let code = '';
      for (;;) {
        if (!peek()) break;
        if (isFenceClose(pl)) {
          take();
          break;
        }
        const l = pl;
        take();
        code += esc(l) + '\n';
      }
      html += '<pre><code';
      if (lang !== '') html += ' class="language-' + esc(lang) + '"';
      html += '>' + code + '</code></pre>\n';
      continue;
    }
    if (pk === L_HEADING) {
      const hd = headingOf(pl);
      take();
      const id = uniqueSlug(slugOf(hd.text), ids);
      const h = inlineStr(hd.text, 0, hd.text.length, link);
      html += '<h' + hd.depth + ' id="' + id + '">' + h + '</h' + hd.depth + '>\n';
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html: h });
      continue;
    }
    if (pk === L_HR) {
      take();
      html += '<hr>\n';
      continue;
    }
    if (pk === L_QUOTE) {
      const qlines = [];
      for (;;) {
        if (!peek() || pk !== L_QUOTE) break;
        const s = trimLine(pl.charCodeAt(1) === 32 ? pl.slice(2) : pl.slice(1));
        take();
        if (s !== '') qlines.push(s);
      }
      if (qlines.length === 0) {
        html += '<blockquote>\n</blockquote>\n';
      } else {
        const joined = qlines.join('\n');
        html += '<blockquote>\n<p>' + inlineStr(joined, 0, joined.length, link) + '</p>\n</blockquote>\n';
      }
      continue;
    }
    if (pk === L_BULLET || pk === L_ORDERED) {
      const ordered = pk === L_ORDERED;
      const od = ordered ? orderedStart(pl) : null;
      const startNum = ordered ? od.num : 1;
      const items = [[trimLine(ordered ? od.rest : pl.slice(2))]];
      take();
      for (;;) {
        if (!peek()) break;
        if (ordered ? pk === L_ORDERED : pk === L_BULLET) {
          items.push([trimLine(ordered ? orderedStart(pl).rest : pl.slice(2))]);
          take();
          continue;
        }
        if (pk === L_TEXT && isContinued(pl)) {
          items[items.length - 1].push(trimLine(pl));
          take();
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      html += ordered && startNum !== 1 ? '<ol start="' + startNum + '">\n' : '<' + tag + '>\n';
      for (const it of items) {
        const txt = it.join('\n');
        html += '<li>' + inlineStr(txt, 0, txt.length, link) + '</li>\n';
      }
      html += '</' + tag + '>\n';
      continue;
    }
    const plines = [trimLine(pl)];
    take();
    for (;;) {
      if (!peek()) break;
      if (pk === L_BLANK || pk === L_FENCE || pk === L_HEADING || pk === L_HR) break;
      plines.push(trimLine(pl));
      take();
    }
    const ptext = plines.join('\n');
    const phtml = inlineStr(ptext, 0, ptext.length, link);
    if (!haveExcerpt) {
      excerpt = phtml;
      haveExcerpt = true;
    }
    html += '<p>' + phtml + '</p>\n';
  }
  return { html, toc, excerpt };
}

// ------------------------------------------------------------------ templates

class TemplateError extends Error {}

// Op kinds in a compiled template.
const OP_TEXT = 0;
const OP_VAR = 1;
const OP_RAW = 2;
const OP_IF = 3;
const OP_FOR = 4;
const OP_INCLUDE = 5;

function isNameStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function isNameChar(c) {
  return isNameStart(c) || (c >= 48 && c <= 57);
}

// The path `text` names, split at its dots, or a TemplateError.
function splitPath(name, text) {
  const parts = text.split('.');
  for (const seg of parts) {
    if (seg.length === 0 || !isNameStart(seg.charCodeAt(0))) {
      throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
    }
    for (let i = 1; i < seg.length; i++) {
      if (!isNameChar(seg.charCodeAt(i))) {
        throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
      }
    }
  }
  return parts;
}

function onlySpaceTab(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return true;
}

// `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line
// taken with it.
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const len = src.length;
  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) {
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
        throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      }
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({
        t: raw ? 'raw' : 'var',
        path: splitPath(name, src.slice(open + (raw ? 3 : 2), close).trim()),
      });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    const standalone =
      onlySpaceTab(src.slice(lineStart, open)) && onlySpaceTab(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? len : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// `for x in path`: the loop name and the path text, or null.
function matchFor(tag) {
  if (!tag.startsWith('for ')) return null;
  let j = 4;
  if (j >= tag.length || !isNameStart(tag.charCodeAt(j))) return null;
  while (j < tag.length && isNameChar(tag.charCodeAt(j))) j++;
  if (tag.slice(j, j + 4) !== ' in ') return null;
  const rest = tag.slice(j + 4);
  if (rest === '' || hasWS(rest)) return null;
  return { name: tag.slice(4, j), path: rest };
}

// `if path` or `if not path`: the path text and whether it is negated.
function matchIf(tag) {
  if (!tag.startsWith('if ')) return null;
  let rest = tag.slice(3);
  let not = false;
  if (rest.startsWith('not ')) {
    not = true;
    rest = rest.slice(4);
  }
  if (rest === '' || hasWS(rest)) return null;
  return { not, path: rest };
}

// `include "name"`: the name, or null.
function matchInclude(tag) {
  if (!tag.startsWith('include "') || !tag.endsWith('"') || tag.length < 11) return null;
  const nm = tag.slice(9, -1);
  if (nm === '') return null;
  for (let i = 0; i < nm.length; i++) {
    const c = nm[i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) return null;
  }
  return nm;
}

// Tokens compiled into a flat op list (a TemplateError when it does not
// parse). Op shapes: [0, text] [1|2, path] [3, path, not, then, else|null]
// [4, name, path, body] [5, name].
function buildOps(name, tokens) {
  const root = [];
  const stack = [{ kind: 'root', op: null, body: root }];
  let body = root;
  for (const tok of tokens) {
    if (tok.t === 'text') {
      body.push([OP_TEXT, tok.text]);
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      body.push([tok.t === 'var' ? OP_VAR : OP_RAW, tok.path]);
      continue;
    }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = matchFor(tag)) !== null) {
      const op = [OP_FOR, m.name, splitPath(name, m.path), []];
      body.push(op);
      stack.push({ kind: 'for', op, body: op[3] });
      body = op[3];
    } else if ((m = matchIf(tag)) !== null) {
      const op = [OP_IF, splitPath(name, m.path), m.not, [], null];
      body.push(op);
      stack.push({ kind: 'if', op, body: op[3] });
      body = op[3];
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.op[4] !== null) {
        throw new TemplateError(`template "${name}": an else outside an if`);
      }
      top.op[4] = [];
      top.body = top.op[4];
      body = top.op[4];
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== want) {
        throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      }
      stack.pop();
      body = stack[stack.length - 1].body;
    } else if ((m = matchInclude(tag)) !== null) {
      body.push([OP_INCLUDE, m]);
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) {
    throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  }
  return root;
}

// A value as text: a string itself, a number in JavaScript's digits, true
// or false, an array's items written and joined by ", ", anything else "".
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

// Whether a value counts as true in an if: not undefined, null, false, "",
// 0 or an empty array.
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// A compiled template's ops turned into the body of a function
// (B, D, T, E, X, Y) => string: B the bindings, D the include depth, T the
// map of compiled templates, E the HTML escape, X a value as text, Y the
// if-truthiness test. Text is literal, paths resolve inline through the
// same own-property walk the interpreter did (one shared scratch slot _t),
// loops save and restore what they shadow, and includes stop past depth 8.
function pathExpr(parts) {
  let e =
    'Object.hasOwn(B,' + JSON.stringify(parts[0]) + ')?B[' + JSON.stringify(parts[0]) + ']:undefined';
  for (let k = 1; k < parts.length; k++) {
    const seg = JSON.stringify(parts[k]);
    e =
      '(_t=' + e + ',_t!==null&&typeof _t==="object"&&Object.hasOwn(_t,' + seg + ')?_t[' + seg + ']:undefined)';
  }
  return e;
}

function genOps(ops, ctr) {
  let src = '';
  for (const op of ops) {
    if (op[0] === OP_TEXT) {
      src += 's+=' + JSON.stringify(op[1]) + ';';
    } else if (op[0] === OP_VAR) {
      src += 's+=E(X(' + pathExpr(op[1]) + '));';
    } else if (op[0] === OP_RAW) {
      src += 's+=X(' + pathExpr(op[1]) + ');';
    } else if (op[0] === OP_IF) {
      src += 'if(Y(' + pathExpr(op[1]) + ')===' + String(!op[2]) + '){';
      src += genOps(op[3], ctr);
      if (op[4] !== null) {
        src += '}else{';
        src += genOps(op[4], ctr);
      }
      src += '}';
    } else if (op[0] === OP_FOR) {
      const v = ctr.n++;
      const nm = JSON.stringify(op[1]);
      src += '{const _a' + v + '=' + pathExpr(op[2]) + ';if(Array.isArray(_a' + v + ')){';
      src += 'const _hn' + v + '=Object.hasOwn(B,' + nm + ');const _on' + v + '=B[' + nm + '];';
      src += 'const _hl' + v + '=Object.hasOwn(B,"loop");const _ol' + v + '=B["loop"];';
      src += 'const _lo' + v + '={index:0,first:false,last:false,length:_a' + v + '.length};';
      src += 'for(let _k' + v + '=0;_k' + v + '<_a' + v + '.length;_k' + v + '++){';
      src += '_lo' + v + '.index=_k' + v + '+1;_lo' + v + '.first=_k' + v + '===0;_lo' + v + '.last=_k' + v + '===_a' + v + '.length-1;';
      src += 'B[' + nm + ']=_a' + v + '[_k' + v + '];B["loop"]=_lo' + v + ';';
      src += genOps(op[3], ctr);
      src += '}';
      src += 'if(_hn' + v + ')B[' + nm + ']=_on' + v + ';else delete B[' + nm + '];';
      src += 'if(_hl' + v + ')B["loop"]=_ol' + v + ';else delete B["loop"];}}';
    } else {
      const v = ctr.n++;
      src += '{const _f' + v + '=T.get(' + JSON.stringify(op[1]) + ');if(_f' + v + '!==undefined&&D<8)s+=_f' + v + '(B,D+1,T,E,X,Y);}';
    }
  }
  return src;
}

function compileTemplate(ops) {
  const body = 'let s="",_t;' + genOps(ops, { n: 0 }) + 'return s;';
  return new Function('B', 'D', 'T', 'E', 'X', 'Y', body);
}

// A whole template rendered, or null when there is no such template.
function renderTemplate(templates, name, bindings) {
  const fn = templates.get(name);
  if (fn === undefined) return null;
  return fn(bindings, 0, templates, esc, textOf, truthy);
}

// ------------------------------------------------------------------ the build

function stripTrailing(u) {
  let e = u.length;
  while (e > 0 && u[e - 1] === '/') e--;
  return u.slice(0, e);
}

function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// One site's output tree: path -> text.
export function run(input) {
  // Per-case tables only: nothing survives from one case to the next.
  const slugCache = new Map();
  const slugOf = (t) => {
    let s = slugCache.get(t);
    if (s === undefined) {
      s = slugifyRaw(t);
      slugCache.set(t, s);
    }
    return s;
  };

  // Templates, parsed in code-unit order of their name and compiled once
  // into rendering functions. One that does not parse is reported and left
  // out, as if it were not there.
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort()) {
    try {
      templates.set(name, compileTemplate(buildOps(name, tokenize(name, input.templates[name]))));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }

  const base = stripTrailing(input.site.base_url);

  // Sources, in code-unit order of their paths; line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({
        path: f.path,
        text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n'),
      });
    } else {
      statics.push(f);
    }
  }

  // Front matter, in source order. The checks run in order and the first
  // one that fails is the one reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFM(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout !== undefined ? s.data.layout : s.post ? 'post' : 'page';
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each slug made unique in its directory, in source order.
  const takenByDir = new Map();
  const takenIn = (dir) => {
    let set = takenByDir.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      takenByDir.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(
      s.data.slug !== undefined ? s.data.slug : slugOf(s.data.title),
      takenIn(dir),
    );
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (hasScheme(target) || target[0] === '/' || target[0] === '#') return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const pg = bySource.get(path);
        if (pg !== undefined) return pg.url + frag;
        if (staticPaths.has(path)) return base + '/' + path + frag;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugOf);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort(
    (x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug),
  );
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: grouped by slug, named as first met walking the posts in
  // collection order, ordered by count then slug.
  const ownTagNames = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags;
    if (tags !== undefined) {
      for (const name of tags) {
        const sg = slugOf(name);
        if (!seen.has(sg)) {
          seen.add(sg);
          out.push(name);
        }
      }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTagNames(p)) {
      const sg = slugOf(name);
      let tag = bySlug.get(sg);
      if (tag === undefined) {
        tag = { name, slug: sg, url: base + '/tags/' + sg + '/', posts: [], view: { name, slug: sg, url: base + '/tags/' + sg + '/' } };
        bySlug.set(sg, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTagNames(s).map((name) => {
      const sg = slugOf(name);
      const t = bySlug.get(sg);
      if (t !== undefined) return t;
      const fresh = { name, slug: sg, url: '', posts: [] };
      fresh.view = { name, slug: sg, url: '' };
      return fresh;
    });
  }
  // Each source's tags as templates read them, built once: the same tag's
  // view is shared by every card that carries it.
  for (const s of kept) s.tagViews = s.tagRefs.map((t) => t.view);
  const tags = [...bySlug.values()].sort(
    (x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug),
  );

  // The views templates read: a card, a page, a link, a tag.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date !== undefined ? s.data.date : '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary !== undefined ? s.data.summary : '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
    tags: s.tagViews,
  });
  const linkOf = (s) =>
    s === null
      ? null
      : {
          title: s.data.title,
          url: s.url,
          date: s.data.date !== undefined ? s.data.date : '',
          date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        };
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const linkViews = new Map();
  for (const p of posts) linkViews.set(p, linkOf(p));
  const pageOf = (s) => {
    const card = s.post ? cards.get(s) : cardOf(s);
    return {
      title: card.title,
      url: card.url,
      date: card.date,
      date_long: card.date_long,
      summary: card.summary,
      excerpt: card.excerpt,
      reading_minutes: card.reading_minutes,
      tags: card.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: s.post ? (s.newer === null ? null : linkViews.get(s.newer)) : null,
      older: s.post ? (s.older === null ? null : linkViews.get(s.older)) : null,
      is_post: s.post,
    };
  };

  // Layouts: every page through its layout, the index pages, the tag pages.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const topBindings = (vars) => ({ site, tags: allTags, recent, ...vars });
  for (const s of kept) {
    output[s.outDir + '/index.html'] = renderTemplate(templates, s.layout, topBindings({ page: pageOf(s) }));
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = renderTemplate(
      templates,
      'index',
      topBindings({
        posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
        pager: {
          number: k,
          total: pages,
          url: indexUrl(k),
          newer_url: k === 1 ? '' : indexUrl(k - 1),
          older_url: k === pages ? '' : indexUrl(k + 1),
        },
      }),
    );
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = renderTemplate(
      templates,
      'tag',
      topBindings({
        tag: {
          name: t.name,
          slug: t.slug,
          url: t.url,
          count: t.posts.length,
          posts: t.posts.map((p) => cards.get(p)),
        },
      }),
    );
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = renderTemplate(templates, 'tags', topBindings({}));
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported above and each broken link, sorted,
  // then the counts.
  const lines = [...report, ...broken].sort();
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(
    `built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`,
  );
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}

// A target with a scheme (`https:`, `mailto:` ...).
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (
      !((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
        c === 43 || c === 45 || c === 46)
    ) {
      return false;
    }
  }
  return false;
}
