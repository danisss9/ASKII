import * as fs from 'fs';
import * as path from 'path';

// ── Clickable file citations in Ask answers ──────────────────────────────────
// The model cites locations as plain `path/to/file.ext:LINE` references; this
// module rewrites resolved ones into `askii-open://` markdown links that the
// ask panel renders as "click to open at that exact spot". Pure Node — shared
// by the extension and the CLI.

export const ASKII_OPEN_SCHEME = 'askii-open';

/** Appended to ask system prompts so the model writes linkable citations. */
export const FILE_CITATION_INSTRUCTIONS =
  'When your answer points at a specific file or code location, cite it as a plain ' +
  'path:line reference (e.g. src/app.ts:42, README.md:12 or docs/guide.md:10) directly ' +
  'in the text — never inside backticks or code blocks — so the editor can turn it into ' +
  'a clickable link that opens that exact spot. Use paths relative to the workspace root ' +
  'for code, and relative to the docs folder for wiki documentation.';

// `path/to/file.ext:LINE` with an optional `-ENDLINE` range. The boundaries
// keep URLs, markdown link targets and dotted versions (1.2.3) out; candidates
// are validated on disk by the caller's resolver before anything is linked.
const FILE_REF_PATTERN =
  /(^|\s)([\w@.\\/-]+?\.[A-Za-z][A-Za-z0-9]{0,7}):(\d{1,5})(?:-(\d{1,5}))?(?=$|[\s)\]},.;:!?'"<>])/g;

export interface AutoLinkOptions {
  /** Returns the absolute path for a candidate reference, or null to skip it. */
  resolve?: (candidate: string) => string | null;
}

/** Rewrite `file.ext:LINE` references into askii-open:// markdown links. */
export function autoLinkFileReferences(markdown: string, opts: AutoLinkOptions = {}): string {
  const resolve = opts.resolve;
  if (!markdown || !resolve) {return markdown;}

  const lines = markdown.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s{0,3}(?:```|~~~)/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {continue;}
    // Even indices are prose; odd ones are `inline code` spans — left alone
    const parts = lines[i].split(/(`[^`]*`)/g);
    for (let p = 0; p < parts.length; p += 2) {
      parts[p] = parts[p].replace(FILE_REF_PATTERN, (whole, lead, refPath, lineStr, endStr) => {
        const abs = resolve(refPath);
        if (!abs) {return whole;}
        const label = `${refPath}:${lineStr}${endStr ? `-${endStr}` : ''}`;
        const href = buildLocationHref(abs, Number(lineStr), endStr ? Number(endStr) : undefined);
        return `${lead}[${label}](${href})`;
      });
    }
    lines[i] = parts.join('');
  }
  return lines.join('\n');
}

export interface FileLocation {
  path: string;
  line?: number;
  endLine?: number;
}

/** Build the href the ask panel uses to open a file at a line range. */
export function buildLocationHref(absPath: string, line?: number, endLine?: number): string {
  const params = new URLSearchParams();
  params.set('path', absPath);
  if (line !== undefined) {params.set('line', String(line));}
  if (endLine !== undefined) {params.set('endLine', String(endLine));}
  // Markdown destinations end at the first unescaped ")" — percent-encode the
  // parens URLSearchParams leaves bare so paths like "a(1).ts" survive
  return `${ASKII_OPEN_SCHEME}://open?${params
    .toString()
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')}`;
}

/** Parse an askii-open:// href back into a file location (null if foreign). */
export function parseLocationHref(href: string): FileLocation | null {
  const qIdx = href.indexOf('?');
  if (!href.startsWith(`${ASKII_OPEN_SCHEME}://`) || qIdx < 0) {return null;}
  const params = new URLSearchParams(href.slice(qIdx + 1));
  const file = params.get('path');
  if (!file) {return null;}
  const line = Number(params.get('line'));
  const endLine = Number(params.get('endLine'));
  return {
    path: file,
    line: line >= 1 ? Math.floor(line) : undefined,
    endLine: endLine >= 1 ? Math.floor(endLine) : undefined,
  };
}

/**
 * Resolver for citation candidates: accepts absolute paths, workspace-relative
 * paths and docs-wiki-relative paths (backslashes normalized), validating each
 * against the disk. Results are memoized so streaming re-renders stay cheap.
 */
export function makePathResolver(
  bases: Array<string | undefined>,
): (candidate: string) => string | null {
  const cache = new Map<string, string | null>();
  return (candidate: string): string | null => {
    if (cache.has(candidate)) {return cache.get(candidate) ?? null;}
    let resolved: string | null = null;
    const normalized = candidate.replace(/\\/g, '/');
    if (path.isAbsolute(normalized)) {
      if (fs.existsSync(normalized)) {resolved = normalized;}
    } else {
      for (const base of bases) {
        if (!base) {continue;}
        const full = path.resolve(base, normalized);
        if (fs.existsSync(full)) {
          resolved = full;
          break;
        }
      }
    }
    cache.set(candidate, resolved);
    return resolved;
  };
}
