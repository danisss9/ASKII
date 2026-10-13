import { balancedArrayAt, type WorkspaceAction } from './workspace';

export type ReviewSeverity = 'error' | 'warning' | 'info';

/** One problem found by the code review model. */
export interface ReviewProblem {
  id: string;
  /** Path relative to the repository root, forward slashes. */
  file: string;
  /** 1-indexed line in the new version of the file, when the model gave one. */
  line?: number;
  severity: ReviewSeverity;
  title: string;
  description: string;
  recommendation: string;
}

const SEVERITY_ORDER: Record<ReviewSeverity, number> = { error: 0, warning: 1, info: 2 };

export function buildReviewSystemPrompt(): string {
  return [
    'You are a senior software engineer reviewing uncommitted changes before they are committed.',
    'Look for real problems introduced or touched by the diff: bugs, logic errors, unhandled edge cases,',
    'security issues, resource leaks, race conditions, performance problems, and clear maintainability issues.',
    'Do not report pure style nitpicks, formatting, or problems in code the diff does not touch.',
    '',
    'Respond with ONLY a JSON array (no prose, no markdown). Each element must be an object:',
    '{"file": "<path exactly as listed in Changed files>", "line": <1-indexed line in the NEW file, from the @@ hunk headers>,',
    ' "severity": "error" | "warning" | "info", "title": "<short summary>",',
    ' "description": "<what is wrong and why it matters>", "recommendation": "<how to fix it>"}',
    'Use "error" for bugs and security issues, "warning" for likely problems, "info" for minor improvements.',
    'If there are no problems, respond with [].',
  ].join('\n');
}

export function buildReviewUserPrompt(files: string[], diff: string): string {
  return (
    `Changed files:\n${files.length > 0 ? files.join('\n') : '(none)'}\n\n` +
    `Uncommitted changes:\n${diff || '(empty)'}\n\n` +
    'Review the changes now and respond with the JSON array.'
  );
}

/** Normalizes a model-supplied path: forward slashes, no leading "./". */
export function normalizeReviewPath(file: string): string {
  return file.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asSeverity(value: unknown): ReviewSeverity {
  const text = asText(value).toLowerCase();
  if (text === 'error' || text === 'critical' || text === 'high' || text === 'bug') {
    return 'error';
  }
  if (text === 'info' || text === 'low' || text === 'suggestion' || text === 'note') {
    return 'info';
  }
  return 'warning';
}

function asLine(value: unknown): number | undefined {
  const n = typeof value === 'string' ? parseInt(value, 10) : value;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined;
}

function toProblem(raw: unknown, index: number): ReviewProblem | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const file = normalizeReviewPath(asText(record.file ?? record.path));
  const title = asText(record.title ?? record.summary);
  const description = asText(record.description ?? record.details);
  if (!file || (!title && !description)) {
    return null;
  }
  return {
    id: `p${index + 1}`,
    file,
    line: asLine(record.line),
    severity: asSeverity(record.severity),
    title: title || description.split('\n')[0],
    description,
    recommendation: asText(record.recommendation ?? record.suggestion ?? record.fix),
  };
}

/**
 * Parses the review model's JSON array into problems sorted by severity.
 * Returns null when no JSON array could be found — distinct from []
 * ("no problems") so callers can report an unreadable response.
 */
export function parseReviewProblems(responseText: string): ReviewProblem[] | null {
  const text = responseText.trim().replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');

  // Whole response first, then the balanced [...] starting at each of the
  // first few '[' — prose around the array may itself contain brackets.
  const candidates = [text];
  for (
    let start = text.indexOf('['), tries = 0;
    start !== -1 && tries < 20;
    start = text.indexOf('[', start + 1), tries++
  ) {
    const slice = balancedArrayAt(text, start);
    if (slice) {candidates.push(slice);}
  }

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) {continue;}
    return parsed
      .map((raw, i) => toProblem(raw, i))
      .filter((p): p is ReviewProblem => p !== null)
      .sort(
        (a, b) =>
          SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
          a.file.localeCompare(b.file) ||
          (a.line ?? 0) - (b.line ?? 0),
      );
  }
  return null;
}

export function buildFixSystemPrompt(): string {
  return [
    'You fix one reported code review problem in a single file.',
    'Respond with ONLY a JSON object (no prose, no markdown):',
    '{"oldContent": "<exact contiguous snippet copied verbatim from the file>", "newContent": "<replacement for that snippet>"}',
    'oldContent must match the file character for character, including indentation, and include enough',
    'surrounding lines to be unique in the file. Keep the change minimal and do not alter unrelated code.',
    'If the problem cannot be fixed in this file, respond with {"oldContent": "", "newContent": ""}.',
  ].join('\n');
}

export function buildFixUserPrompt(
  problem: ReviewProblem,
  fileText: string,
  excerptStartLine?: number,
): string {
  const location = problem.line ? `${problem.file}:${problem.line}` : problem.file;
  const header =
    excerptStartLine !== undefined
      ? `Excerpt of ${problem.file} (starting at line ${excerptStartLine}):`
      : `Current contents of ${problem.file}:`;
  return (
    `Problem (${problem.severity}) at ${location}: ${problem.title}\n` +
    (problem.description ? `Details: ${problem.description}\n` : '') +
    (problem.recommendation ? `Recommendation: ${problem.recommendation}\n` : '') +
    `\n${header}\n${fileText}\n\nRespond with the JSON fix now.`
  );
}

/**
 * Parses the fix model's {oldContent, newContent} object into a modify action
 * for applyModifyAction. Returns null when the response has no usable fix.
 */
export function parseFixResponse(responseText: string, file: string): WorkspaceAction | null {
  const text = responseText.trim().replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const oldContent = typeof record.oldContent === 'string' ? record.oldContent : '';
  const newContent = typeof record.newContent === 'string' ? record.newContent : '';
  if (!oldContent || oldContent === newContent) {
    return null;
  }
  return { type: 'modify', path: file, oldContent, newContent };
}

/**
 * Smallest single edit turning `before` into `after`: the differing span of
 * `before` ([start, end)) and its replacement text. Lets callers apply a fix
 * as a targeted edit instead of replacing the whole document.
 */
export function minimalEdit(
  before: string,
  after: string,
): { start: number; end: number; text: string } {
  let start = 0;
  const maxStart = Math.min(before.length, after.length);
  while (start < maxStart && before[start] === after[start]) {
    start++;
  }
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  return { start, end: endBefore, text: after.slice(start, endAfter) };
}
