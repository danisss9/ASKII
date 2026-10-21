export type CommitMessageStyle = 'oneliner' | 'brief' | 'descriptive';

export const BASE_SYSTEM_PROMPT = `You are an expert at writing Git commit messages.
Given a list of changed files and a unified diff, write a single, well-formed Git commit message.
Rules:
- Use the Conventional Commits format when appropriate (type(scope): subject).
- The first line is the subject: imperative mood, <= 72 characters, no trailing period.
- Optionally follow with a blank line and a concise body explaining the "why" (not the "what").
- Output ONLY the raw commit message text — no markdown fences, no quotes, no "Commit message:" label, no preamble.
- If the diff is empty or trivial, output a single short subject line describing the change.`;

const STYLE_LABELS: Record<CommitMessageStyle, string> = {
  oneliner: 'OneLiner',
  brief: 'Brief',
  descriptive: 'Descriptive',
};

export function getCommitMessageStyle(value?: string): CommitMessageStyle {
  const normalized = (value ?? '').trim().toLowerCase();

  switch (normalized) {
    case 'oneliner':
      return 'oneliner';
    case 'descriptive':
      return 'descriptive';
    default:
      return 'brief';
  }
}

export function buildCommitMessageSystemPrompt(
  style: CommitMessageStyle,
  instructions: string,
): string {
  const styleInstructions = getStyleInstructions(style);
  const prompt = `${BASE_SYSTEM_PROMPT}\n\nPreferred commit message style: ${STYLE_LABELS[style]}\n${styleInstructions}`;

  return instructions
    ? `${prompt}\n\nAdditional instructions from the user:\n${instructions}`
    : prompt;
}

function getStyleInstructions(style: CommitMessageStyle): string {
  switch (style) {
    case 'oneliner':
      return [
        '- Write a single-line subject only.',
        '- Keep it very concise and high-signal.',
        '- Aim for <= 72 characters and avoid a body.',
      ].join('\n');
    case 'descriptive':
      return [
        '- Write a clear subject and add a short explanatory body when it adds context.',
        '- Include enough detail to explain the intent of the change.',
        '- Prefer readability over extreme brevity.',
      ].join('\n');
    case 'brief':
    default:
      return [
        '- Write a concise subject line with an optional short body when useful.',
        '- Keep the message focused and easy to scan.',
        '- Avoid unnecessary detail.',
      ].join('\n');
  }
}

// ── Prompt pieces shared by the extension (src/commitMessage.ts) and the CLI ──

/** The diff sent to the model is capped so a huge changeset can't blow up the context. */
export const MAX_COMMIT_DIFF_CHARS = 12_000;

/** How many of the repository's recent commit messages are sent as style examples. */
export const MAX_RECENT_COMMITS = 10;

// Cap each example message so huge commit bodies don't dominate the prompt.
const MAX_EXAMPLE_MESSAGE_CHARS = 500;

export function truncateDiff(raw: string): string {
  return raw.length > MAX_COMMIT_DIFF_CHARS
    ? `${raw.slice(0, MAX_COMMIT_DIFF_CHARS)}\n…[diff truncated]`
    : raw;
}

/**
 * Formats recent commit messages as numbered style examples: each is capped
 * and its wrapped lines indented under its bullet. Returns '' for none, so
 * the prompt simply omits the section.
 */
export function formatCommitExamples(messages: string[]): string {
  const formatted = messages
    .map((m) => m.replace(/\r\n/g, '\n').trim())
    .filter(Boolean)
    .map((m) =>
      (m.length > MAX_EXAMPLE_MESSAGE_CHARS ? `${m.slice(0, MAX_EXAMPLE_MESSAGE_CHARS)}…` : m).replace(
        /\n/g,
        '\n   ',
      ),
    );
  if (formatted.length === 0) {
    return '';
  }
  return (
    'Recent commit messages (style examples from this repository):\n' +
    formatted.map((m, i) => `${i + 1}. ${m}`).join('\n')
  );
}

export function buildCommitUserPrompt(input: {
  files: string[];
  diff: string;
  staged: boolean;
  examples: string;
}): string {
  const scope = input.staged ? 'staged' : 'working-tree';
  const fileSummary = input.files.length > 0 ? input.files.join('\n') : '(no file list available)';
  return (
    `Changed files (${scope}):\n${fileSummary}\n\n` +
    `Unified diff (${scope}):\n${truncateDiff(input.diff) || '(empty)'}\n\n` +
    (input.examples ? `${input.examples}\n\n` : '') +
    (input.examples
      ? 'Write the commit message now, matching the style of the example messages above.'
      : 'Write the commit message now.')
  );
}

/**
 * Cleans model output into a bare commit message: strips markdown fences,
 * a leading "Commit message:" label and surrounding quotes.
 */
export function cleanCommitMessage(raw: string): string {
  let text = raw.trim();
  const fenceMatch = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }
  text = text.replace(/^(commit\s*message|message)\s*[:-]\s*/i, '');
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text.trim();
}
