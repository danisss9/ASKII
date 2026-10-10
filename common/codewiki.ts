import * as fs from 'fs';
import * as path from 'path';
import ignore from 'ignore';
import { embedDocuments, embedQuery, EMBEDDING_MODEL_ID } from './embedder';
import {
  rebuildVectorIndex,
  searchVectorIndex,
  hasVectorIndex,
  invalidateVectorCache,
  type VectorChunk,
  type VectorFileEntry,
  type VectorHit,
  type VectorIndexStats,
  type VectorRebuildOptions,
} from './vectordb';

// ── Code wiki: vector index over workspace code (code files only) ────────────
// No .md / .txt / .json / markup / images / binaries. Index lives in
// .askii/code-wiki/ inside the workspace; embeddings run locally via
// embeddinggemma2 (common/embedder.ts).

const INDEX_DIRNAME = path.join('.askii', 'code-wiki');
const DEFAULT_TOP_K = 3;
const MAX_FILE_BYTES = 200 * 1024; // skip files over 200 KB
const CHUNK_LINES = 60;
const CHUNK_OVERLAP = 10;
const MAX_CHUNK_CHARS = 2000;

// Code only — no .md / .txt / .json / .yml / markup / images / binaries.
const CODE_EXTENSIONS = new Set([
  // Web / JS / TS
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.astro',
  // Systems
  '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.cs', '.go', '.rs', '.swift', '.m', '.mm',
  // JVM / scripting
  '.java', '.kt', '.kts', '.scala', '.groovy', '.py', '.rb', '.php', '.pl', '.lua', '.r',
  // Shell
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1',
  // Misc languages
  '.dart', '.jl', '.ex', '.exs', '.erl', '.hs', '.clj', '.cljs', '.fs', '.fsx', '.vb',
  // Markup / styles that carry code
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  // Schema / infra
  '.sql', '.tf', '.proto', '.graphql', '.gql', '.prisma',
]);

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'out', 'build', 'target', 'bin', 'obj',
  'coverage', '__pycache__', 'venv', '.venv', '.next', '.nuxt', '.turbo',
]);

export type CodeWikiStats = VectorIndexStats;
export type CodeWikiHit = VectorHit;

// ── File discovery (exported for tests) ──────────────────────────────────────

/**
 * Recursively collect code files under rootPath. Respects the root .gitignore,
 * skips dot-directories and common build/vendor directories, and only returns
 * files with a known code extension (no .md/.txt/.json/markup/images).
 */
export function walkCodeFiles(rootPath: string): string[] {
  let ig: ReturnType<typeof ignore> | null = null;
  try {
    const gitignorePath = path.join(rootPath, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      ig = ignore();
      ig.add(fs.readFileSync(gitignorePath, 'utf-8'));
    }
  } catch {
    ig = null;
  }

  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootPath, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        // Trailing-slash test so directory-only rules like "build/" match
        if (ig && (ig.ignores(rel) || ig.ignores(`${rel}/`))) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (!CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        if (ig && ig.ignores(rel)) continue;
        try {
          const stat = fs.statSync(full);
          if (stat.size > 0 && stat.size <= MAX_FILE_BYTES) out.push(full);
        } catch {
          // skip unreadable
        }
      }
    }
  };

  walk(rootPath);
  return out.sort();
}

// ── Chunking (exported for tests) ────────────────────────────────────────────

/** Split code into overlapping line windows. */
export function splitCodeIntoChunks(content: string): Array<VectorChunk> {
  const lines = content.split('\n');
  const result: Array<VectorChunk> = [];

  let start = 0;
  while (start < lines.length) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    const text = lines.slice(start, end).join('\n').trim();
    result.push({
      heading: `lines ${start + 1}-${end}`,
      startLine: start + 1,
      endLine: end,
      text: text.substring(0, MAX_CHUNK_CHARS),
    });
    start += CHUNK_LINES - CHUNK_OVERLAP;
  }

  return result;
}

// ── Spec ─────────────────────────────────────────────────────────────────────

function indexDirPath(rootPath: string): string {
  return path.join(rootPath, INDEX_DIRNAME);
}

function codeWikiSpec(rootPath: string) {
  return {
    listFiles: (): VectorFileEntry[] =>
      walkCodeFiles(rootPath).map((fullPath) => ({
        fullPath,
        relPath: path.relative(rootPath, fullPath).replace(/\\/g, '/'),
      })),
    chunk: (relPath: string, content: string): VectorChunk[] =>
      splitCodeIntoChunks(content).map((c) => ({
        ...c,
        heading: `${relPath} (${c.heading})`,
        // The path header makes queries like "where is X defined" match file
        // names as well as code content; the stored text stays verbatim.
        embedText: chunkEmbedText(relPath, c.startLine, c.endLine, c.text),
      })),
  };
}

/** The text embedded for a chunk: the path header makes queries like
 *  "where is X defined" match file names as well as code content. */
function chunkEmbedText(relPath: string, startLine: number, endLine: number, text: string): string {
  return `${relPath} (lines ${startLine}-${endLine})\n${text}`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Cheap availability check (reads meta.json only — no vectors). */
export function hasCodeWikiIndex(rootPath: string): boolean {
  return hasVectorIndex(indexDirPath(rootPath));
}

export function invalidateCodeWikiCache(rootPath?: string): void {
  if (rootPath) invalidateVectorCache(indexDirPath(rootPath));
  else invalidateVectorCache();
}

export interface CodeWikiRebuildOptions extends VectorRebuildOptions {
  /** Reports model download progress (first use downloads ~314 MB). */
  onDownloadProgress?: (file: string, receivedMB: number, totalMB: number) => void;
}

/**
 * Rebuild (or incrementally update) the code wiki index for a workspace.
 * Unchanged files keep their vectors; the local embeddinggemma2 model runs
 * in-process (first use downloads its weights to ~/.askii/models).
 */
export async function rebuildCodeWikiIndex(
  rootPath: string,
  opts: CodeWikiRebuildOptions = {},
): Promise<CodeWikiStats> {
  return rebuildVectorIndex(
    indexDirPath(rootPath),
    EMBEDDING_MODEL_ID,
    codeWikiSpec(rootPath),
    (texts) => embedDocuments(texts, opts.onDownloadProgress),
    opts,
  );
}

/** Search the code wiki, returning raw hits sorted by cosine similarity. */
export async function searchCodeWikiRaw(
  rootPath: string,
  query: string,
  topK = DEFAULT_TOP_K,
): Promise<CodeWikiHit[]> {
  return searchVectorIndex(
    indexDirPath(rootPath),
    query,
    EMBEDDING_MODEL_ID,
    (texts) => embedQuery(texts, 'code retrieval'),
    topK,
  );
}

/**
 * Search the code wiki and return a formatted context string with the top-K
 * most relevant code chunks. Returns an empty string if nothing is found.
 */
export async function searchCodeWiki(
  rootPath: string,
  query: string,
  topK = DEFAULT_TOP_K,
): Promise<string> {
  const hits = await searchCodeWikiRaw(rootPath, query, topK);
  if (hits.length === 0) return '';
  return hits.map((h) => `[${h.heading}]\n${h.content}`).join('\n\n---\n\n');
}
