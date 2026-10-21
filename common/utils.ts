export function escapeHtml(text: string): string {
  const map: { [key: string]: string } = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (c) => map[c]);
}

/**
 * Action strings arrive already decoded by JSON.parse. Some models escape them
 * twice, which shows up as content with no real newline but literal "\n"
 * sequences *between statements*. Only then is a second JSON-string decode
 * applied. Anything else is returned untouched — including real multi-line
 * code with "\n" in string literals, and single-line files (minified JS,
 * JSON) whose "\n" only appear inside string literals.
 */
export function decodeIfDoubleEscaped(str: string): string {
  if (str.includes('\n') || !str.includes('\\n')) {return str;}
  // Every double quote escaped (\") and none bare: the whole text was escaped
  const allQuotesEscaped = /\\"/.test(str) && !/(?<!\\)"/.test(str);
  if (!allQuotesEscaped) {
    // A literal \n left after removing string literals separates lines of code
    const outsideStrings = str.replace(
      /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
      '""',
    );
    if (!outsideStrings.includes('\\n')) {return str;}
  }
  try {
    // Escape bare quotes and raw tabs/CRs so the text forms one valid JSON string
    const quoted = str.replace(/(?<!\\)"/g, '\\"').replace(/\t/g, '\\t').replace(/\r/g, '\\r');
    return JSON.parse(`"${quoted}"`) as string;
  } catch {
    return str;
  }
}

export function extractCode(response: string): string {
  let code = response.trim();
  if (code.startsWith('```')) {
    code = code
      .replace(/^```[^\n]*\n?/, '')
      .replace(/\n?```$/, '')
      .trim();
  }
  return code;
}

/**
 * Returns the balanced JSON array or object starting at text[start] (which
 * must be '[' or '{'), skipping brackets inside strings — or null if it never
 * closes or the brackets are mismatched (e.g. output cut off mid-value).
 */
export function balancedJsonAt(text: string, start: number): string | null {
  const open = text[start];
  if (open !== '[' && open !== '{') {
    return null;
  }
  const closers: string[] = [];
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') {
        i++;
      } else if (c === '"') {
        inString = false;
      }
    } else if (c === '"') {
      inString = true;
    } else if (c === '[' || c === '{') {
      closers.push(c === '[' ? ']' : '}');
    } else if (c === ']' || c === '}') {
      if (closers.pop() !== c) {
        return null;
      }
      if (closers.length === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** Strips a surrounding ``` / ```json fence from a model response. */
export function stripCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```[^\n]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
}

/**
 * Parses the first JSON value in a model response that `accept` approves:
 * the whole (unfenced) response first, then the balanced [...] / {...} that
 * starts at each of the first few openers — prose around the JSON may itself
 * contain brackets. Returns undefined when nothing acceptable parses.
 */
export function parseJsonFromModel(
  responseText: string,
  accept: (value: unknown) => boolean = () => true,
  openers = '[{',
): unknown {
  const text = stripCodeFence(responseText);
  const candidates = [text];
  let tries = 0;
  for (let i = 0; i < text.length && tries < 40; i++) {
    if (openers.includes(text[i])) {
      tries++;
      const slice = balancedJsonAt(text, i);
      if (slice) {
        candidates.push(slice);
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (accept(value)) {
        return value;
      }
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}
