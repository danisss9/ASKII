import * as fs from 'fs';
import * as path from 'path';
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

// ── Docs wiki: vector index over .md documentation files ─────────────────────
// Chunked by markdown headings; embeddings run locally via embeddinggemma2
// (common/embedder.ts). The index lives in <wikiPath>/.askii-wiki-index/.

const INDEX_DIRNAME = '.askii-wiki-index';
const LEGACY_INDEX_FILENAME = '.askii-wiki-index.json'; // old MiniSearch index
const DEFAULT_TOP_K = 3;
const MAX_CHUNK_CHARS = 1500;

export type WikiStats = VectorIndexStats;
export type WikiHit = VectorHit;

// ── File discovery ───────────────────────────────────────────────────────────

function walkMdFiles(dir: string, isRoot = true): string[] {
  const files: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    // An unreadable subfolder is skipped; only a missing/unreadable root is an error
    if (isRoot) throw error;
    return files;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      files.push(...walkMdFiles(path.join(dir, entry.name), false));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

// ── Chunking (exported for tests) ────────────────────────────────────────────

/** Split markdown into heading-delimited chunks, tracking line spans. */
export function splitIntoChunks(content: string): Array<VectorChunk> {
  const result: Array<VectorChunk> = [];
  const lines = content.split('\n');

  let currentHeading = 'overview';
  let currentStart = 0;
  let currentLines: string[] = [];

  const flush = (endLine: number): void => {
    const text = currentLines.join('\n').trim();
    if (text.length > 40) {
      result.push({
        heading: currentHeading,
        startLine: currentStart + 1,
        endLine,
        text: text.substring(0, MAX_CHUNK_CHARS),
      });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i])) {
      flush(i);
      currentHeading = lines[i].replace(/^#+\s+/, '').trim();
      currentStart = i; // the heading line belongs to the chunk
      currentLines = [];
    } else {
      currentLines.push(lines[i]);
    }
  }
  flush(lines.length);

  return result;
}

// ── Spec ─────────────────────────────────────────────────────────────────────

function indexDirPath(wikiPath: string): string {
  return path.join(wikiPath, INDEX_DIRNAME);
}

function wikiSpec(wikiPath: string) {
  return {
    listFiles: (): VectorFileEntry[] =>
      walkMdFiles(wikiPath).map((fullPath) => ({
        fullPath,
        relPath: path.relative(wikiPath, fullPath).replace(/\\/g, '/'),
      })),
    chunk: (relPath: string, content: string): VectorChunk[] =>
      splitIntoChunks(content).map((c) => ({
        ...c,
        // The heading (section title + file name) steers the embedding the way
        // the old BM25 index boosted heading matches.
        embedText: `${path.basename(relPath)} — ${c.heading}\n${c.text}`,
      })),
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Cheap availability check (reads meta.json only — no vectors). */
export function hasWikiIndex(wikiPath: string): boolean {
  return hasVectorIndex(indexDirPath(wikiPath));
}

export function invalidateWikiCache(wikiPath?: string): void {
  if (wikiPath) invalidateVectorCache(indexDirPath(wikiPath));
  else invalidateVectorCache();
}

export interface WikiRebuildOptions extends VectorRebuildOptions {
  /** Reports model download progress (first use downloads ~314 MB). */
  onDownloadProgress?: (file: string, receivedMB: number, totalMB: number) => void;
}

/**
 * Build (or incrementally update) the wiki index for a docs folder. Unchanged
 * files keep their vectors; the local embeddinggemma2 model runs in-process.
 */
export async function buildWikiIndex(
  wikiPath: string,
  opts: WikiRebuildOptions = {},
): Promise<WikiStats> {
  const stats = await rebuildVectorIndex(
    indexDirPath(wikiPath),
    EMBEDDING_MODEL_ID,
    wikiSpec(wikiPath),
    (texts) => embedDocuments(texts, opts.onDownloadProgress),
    opts,
  );
  // The old MiniSearch index file is superseded — remove it if present
  try {
    fs.unlinkSync(path.join(wikiPath, LEGACY_INDEX_FILENAME));
  } catch {
    // not there — fine
  }
  return stats;
}

/** Search the docs wiki, returning raw hits sorted by cosine similarity. */
export async function searchWikiRaw(
  wikiPath: string,
  query: string,
  topK = 1,
): Promise<WikiHit[]> {
  return searchVectorIndex(indexDirPath(wikiPath), query, EMBEDDING_MODEL_ID, (texts) =>
    embedQuery(texts, 'search result'),
    topK,
  );
}

/**
 * Search the docs wiki and return a formatted context string with the top-K
 * most relevant chunks. Returns an empty string if nothing is found.
 */
export async function searchWiki(wikiPath: string, query: string, topK = DEFAULT_TOP_K): Promise<string> {
  if (!query.trim()) return '';
  const hits = await searchWikiRaw(wikiPath, query, topK);
  if (hits.length === 0) return '';
  return hits.map((h) => `[${h.source} — ${h.heading}]\n${h.content}`).join('\n\n---\n\n');
}
