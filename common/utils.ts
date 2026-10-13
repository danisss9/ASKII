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
 * sequences — only then is a second JSON-string decode applied. Anything else
 * (including code that legitimately contains "\n" in a string literal) is
 * returned untouched.
 */
export function decodeIfDoubleEscaped(str: string): string {
  if (str.includes('\n') || !str.includes('\\n')) {return str;}
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
