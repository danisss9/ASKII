import MiniSearch from 'minisearch';
import * as fs from 'fs';
import * as path from 'path';

const INDEX_FILENAME = '.askii-wiki-index.json';
const DEFAULT_TOP_K = 3;
const MAX_CHUNK_CHARS = 1500;

// ── Document shape stored in MiniSearch ──────────────────────────────────────

interface WikiDoc {
  id: string;
  source: string;   // relative path to .md file
  heading: string;  // section heading
  content: string;  // chunk text (capped at MAX_CHUNK_CHARS)
}

// ── Persisted index shape ─────────────────────────────────────────────────────

export interface WikiIndexData {
  search: string;    // JSON produced by MiniSearch's toJSON()
  builtAt: string;
  fileCount: number;
  chunkCount: number;
}

// ── In-memory caches (persist for the lifetime of the process) ────────────────

// Raw WikiIndexData cached per wikiPath to avoid repeated disk reads
const _dataCache = new Map<string, WikiIndexData>();

// Deserialized MiniSearch instance cached by builtAt timestamp to avoid
// repeated MiniSearch.loadJSON calls on every search
let _msCache: { builtAt: string; ms: MiniSearch<WikiDoc> } | null = null;

// ── MiniSearch configuration (must be identical for build and load) ───────────

const MS_OPTIONS: ConstructorParameters<typeof MiniSearch<WikiDoc>>[0] = {
  fields: ['heading', 'content'],
  storeFields: ['source', 'heading', 'content'],
  searchOptions: {
    boost: { heading: 2 },
    fuzzy: 0.2,
    prefix: true,
  },
};

// ── Internal helpers ──────────────────────────────────────────────────────────

function walkMdFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      files.push(...walkMdFiles(path.join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

function splitIntoChunks(
  relPath: string,
  content: string,
): Array<{ heading: string; content: string }> {
  const result: Array<{ heading: string; content: string }> = [];
  const fileBase = path.basename(relPath, '.md');
  const lines = content.split('\n');

  let currentHeading = fileBase;
  let currentLines: string[] = [];

  const flush = () => {
    const text = currentLines.join('\n').trim();
    if (text.length > 40) {
      result.push({ heading: currentHeading, content: text.substring(0, MAX_CHUNK_CHARS) });
    }
  };

  for (const line of lines) {
    if (/^#{1,3}\s/.test(line)) {
      flush();
      currentHeading = line.replace(/^#+\s+/, '').trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  flush();

  if (result.length === 0 && content.trim().length > 40) {
    result.push({ heading: fileBase, content: content.trim().substring(0, MAX_CHUNK_CHARS) });
  }

  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a MiniSearch wiki index from all .md files under wikiPath.
 * Returns the index data ready to be saved.
 */
export function buildWikiIndex(wikiPath: string): WikiIndexData {
  const mdFiles = walkMdFiles(wikiPath);
  const ms = new MiniSearch<WikiDoc>(MS_OPTIONS);
  const docs: WikiDoc[] = [];

  for (const filePath of mdFiles) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const relPath = path.relative(wikiPath, filePath).replace(/\\/g, '/');
    const chunks = splitIntoChunks(relPath, content);
    chunks.forEach((chunk, idx) => {
      docs.push({
        id: `${relPath}::${idx}`,
        source: relPath,
        heading: chunk.heading,
        content: chunk.content,
      });
    });
  }

  ms.addAll(docs);

  return {
    search: JSON.stringify(ms),
    builtAt: new Date().toISOString(),
    fileCount: new Set(docs.map(d => d.source)).size,
    chunkCount: docs.length,
  };
}

/**
 * Save the wiki index data as JSON inside wikiPath and warm the in-memory caches.
 */
export function saveWikiIndex(data: WikiIndexData, wikiPath: string): void {
  const indexPath = path.join(wikiPath, INDEX_FILENAME);
  fs.writeFileSync(indexPath, JSON.stringify(data), 'utf-8');
  // Warm caches so the next search doesn't need a disk read or deserialization
  _dataCache.set(wikiPath, data);
  _msCache = { builtAt: data.builtAt, ms: MiniSearch.loadJSON<WikiDoc>(data.search, MS_OPTIONS) };
}

/**
 * Load a previously-saved wiki index.
 * Returns the cached copy if the path was already loaded this session.
 */
export function loadWikiIndex(wikiPath: string): WikiIndexData | null {
  if (_dataCache.has(wikiPath)) return _dataCache.get(wikiPath)!;
  const indexPath = path.join(wikiPath, INDEX_FILENAME);
  if (!fs.existsSync(indexPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as WikiIndexData;
    _dataCache.set(wikiPath, data);
    return data;
  } catch {
    return null;
  }
}

/** Returns the cached MiniSearch instance, deserializing from data only when stale. */
function getMs(data: WikiIndexData): MiniSearch<WikiDoc> {
  if (_msCache?.builtAt === data.builtAt) return _msCache.ms;
  const ms = MiniSearch.loadJSON<WikiDoc>(data.search, MS_OPTIONS);
  _msCache = { builtAt: data.builtAt, ms };
  return ms;
}

/**
 * Search the wiki index and return a formatted context string
 * with the top-K most relevant chunks. Returns empty string if nothing found.
 */
export function searchWiki(query: string, data: WikiIndexData, topK = DEFAULT_TOP_K): string {
  if (!query.trim()) return '';

  let ms: MiniSearch<WikiDoc>;
  try {
    ms = getMs(data);
  } catch {
    return '';
  }

  const results = ms.search(query).slice(0, topK) as (ReturnType<typeof ms.search>[number] & WikiDoc)[];
  if (results.length === 0) return '';

  return results
    .map(r => `[${r.source} — ${r.heading}]\n${r.content}`)
    .join('\n\n---\n\n');
}

/**
 * Search the wiki and return raw result objects (for inline decorations).
 */
export function searchWikiRaw(
  query: string,
  data: WikiIndexData,
  topK = 1,
): Array<{ source: string; heading: string; content: string; score: number }> {
  if (!query.trim()) return [];

  let ms: MiniSearch<WikiDoc>;
  try {
    ms = getMs(data);
  } catch {
    return [];
  }

  return (ms.search(query).slice(0, topK) as (ReturnType<typeof ms.search>[number] & WikiDoc)[])
    .map(r => ({ source: r.source, heading: r.heading, content: r.content, score: r.score }));
}
