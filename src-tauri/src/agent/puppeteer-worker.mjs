import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

let puppeteerModule = null;
let browser = null;
let page = null;
let launchedExecutable = null;

function findChromeExecutable(explicitPath) {
  const candidates = [];
  if (explicitPath && typeof explicitPath === 'string' && explicitPath.trim()) {
    candidates.push(explicitPath.trim());
  }
  if (process.env.ASKII_CHROME_PATH) {
    candidates.push(process.env.ASKII_CHROME_PATH);
  }
  if (process.env.CHROME_PATH) {
    candidates.push(process.env.CHROME_PATH);
  }

  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';

  candidates.push(
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'),
    path.join(localAppData, 'Chromium', 'Application', 'chrome.exe'),
    path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  );

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function loadPuppeteer() {
  if (puppeteerModule) {
    return puppeteerModule;
  }

  const searchDirs = (process.env.ASKII_NODE_MODULES || '')
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const pkgName of ['puppeteer', 'puppeteer-core']) {
    for (const dir of searchDirs) {
      const pkgDir = path.join(dir, pkgName);
      if (!fs.existsSync(pkgDir)) {
        continue;
      }
      try {
        const req = createRequire(path.join(dir, '_askii_resolver.cjs'));
        const resolved = req.resolve(pkgName);
        const mod = await import(pathToFileURL(resolved).href);
        puppeteerModule = mod.default || mod;
        return puppeteerModule;
      } catch {
        // try next search dir
      }
    }
    try {
      const mod = await import(pkgName);
      puppeteerModule = mod.default || mod;
      return puppeteerModule;
    } catch {
      // try next package name
    }
  }

  throw new Error(
    'Puppeteer is not installed. Run `npm install puppeteer-core` in the ASKII workspace (or install `puppeteer` globally).',
  );
}

async function ensureBrowser(params = {}) {
  const puppeteer = await loadPuppeteer();

  if (browser && browser.connected) {
    if (!page || page.isClosed()) {
      const pages = await browser.pages();
      page = pages[0] || (await browser.newPage());
    }
    return { browser, page, reused: true };
  }

  if (params.debuggerUrl && typeof params.debuggerUrl === 'string' && params.debuggerUrl.trim()) {
    browser = await puppeteer.connect({
      browserURL: params.debuggerUrl.trim(),
      defaultViewport: null,
    });
    launchedExecutable = `remote:${params.debuggerUrl.trim()}`;
  } else {
    const executablePath = findChromeExecutable(params.executablePath);
    const headless = params.headless === true;
    const width = Number.isFinite(params.viewportWidth) ? Number(params.viewportWidth) : 1280;
    const height = Number.isFinite(params.viewportHeight) ? Number(params.viewportHeight) : 820;

    const launchOpts = {
      headless,
      defaultViewport: { width, height },
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        `--window-size=${width},${height + 88}`,
      ],
    };

    if (executablePath) {
      launchOpts.executablePath = executablePath;
      launchedExecutable = executablePath;
    } else {
      launchedExecutable = 'puppeteer-managed-chrome';
    }

    try {
      browser = await puppeteer.launch(launchOpts);
    } catch (err) {
      if (!executablePath) {
        throw new Error(
          `No Chrome/Chromium/Edge browser was found on this PC, and puppeteer could not launch a bundled binary (${err?.message || err}). Install Google Chrome or set ASKII_CHROME_PATH.`,
        );
      }
      throw err;
    }
  }

  browser.on('disconnected', () => {
    browser = null;
    page = null;
  });

  const pages = await browser.pages();
  page = pages[0] || (await browser.newPage());
  return { browser, page, reused: false };
}

function truncate(str, max = 10000) {
  if (!str) return '';
  return str.length <= max ? str : `${str.slice(0, max)}\n…[truncated]`;
}

async function collectSnapshot(targetPage, maxChars = 6000) {
  const url = targetPage.url();
  const title = await targetPage.title().catch(() => '');

  const data = await targetPage
    .evaluate((limit) => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;
        const style = window.getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
      };

      const cssHint = (el) => {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const testId = el.getAttribute('data-testid');
        if (testId) return `[data-testid="${testId.replace(/"/g, '\\"')}"]`;
        const name = el.getAttribute('name');
        if (name) return `${el.tagName.toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]`;
        const aria = el.getAttribute('aria-label');
        if (aria) return `${el.tagName.toLowerCase()}[aria-label="${aria.replace(/"/g, '\\"')}"]`;
        const placeholder = el.getAttribute('placeholder');
        if (placeholder) {
          return `${el.tagName.toLowerCase()}[placeholder="${placeholder.replace(/"/g, '\\"')}"]`;
        }
        const tag = el.tagName.toLowerCase();
        const cls = Array.from(el.classList || [])
          .filter((c) => c.length < 32 && /^[a-zA-Z0-9_-]+$/.test(c))
          .slice(0, 2)
          .map((c) => `.${c}`)
          .join('');
        return `${tag}${cls}`;
      };

      const interactiveNodes = Array.from(
        document.querySelectorAll(
          'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [contenteditable="true"]',
        ),
      ).filter(visible);

      const elements = interactiveNodes.slice(0, 50).map((el, idx) => {
        const rect = el.getBoundingClientRect();
        const label = (
          el.getAttribute('aria-label') ||
          el.getAttribute('placeholder') ||
          el.innerText ||
          el.value ||
          el.getAttribute('title') ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 80);
        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute('type') || '';
        const href = tag === 'a' ? (el.getAttribute('href') || '').slice(0, 90) : '';
        return {
          i: idx + 1,
          tag: type ? `${tag}[${type}]` : tag,
          selector: cssHint(el),
          label,
          href,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      });

      const bodyText = (document.body?.innerText || '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, limit);

      return { elements, bodyText };
    }, maxChars)
    .catch(() => ({ elements: [], bodyText: '' }));

  const lines = [
    `Title: ${title || '(untitled)'}`,
    `URL: ${url}`,
    '',
    `Interactive elements (${data.elements.length}):`,
    ...data.elements.map((el) => {
      const extra = el.href ? ` -> ${el.href}` : '';
      return `${el.i}. <${el.tag}> "${el.label}" selector=\`${el.selector}\` @(${el.x},${el.y})${extra}`;
    }),
    '',
    'Visible text:',
    truncate(data.bodyText, maxChars),
  ];
  return lines.join('\n');
}

async function handleAction(action, params = {}) {
  switch (action) {
    case 'launch': {
      const { reused } = await ensureBrowser(params);
      if (params.url && typeof params.url === 'string' && params.url.trim()) {
        const target = normalizeUrl(params.url);
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 25000 });
        const snap = await collectSnapshot(page, 3500);
        return {
          output: `${reused ? 'Reused' : 'Launched'} browser (${launchedExecutable}) and navigated to ${page.url()}.\n\n${snap}`,
        };
      }
      return {
        output: `${reused ? 'Reused active' : 'Launched'} Chrome browser via Puppeteer (${launchedExecutable}). Current URL: ${page.url()}`,
      };
    }

    case 'navigate': {
      if (!params.url || typeof params.url !== 'string') {
        throw new Error('Missing `url` parameter.');
      }
      await ensureBrowser(params);
      const target = normalizeUrl(params.url);
      const waitUntil = params.waitUntil || 'domcontentloaded';
      const resp = await page.goto(target, { waitUntil, timeout: 30000 });
      const status = resp ? resp.status() : 'n/a';
      const snap = await collectSnapshot(page, 4000);
      return {
        output: `Navigated (HTTP ${status}) to ${page.url()}\n\n${snap}`,
      };
    }

    case 'click': {
      await ensureBrowser();
      const button = params.button || 'left';
      const clickCount = Math.max(1, Math.min(3, Number(params.clickCount || 1)));

      if (params.selector && typeof params.selector === 'string' && params.selector.trim()) {
        const sel = params.selector.trim();
        await page.waitForSelector(sel, { visible: true, timeout: 8000 });
        await page.click(sel, { button, clickCount });
        await delay(300);
        return {
          output: `Clicked selector \`${sel}\` (${button} ×${clickCount}). Current URL: ${page.url()}`,
        };
      }

      if (params.text && typeof params.text === 'string' && params.text.trim()) {
        const needle = params.text.trim().toLowerCase();
        const coords = await page.evaluate((textNeedle) => {
          const candidates = Array.from(
            document.querySelectorAll(
              'a, button, input[type="submit"], input[type="button"], [role="button"], [role="link"], label, span, div',
            ),
          );
          let best = null;
          for (const el of candidates) {
            const rect = el.getBoundingClientRect();
            if (rect.width < 2 || rect.height < 2) continue;
            const style = window.getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none') continue;
            const txt = (
              el.innerText ||
              el.getAttribute('aria-label') ||
              el.value ||
              ''
            )
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase();
            if (!txt) continue;
            if (txt === textNeedle) {
              best = {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
              };
              break;
            }
            if (!best && txt.includes(textNeedle)) {
              best = {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
              };
            }
          }
          return best;
        }, needle);

        if (!coords) {
          throw new Error(`No visible element matching text "${params.text}" was found.`);
        }
        await page.mouse.click(coords.x, coords.y, { button, clickCount });
        await delay(300);
        return {
          output: `Clicked element matching "${params.text}" at (${coords.x}, ${coords.y}). Current URL: ${page.url()}`,
        };
      }

      if (Number.isFinite(params.x) && Number.isFinite(params.y)) {
        const x = Number(params.x);
        const y = Number(params.y);
        await page.mouse.click(x, y, { button, clickCount });
        await delay(300);
        return {
          output: `Clicked browser coordinates (${x}, ${y}) (${button} ×${clickCount}). Current URL: ${page.url()}`,
        };
      }

      throw new Error('Provide `selector`, `text`, or both `x` and `y` coordinates to click.');
    }

    case 'type': {
      await ensureBrowser();
      const text = typeof params.text === 'string' ? params.text : '';
      const clear = params.clear === true;
      const pressEnter = params.pressEnter === true;

      if (params.selector && typeof params.selector === 'string' && params.selector.trim()) {
        const sel = params.selector.trim();
        await page.waitForSelector(sel, { visible: true, timeout: 8000 });
        await page.click(sel);
      }

      if (clear) {
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
      }

      if (text.length > 0) {
        await page.keyboard.type(text, { delay: 12 });
      }
      if (pressEnter) {
        await page.keyboard.press('Enter');
        await delay(350);
      }
      return {
        output: `Typed ${text.length} chars${params.selector ? ` into \`${params.selector}\`` : ''}${pressEnter ? ' and pressed Enter' : ''}. Current URL: ${page.url()}`,
      };
    }

    case 'press_key': {
      await ensureBrowser();
      const rawKey = typeof params.key === 'string' ? params.key.trim() : '';
      if (!rawKey) {
        throw new Error('Missing `key` parameter.');
      }
      const parts = rawKey
        .split('+')
        .map((p) => p.trim())
        .filter(Boolean);
      const modifiers = parts.slice(0, -1).map(normalizePuppeteerKey);
      const mainKey = normalizePuppeteerKey(parts[parts.length - 1]);

      for (const mod of modifiers) {
        await page.keyboard.down(mod);
      }
      await page.keyboard.press(mainKey);
      for (const mod of modifiers.reverse()) {
        await page.keyboard.up(mod);
      }
      await delay(200);
      return {
        output: `Pressed \`${rawKey}\` in browser. Current URL: ${page.url()}`,
      };
    }

    case 'scroll': {
      await ensureBrowser();
      if (params.selector && typeof params.selector === 'string' && params.selector.trim()) {
        await page.$eval(params.selector.trim(), (el) => {
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
        });
        return { output: `Scrolled \`${params.selector}\` into view.` };
      }
      const deltaY = Number.isFinite(params.deltaY) ? Number(params.deltaY) : 500;
      const deltaX = Number.isFinite(params.deltaX) ? Number(params.deltaX) : 0;
      await page.mouse.wheel({ deltaX, deltaY });
      await delay(180);
      return { output: `Scrolled browser page by (${deltaX}, ${deltaY}).` };
    }

    case 'snapshot': {
      await ensureBrowser();
      const maxChars = Number.isFinite(params.maxChars)
        ? Math.max(500, Math.min(16000, Number(params.maxChars)))
        : 6000;
      const snap = await collectSnapshot(page, maxChars);
      return { output: snap };
    }

    case 'screenshot': {
      await ensureBrowser();
      const fullPage = params.fullPage === true;
      const b64 = await page.screenshot({
        encoding: 'base64',
        type: 'png',
        fullPage,
      });
      const vp = page.viewport() || { width: 1280, height: 820 };
      const title = await page.title().catch(() => '');
      return {
        output: `Captured browser screenshot (${vp.width}×${vp.height}${fullPage ? ', fullPage' : ''}) of "${title}" (${page.url()}).`,
        imageBase64: b64,
        mimeType: 'image/png',
      };
    }

    case 'evaluate': {
      await ensureBrowser();
      const script = typeof params.script === 'string' ? params.script.trim() : '';
      if (!script) {
        throw new Error('Missing `script` parameter.');
      }
      const res = await page.evaluate((code) => {
        const fn = new Function(`return (${code});`);
        try {
          const val = fn();
          return typeof val === 'function' ? val() : val;
        } catch {
          const stmtFn = new Function(code);
          return stmtFn();
        }
      }, script);
      const serialized =
        typeof res === 'string' ? res : JSON.stringify(res ?? null, null, 2);
      return { output: truncate(serialized, 10000) };
    }

    case 'tabs': {
      await ensureBrowser();
      const op = (params.action || 'list').toLowerCase();
      const pages = await browser.pages();

      if (op === 'new') {
        page = await browser.newPage();
        if (params.url && typeof params.url === 'string' && params.url.trim()) {
          await page.goto(normalizeUrl(params.url), {
            waitUntil: 'domcontentloaded',
            timeout: 25000,
          });
        }
        return { output: `Opened new tab. Active URL: ${page.url()}` };
      }

      if (op === 'switch') {
        const idx = Number(params.index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= pages.length) {
          throw new Error(`Invalid tab index ${params.index}. Open tabs: ${pages.length}`);
        }
        page = pages[idx];
        await page.bringToFront();
        return {
          output: `Switched to tab [${idx}]: ${await page.title().catch(() => '')} (${page.url()})`,
        };
      }

      if (op === 'close') {
        const idx = Number.isInteger(params.index)
          ? Number(params.index)
          : pages.indexOf(page);
        if (idx < 0 || idx >= pages.length) {
          throw new Error(`Invalid tab index ${params.index}.`);
        }
        await pages[idx].close();
        const remaining = await browser.pages();
        page = remaining[0] || null;
        return { output: `Closed tab [${idx}]. Remaining tabs: ${remaining.length}` };
      }

      const list = [];
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        const t = await p.title().catch(() => '');
        const mark = p === page ? ' [active]' : '';
        list.push(`[${i}]${mark} ${t || '(untitled)'} — ${p.url()}`);
      }
      return { output: list.join('\n') || '(no open tabs)' };
    }

    case 'wait': {
      await ensureBrowser();
      if (params.selector && typeof params.selector === 'string' && params.selector.trim()) {
        const timeout = Math.max(500, Math.min(25000, Number(params.timeoutMs || 8000)));
        await page.waitForSelector(params.selector.trim(), { visible: true, timeout });
        return { output: `Selector \`${params.selector}\` is now visible.` };
      }
      const ms = Math.max(100, Math.min(10000, Number(params.ms || 1000)));
      await delay(ms);
      return { output: `Waited ${ms}ms.` };
    }

    case 'close': {
      if (browser) {
        await browser.close().catch(() => {});
        browser = null;
        page = null;
        return { output: 'Closed Puppeteer Chrome browser session.' };
      }
      return { output: 'No active browser session to close.' };
    }

    default:
      throw new Error(`Unknown browser worker action "${action}".`);
  }
}

function normalizeUrl(raw) {
  const trimmed = raw.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function normalizePuppeteerKey(k) {
  const map = {
    ctrl: 'Control',
    control: 'Control',
    cmd: 'Meta',
    meta: 'Meta',
    win: 'Meta',
    alt: 'Alt',
    shift: 'Shift',
    enter: 'Enter',
    return: 'Enter',
    esc: 'Escape',
    escape: 'Escape',
    tab: 'Tab',
    space: 'Space',
    backspace: 'Backspace',
    delete: 'Delete',
    del: 'Delete',
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pagedown: 'PageDown',
  };
  return map[k.toLowerCase()] || k;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let requestQueue = Promise.resolve();

rl.on('line', (line) => {
  requestQueue = requestQueue.then(async () => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req;
    try {
      req = JSON.parse(trimmed);
    } catch (err) {
      process.stdout.write(
        JSON.stringify({ id: 0, ok: false, error: `Invalid JSON request: ${err.message}` }) + '\n',
      );
      return;
    }

    const id = req.id ?? 0;
    try {
      const result = await handleAction(req.action, req.params || {});
      process.stdout.write(JSON.stringify({ id, ok: true, ...result }) + '\n');
    } catch (err) {
      process.stdout.write(
        JSON.stringify({
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }) + '\n',
      );
    }
  });
});

rl.on('close', () => {
  requestQueue.finally(async () => {
    if (browser) {
      await browser.close().catch(() => {});
    }
    process.exit(0);
  });
});
