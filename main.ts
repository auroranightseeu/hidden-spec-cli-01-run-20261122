// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful move edit made: [old path, new path]. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 3: files and lines

interface FileLines {
  lines: string[];
  finalBreak: boolean;
  br: string;
}

function toLines(text: string): FileLines {
  if (text === '') return { lines: [], finalBreak: false, br: '\n' };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  const lines = text.split(br);
  if (finalBreak) lines.pop();
  return { lines, finalBreak, br };
}

function fromLines(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

// ---------------------------------------------------------------------------
// Section 5: matching lines

type Part = { kind: 'ctx' | 'old' | 'new'; text: string };

// `--strict` is threaded through this module-level flag, set by run().
let STRICT = false;

const stripEnd = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => (/^[ \t]*/.exec(s) as RegExpExecArray)[0];

/** O's occurrences at the first tier where it occurs (SPEC.md section 5). */
function findTier(file: string[], O: string[], strict: boolean, from = 0, atEnd = false): { tier: number; positions: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const f = t === 0 ? (x: string): string => x : t === 1 ? stripEnd : stripBoth;
    const o = O.map(f);
    const positions: number[] = [];
    for (let i = from; i + O.length <= file.length; i++) {
      if (atEnd && i + O.length !== file.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (f(file[i + j]!) !== o[j]!) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** The lines N writes when O (matched at `tier` at `pos`) is replaced (SPEC.md section 5). */
function buildNew(file: string[], pos: number, parts: Part[], tier: number, O: string[]): string[] {
  const out: string[] = [];
  const F = tier === 2 ? leadWs(file[pos] ?? '') : '';
  const P = tier === 2 ? leadWs(O[0] ?? '') : '';
  let oi = 0;
  for (const p of parts) {
    if (p.kind === 'ctx') {
      out.push(file[pos + oi]!);
      oi += 1;
    } else if (p.kind === 'old') {
      oi += 1;
    } else {
      let t = p.text;
      if (tier === 2 && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs

interface Hunk {
  a: number;
  body: string[];
  parts: Part[];
  noFinal: boolean;
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  kind: 'create' | 'delete' | 'move' | 'change';
  hunks: Hunk[];
  createdNoFinal: boolean;
}

function parsePath(s: string): string | null {
  const tab = s.indexOf('\t');
  let p = (tab >= 0 ? s.slice(0, tab) : s).trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

function bodyParts(body: string[]): Part[] {
  const parts: Part[] = [];
  for (const b of body) {
    if (b === '') parts.push({ kind: 'ctx', text: '' });
    else if (b.startsWith(' ')) parts.push({ kind: 'ctx', text: b.slice(1) });
    else if (b.startsWith('-')) parts.push({ kind: 'old', text: b.slice(1) });
    else if (b.startsWith('+')) parts.push({ kind: 'new', text: b.slice(1) });
  }
  return parts;
}

function noFinalFlag(body: string[], starts: (s: string) => boolean): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) if (starts(body[k]!)) last = k;
  return last >= 0 && (body[last + 1] ?? '').startsWith('\\');
}

function applyUnifiedHunks(f: FileLines, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const O = h.parts.filter((p) => p.kind !== 'new').map((p) => p.text);
    const N = h.parts.filter((p) => p.kind !== 'old').map((p) => p.text);
    if (O.length === 0) {
      const at = Math.min(h.a + d, f.lines.length);
      const atEnd = at === f.lines.length;
      const nl = buildNew(f.lines, at, h.parts, 0, O);
      f.lines.splice(at, 0, ...nl);
      if (atEnd) f.finalBreak = !h.noFinal;
    } else {
      const r = findTier(f.lines, O, strict);
      if (r === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = r.positions[0]!;
      for (const p of r.positions) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      const atEnd = pos + O.length === f.lines.length;
      const nl = buildNew(f.lines, pos, h.parts, r.tier, O);
      f.lines.splice(pos, O.length, ...nl);
      if (atEnd) f.finalBreak = !h.noFinal;
    }
    d += N.length - O.length;
  }
}

function parseSection(lines: string[], start: number): { edit: Edit; next: number } {
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let creation = false;
  let deletion = false;
  let hasPair = false;
  let renFrom: string | null = null;
  let renTo: string | null = null;
  let diffOld: string | null = null;
  let diffNew: string | null = null;
  let i = start;
  if (lines[i]!.startsWith('diff --git ')) {
    const m = /^a\/(.*) b\/(.*)$/.exec(lines[i]!.slice('diff --git '.length));
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    diffOld = m[1]!;
    diffNew = m[2]!;
    i += 1;
  }
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) break;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        oldPath = parsePath(l.slice(4));
        newPath = parsePath(lines[i + 1]!.slice(4));
        hasPair = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('rename from ')) {
      renFrom = l.slice('rename from '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      renTo = l.slice('rename to '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('new file mode')) {
      creation = true;
      i += 1;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      deletion = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (!hasPair) {
    if (renFrom !== null) oldPath = renFrom;
    if (renTo !== null) newPath = renTo;
    if (oldPath === null && !creation && diffOld !== null) oldPath = diffOld;
    if (newPath === null && !deletion && diffNew !== null) newPath = diffNew;
  }
  const hunks: Hunk[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i += 1;
      const body: string[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      hunks.push({ a, body, parts: bodyParts(body), noFinal: noFinalFlag(body, (s) => s.startsWith(' ') || s.startsWith('+')) });
      continue;
    }
    i += 1;
  }
  let createdNoFinal = false;
  for (let h = hunks.length - 1; h >= 0; h--) {
    if (hunks[h]!.body.some((b) => b.startsWith('+'))) {
      createdNoFinal = noFinalFlag(hunks[h]!.body, (s) => s.startsWith('+'));
      break;
    }
  }
  let kind: USection['kind'];
  if (creation || oldPath === null) kind = 'create';
  else if (deletion || newPath === null) kind = 'delete';
  else if (oldPath !== newPath) kind = 'move';
  else kind = 'change';
  const sec: USection = { oldPath, newPath, kind, hunks, createdNoFinal };
  return { edit: unifiedEdit(sec), next: i };
}

function unifiedEdit(sec: USection): Edit {
  return (tree) => {
    const { oldPath, newPath, kind, hunks } = sec;
    if (kind !== 'create' && oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (kind !== 'delete' && newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (kind === 'create') {
      if (newPath === null) return;
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const out: string[] = [];
      for (const h of hunks) for (const p of h.parts) if (p.kind === 'new') out.push(p.text);
      tree.now.set(newPath, out.length === 0 ? '' : out.join('\n') + (sec.createdNoFinal ? '' : '\n'));
      return;
    }
    if (kind === 'delete') {
      if (oldPath === null) return;
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    const src = oldPath!;
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    if (kind === 'move') {
      const dst = newPath!;
      if (tree.get(dst) !== null) throw new Fail('exists', dst);
      const f = toLines(before);
      applyUnifiedHunks(f, hunks, STRICT, src);
      tree.now.set(src, null);
      tree.now.set(dst, fromLines(f));
      tree.moves.push([src, dst]);
      return;
    }
    const f = toLines(before);
    applyUnifiedHunks(f, hunks, STRICT, src);
    tree.now.set(src, fromLines(f));
  };
}

function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
      const r = parseSection(lines, i);
      edits.push(r.edit);
      i = r.next;
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks

function blockEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = toLines(before);
    const r = findTier(f.lines, oldLines, STRICT);
    if (r === null) throw new Fail('no-match', path);
    if (r.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = r.positions[0]!;
    const parts: Part[] = [
      ...oldLines.map((t): Part => ({ kind: 'old', text: t })),
      ...newLines.map((t): Part => ({ kind: 'new', text: t })),
    ];
    const nl = buildNew(f.lines, pos, parts, r.tier, oldLines);
    f.lines.splice(pos, oldLines.length, ...nl);
    tree.now.set(path, fromLines(f));
  };
}

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let k = i - 1; k >= prevEnd; k--) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${searchLine}`);
      j += 1;
    }
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(blockEdit(path, lines.slice(i + 1, j), lines.slice(j + 1, k)));
    prevPath = path;
    prevEnd = k + 1;
    i = k + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches

interface Chunk {
  hasAnchor: boolean;
  anchor: string | null;
  parts: Part[];
  eof: boolean;
}

const V4A_SEC = (l: string): 'add' | 'delete' | 'update' | null =>
  l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : l.startsWith('*** Update File: ') ? 'update' : null;

function v4aEdit(kind: 'add' | 'delete' | 'update', path: string, lines: string[], moveTo: string | null, chunks: Chunk[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    if (kind === 'add') {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, lines.length === 0 ? '' : `${lines.join('\n')}\n`);
      return;
    }
    if (kind === 'delete') {
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = toLines(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.hasAnchor && ch.anchor !== null) {
        const ar = findTier(f.lines, [ch.anchor], STRICT, cursor);
        if (ar === null) throw new Fail('no-match', path);
        cursor = ar.positions[0]! + 1;
      }
      const O = ch.parts.filter((p) => p.kind !== 'new').map((p) => p.text);
      if (O.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const nl = ch.parts.filter((p) => p.kind !== 'old').map((p) => p.text);
        f.lines.splice(at, 0, ...nl);
        cursor = at + nl.length;
      } else {
        const r = findTier(f.lines, O, STRICT, cursor, ch.eof);
        if (r === null) throw new Fail('no-match', path);
        const pos = r.positions[0]!;
        const nl = buildNew(f.lines, pos, ch.parts, r.tier, O);
        f.lines.splice(pos, O.length, ...nl);
        cursor = pos + nl.length;
      }
    }
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, fromLines(f));
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, fromLines(f));
    }
  };
}

function parseV4A(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const body = lines.slice(first + 1, last);
  const at = (idx: number): number => first + 2 + idx;
  const edits: Edit[] = [];
  let i = 0;
  while (i < body.length) {
    const l = body[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const kind = V4A_SEC(l);
    if (kind === null) throw new Exit2(`error: parse ${at(i)}`);
    const markerLine = at(i);
    const path = l.slice(`*** ${kind === 'add' ? 'Add File: ' : kind === 'delete' ? 'Delete File: ' : 'Update File: '}`.length).trim();
    i += 1;
    const start = i;
    while (i < body.length && V4A_SEC(body[i]!) === null) i += 1;
    let end = i;
    while (end > start && blank(body[end - 1]!)) end -= 1;
    const secLines = body.slice(start, end);
    const base = at(start);
    if (kind === 'add') {
      const out: string[] = [];
      for (let k = 0; k < secLines.length; k++) {
        const b = secLines[k]!;
        if (b.startsWith('+')) out.push(b.slice(1));
        else if (blank(b)) out.push('');
        else throw new Exit2(`error: parse ${base + k}`);
      }
      edits.push(v4aEdit('add', path, out, null, []));
      continue;
    }
    if (kind === 'delete') {
      if (secLines.length > 0) throw new Exit2(`error: parse ${base}`);
      edits.push(v4aEdit('delete', path, [], null, []));
      continue;
    }
    let moveTo: string | null = null;
    let k = 0;
    if ((secLines[0] ?? '').startsWith('*** Move to: ')) {
      moveTo = secLines[0]!.slice('*** Move to: '.length).trim();
      k = 1;
    }
    const chunks: Chunk[] = [];
    while (k < secLines.length) {
      const b = secLines[k]!;
      let hasAnchor = false;
      let anchor: string | null = null;
      if (b.startsWith('@@')) {
        const t = b.slice(2).trim();
        anchor = t === '' ? null : t;
        hasAnchor = true;
        k += 1;
      } else if (!(b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || blank(b))) {
        throw new Exit2(`error: parse ${base + k}`);
      }
      const parts: Part[] = [];
      let eof = false;
      while (k < secLines.length) {
        const c = secLines[k]!;
        if (c.startsWith('@@')) break;
        if (c.trim() === '*** End of File') {
          eof = true;
          k += 1;
          break;
        }
        if (c.startsWith(' ')) {
          parts.push({ kind: 'ctx', text: c.slice(1) });
          k += 1;
        } else if (c.startsWith('-')) {
          parts.push({ kind: 'old', text: c.slice(1) });
          k += 1;
        } else if (c.startsWith('+')) {
          parts.push({ kind: 'new', text: c.slice(1) });
          k += 1;
        } else if (blank(c)) {
          parts.push({ kind: 'ctx', text: '' });
          k += 1;
        } else {
          throw new Exit2(`error: parse ${base + k}`);
        }
      }
      chunks.push({ hasAnchor, anchor, parts, eof });
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${markerLine}`);
    edits.push(v4aEdit('update', path, [], moveTo, chunks));
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Sections 1, 2 and 10: the command line, output, exit codes and atomicity

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  STRICT = strict;
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? parseUnified(lines) : kind === 'search-replace' ? parseSearchReplace(lines) : parseV4A(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows = new Map<string, string>();
  const moved = new Set<string>();
  for (const [o, n] of tree.moves) {
    const oWas = tree.original(o);
    const oNow = tree.now.has(o) ? tree.now.get(o)! : oWas;
    const nWas = tree.original(n);
    const nNow = tree.now.has(n) ? tree.now.get(n)! : nWas;
    if (oWas !== null && oNow === null && nWas === null && nNow !== null) {
      rows.set(n, `R ${o} -> ${n}`);
      moved.add(o);
      moved.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  const keys = [...rows.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  if (!check) {
    for (const p of keys) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...keys.map((k) => rows.get(k)!), `ok: ${keys.length} ${keys.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
