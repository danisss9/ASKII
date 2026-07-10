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
