import DOMPurify from 'dompurify';
import { Marked, Renderer } from 'marked';

const renderer = new Renderer();
renderer.code = ({ text, lang }) => {
  const safeLang = (lang || 'code').replace(/[^a-zA-Z0-9+#._-]/g, '');
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<div class="code-block-wrap"><div class="code-block-bar"><span class="code-lang">${safeLang}</span><button type="button" class="code-copy-btn" data-copy-code="1">Copy</button></div><pre><code class="language-${safeLang}">${escaped}</code></pre></div>`;
};

const askiiMarked = new Marked({
  gfm: true,
  breaks: true,
  renderer,
});

export function renderSafeMarkdown(raw: string): string {
  if (!raw) {
    return '';
  }
  try {
    const html = askiiMarked.parse(raw, { async: false }) as string;
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_TAGS: ['button'],
      ADD_ATTR: ['data-copy-code', 'type', 'class'],
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick'],
    });
  } catch {
    return DOMPurify.sanitize(`<pre>${raw}</pre>`);
  }
}
