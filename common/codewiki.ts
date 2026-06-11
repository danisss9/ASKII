import MiniSearch from 'minisearch';
import * as fs from 'fs';
import * as path from 'path';
import { type WikiIndexData } from './wiki';

const INDEX_FILENAME = '.askii-code-wiki-index.json';
const DEFAULT_TOP_K = 3;
const MAX_CHUNK_CHARS = 2000;
const CHUNK_LINES = 60;
const CHUNK_OVERLAP = 10;
const MAX_FILE_BYTES = 200 * 1024; // 200 KB

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.cs', '.java', '.go', '.rs',
  '.c', '.cpp', '.h', '.hpp',
  '.html', '.css', '.scss',
  '.json', '.md', '.yml', '.yaml',
  '.sql', '.sh', '.ps1',
]);

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'out', 'build', 'target',
  'bin', 'obj', 'coverage', '__pycache__', 'venv', '.askii',
]);

// ── Document shape stored in MiniSearch ──────────────────────────────────────

interface CodeDoc {
  id: string;
  source: string;   // relative path to code file
  heading: string;  // "relPath (lines X–Y)"
  content: string;  // chunk text (capped at MAX_CHUNK_CHARS)
}

// ── In-memory caches (own instances, separate from wiki.ts) ──────────────────

const _dataCache = new Map<string, WikiIndexData>();
let _msCache: { builtAt: string; ms: MiniSearch<CodeDoc> } | null = null;

// ── MiniSearch configuration ──────────────────────────────────────────────────

const MS_OPTIONS: ConstructorParameters<typeof MiniSearch<CodeDoc>>[0] = {
  fields: ['content', 'source'],
  storeFields: ['source', 'heading', 'content'],
  searchOptions: {
    boost: { source: 2 },
    prefix: true,
    // No fuzzy — identifiers should match exactly
  },
};

// ── Internal helpers ──────────────────────────────────────────────────────────

function walkCodeFiles(dir: string): string[] {
  const files: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
        files.push(...walkCodeFiles(path.join(dir, entry.name)));
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!CODE_EXTENSIONS.has(ext)) continue;
      // Skip the index files themselves
      if (entry.name === INDEX_FILENAME || entry.name === '.askii-wiki-index.json') continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size <= MAX_FILE_BYTES) {
          files.push(fullPath);
        }
      } catch {
        // skip unreadable
      }
    }
  }
  return files;
}

function splitCodeIntoChunks(
  relPath: string,
  content: string,
): Array<{ heading: string; content: string }> {
  const lines = content.split('\n');
  const result: Array<{ heading: string; content: string }> = [];

  let start = 0;
  while (start < lines.length) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    const chunkLines = lines.slice(start, end);
    const text = chunkLines.join('\n').trim();
    // Skip chunks with very little non-whitespace content
    if (text.replace(/\s/g, '').length > 40) {
      result.push({
        heading: `${relPath} (lines ${start + 1}–${end})`,
        content: text.substring(0, MAX_CHUNK_CHARS),
      });
    }
    // Advance with overlap so adjacent chunks share context
    start += CHUNK_LINES - CHUNK_OVERLAP;
  }

  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a MiniSearch code wiki index from all code files under rootPath.
 * Returns the index data ready to be saved.
 */
export function buildCodeWikiIndex(rootPath: string): WikiIndexData {
  const codeFiles = walkCodeFiles(rootPath);
  const ms = new MiniSearch<CodeDoc>(MS_OPTIONS);
  const docs: CodeDoc[] = [];

  for (const filePath of codeFiles) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const relPath = path.relative(rootPath, filePath).replace(/\\/g, '/');
    const chunks = splitCodeIntoChunks(relPath, content);
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
 * Save the code wiki index as JSON inside rootPath and warm the in-memory caches.
 */
export function saveCodeWikiIndex(data: WikiIndexData, rootPath: string): void {
  const indexPath = path.join(rootPath, INDEX_FILENAME);
  fs.writeFileSync(indexPath, JSON.stringify(data), 'utf-8');
  _dataCache.set(rootPath, data);
  _msCache = { builtAt: data.builtAt, ms: MiniSearch.loadJSON<CodeDoc>(data.search, MS_OPTIONS) };
}

/**
 * Load a previously-saved code wiki index.
 * Returns the cached copy if the path was already loaded this session.
 */
export function loadCodeWikiIndex(rootPath: string): WikiIndexData | null {
  if (_dataCache.has(rootPath)) return _dataCache.get(rootPath)!;
  const indexPath = path.join(rootPath, INDEX_FILENAME);
  if (!fs.existsSync(indexPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as WikiIndexData;
    _dataCache.set(rootPath, data);
    return data;
  } catch {
    return null;
  }
}

function getMs(data: WikiIndexData): MiniSearch<CodeDoc> {
  if (_msCache?.builtAt === data.builtAt) return _msCache.ms;
  const ms = MiniSearch.loadJSON<CodeDoc>(data.search, MS_OPTIONS);
  _msCache = { builtAt: data.builtAt, ms };
  return ms;
}

/**
 * Search the code wiki index and return a formatted context string
 * with the top-K most relevant chunks. Returns empty string if nothing found.
 */
export function searchCodeWiki(query: string, data: WikiIndexData, topK = DEFAULT_TOP_K): string {
  if (!query.trim()) return '';

  let ms: MiniSearch<CodeDoc>;
  try {
    ms = getMs(data);
  } catch {
    return '';
  }

  const results = ms.search(query).slice(0, topK) as (ReturnType<typeof ms.search>[number] & CodeDoc)[];
  if (results.length === 0) return '';

  return results
    .map(r => `[${r.source} — ${r.heading}]\n${r.content}`)
    .join('\n\n---\n\n');
}
