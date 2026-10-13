import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

// ── Generic quantized vector store ───────────────────────────────────────────
// File layout inside <indexDir>:
//   meta.json    — commit point: scalar metadata, file table, per-chunk meta as
//                  base64-packed typed arrays (paths/headings deduped into tables)
//   vectors.bin  — Int8-quantized embeddings, chunkCount * dim bytes
//   scales.bin   — Float32 per-chunk dequantization scale
//   norms.bin    — Float32 per-chunk L2 norm of the dequantized vector
//   chunks.bin   — concatenated UTF-8 chunk texts, addressed by byte offset
//                  (chunk text is read from disk only for the top-k hits)
//
// Memory profile vs. Float32 JSON: ~1/4 the resident vector bytes, no per-chunk
// objects, and chunk text never loaded unless retrieved.

const META_FILE = 'meta.json';
const VECTORS_FILE = 'vectors.bin';
const SCALES_FILE = 'scales.bin';
const NORMS_FILE = 'norms.bin';
const CHUNKS_FILE = 'chunks.bin';

const FORMAT_VERSION = 1;
const MAX_FILE_BYTES = 200 * 1024; // skip files over 200 KB
const MIN_CHUNK_CHARS = 40; // minimum non-whitespace chars per chunk

// ── Public types ─────────────────────────────────────────────────────────────

/** Embeds a batch of texts, returning one vector per input. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export interface VectorChunk {
  heading: string;
  startLine: number; // 1-indexed
  endLine: number;
  text: string;
  /** Text embedded in place of `text` when set (stored text stays verbatim). */
  embedText?: string;
}

export interface VectorFileEntry {
  relPath: string; // forward slashes, relative to the indexed root
  fullPath: string;
}

export interface VectorIndexSpec {
  /** Lists the files to index, in deterministic (sorted) order. */
  listFiles: () => VectorFileEntry[];
  /** Splits one file's content into chunks. */
  chunk: (relPath: string, content: string) => VectorChunk[];
}

export interface VectorIndexStats {
  fileCount: number;
  chunkCount: number;
  dim: number;
  /** Files whose vectors were re-embedded (new or changed since the last index). */
  embeddedFiles: number;
  /** Files whose vectors were copied over from the previous index unchanged. */
  cachedFiles: number;
}

export interface VectorRebuildOptions {
  onProgress?: (stage: 'indexing', current: number, total: number) => void;
}

export interface VectorHit {
  source: string;  // relative path of the source file
  heading: string; // chunk heading
  content: string; // chunk text
  score: number;   // cosine similarity (-1..1)
}

// ── Index metadata (meta.json) ───────────────────────────────────────────────

interface FileRecord {
  path: string;     // relative, forward slashes
  size: number;
  mtimeMs: number;
  chunkIndex: number; // index of the file's first chunk
  chunkCount: number;
}

interface IndexMeta {
  version: number;
  model: string;
  dim: number;
  builtAt: string;
  fileCount: number;
  chunkCount: number;
  paths: string[];
  headings: string[];
  files: FileRecord[];
  // Base64-packed parallel arrays, one entry per chunk:
  pathIdx: string;    // Uint32Array → index into paths
  headingIdx: string; // Uint32Array → index into headings
  startLine: string;  // Uint32Array (1-indexed)
  endLine: string;    // Uint32Array
  offset: string;     // Float64Array → byte offset into chunks.bin
  length: string;     // Uint32Array → byte length in chunks.bin
}

interface LoadedIndex {
  meta: IndexMeta;
  vectors: Int8Array;   // chunkCount * dim
  scales: Float32Array; // chunkCount
  norms: Float32Array;  // chunkCount
}

// Process-lifetime cache per index directory.
const indexCache = new Map<string, LoadedIndex>();

// ── Packing helpers (base64 ↔ typed arrays) ──────────────────────────────────

function packUint32(arr: Uint32Array): string {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
}

function packFloat64(arr: Float64Array): string {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
}

function unpackUint32(b64: string, count: number): Uint32Array {
  const out = new Uint32Array(count);
  const buf = Buffer.from(b64, 'base64');
  for (let i = 0; i < count; i++) out[i] = buf.readUInt32LE(i * 4);
  return out;
}

function unpackFloat64(b64: string, count: number): Float64Array {
  const out = new Float64Array(count);
  const buf = Buffer.from(b64, 'base64');
  for (let i = 0; i < count; i++) out[i] = buf.readDoubleLE(i * 8);
  return out;
}

function decodeMeta(raw: string): IndexMeta | null {
  try {
    const meta = JSON.parse(raw) as IndexMeta;
    if (meta.version !== FORMAT_VERSION || typeof meta.chunkCount !== 'number') return null;
    return meta;
  } catch {
    return null;
  }
}

// ── Availability / cache ─────────────────────────────────────────────────────

/** Cheap availability check (reads meta.json only — no vectors). */
export function hasVectorIndex(indexDir: string): boolean {
  try {
    const meta = decodeMeta(fs.readFileSync(path.join(indexDir, META_FILE), 'utf-8'));
    return !!meta && meta.chunkCount > 0;
  } catch {
    return false;
  }
}

export function invalidateVectorCache(indexDir?: string): void {
  if (indexDir) indexCache.delete(indexDir);
  else indexCache.clear();
}

// ── Load (search path) ───────────────────────────────────────────────────────

function loadIndex(indexDir: string): LoadedIndex | null {
  const cached = indexCache.get(indexDir);
  if (cached) return cached;

  let meta: IndexMeta;
  try {
    meta = decodeMeta(fs.readFileSync(path.join(indexDir, META_FILE), 'utf-8'))!;
    if (!meta) return null;
  } catch {
    return null;
  }

  const count = meta.chunkCount;
  const dim = meta.dim;
  try {
    const vectorsBuf = fs.readFileSync(path.join(indexDir, VECTORS_FILE));
    const scalesBuf = fs.readFileSync(path.join(indexDir, SCALES_FILE));
    const normsBuf = fs.readFileSync(path.join(indexDir, NORMS_FILE));
    const chunksStat = fs.statSync(path.join(indexDir, CHUNKS_FILE));

    // Validate layout against meta — a mismatched set of files is treated as no index
    if (
      vectorsBuf.length !== count * dim ||
      scalesBuf.length !== count * 4 ||
      normsBuf.length !== count * 4
    ) {
      return null;
    }

    const index: LoadedIndex = {
      meta,
      vectors: new Int8Array(vectorsBuf.buffer, vectorsBuf.byteOffset, count * dim),
      scales: new Float32Array(count),
      norms: new Float32Array(count),
    };
    for (let i = 0; i < count; i++) {
      index.scales[i] = scalesBuf.readFloatLE(i * 4);
      index.norms[i] = normsBuf.readFloatLE(i * 4);
    }
    // Chunk text spans must exactly cover chunks.bin
    const chunkMeta = getChunkMeta(meta);
    const last = count - 1;
    if (count === 0 || chunkMeta.offset[last] + chunkMeta.length[last] !== chunksStat.size) {
      return null;
    }
    for (const arr of [chunkMeta.pathIdx, chunkMeta.headingIdx, chunkMeta.startLine, chunkMeta.endLine]) {
      if (arr.length !== count) return null;
    }

    indexCache.set(indexDir, index);
    return index;
  } catch {
    return null;
  }
}

interface ChunkMetaArrays {
  pathIdx: Uint32Array;
  headingIdx: Uint32Array;
  startLine: Uint32Array;
  endLine: Uint32Array;
  offset: Float64Array;
  length: Uint32Array;
}

function getChunkMeta(meta: IndexMeta): ChunkMetaArrays {
  const count = meta.chunkCount;
  return {
    pathIdx: unpackUint32(meta.pathIdx, count),
    headingIdx: unpackUint32(meta.headingIdx, count),
    startLine: unpackUint32(meta.startLine, count),
    endLine: unpackUint32(meta.endLine, count),
    offset: unpackFloat64(meta.offset, count),
    length: unpackUint32(meta.length, count),
  };
}

// ── Rebuild ──────────────────────────────────────────────────────────────────

interface TmpWriter {
  vectors: fsp.FileHandle;
  scales: fsp.FileHandle;
  norms: fsp.FileHandle;
  chunks: fsp.FileHandle;
}

/** Heuristic binary sniff — NUL bytes virtually never appear in text sources. */
function looksBinary(content: string): boolean {
  return content.includes('\0');
}

/**
 * Rebuild (or incrementally update) a vector index.
 *
 * Files whose size and mtime are unchanged since the previous index — and when
 * the embedding model is unchanged — keep their vectors: the quantized blocks
 * are copied from the old files without re-embedding. Only new/changed files
 * are chunked and embedded. Writes are staged to .tmp files and committed by
 * renaming, meta.json last.
 */
export async function rebuildVectorIndex(
  indexDir: string,
  model: string,
  spec: VectorIndexSpec,
  embedDocs: EmbedFn,
  opts: VectorRebuildOptions = {},
): Promise<VectorIndexStats> {
  const files = spec.listFiles().sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  fs.mkdirSync(indexDir, { recursive: true });

  // Previous index — reused only when the format and model match
  let oldMeta: IndexMeta | null = null;
  let oldFilesByPath = new Map<string, FileRecord>();
  try {
    const parsed = decodeMeta(fs.readFileSync(path.join(indexDir, META_FILE), 'utf-8'));
    if (parsed && parsed.model === model) {
      oldMeta = parsed;
      oldFilesByPath = new Map(parsed.files.map((f) => [f.path, f]));
    }
  } catch {
    // no previous index — full rebuild
  }

  const oldVectorsPath = path.join(indexDir, VECTORS_FILE);
  const oldScalesPath = path.join(indexDir, SCALES_FILE);
  const oldNormsPath = path.join(indexDir, NORMS_FILE);
  const oldChunksPath = path.join(indexDir, CHUNKS_FILE);
  const oldReadable =
    !!oldMeta &&
    fs.existsSync(oldVectorsPath) &&
    fs.existsSync(oldScalesPath) &&
    fs.existsSync(oldNormsPath) &&
    fs.existsSync(oldChunksPath);
  const oldChunkMeta = oldReadable && oldMeta ? getChunkMeta(oldMeta) : null;

  const tmpPaths = {
    vectors: path.join(indexDir, `${VECTORS_FILE}.tmp`),
    scales: path.join(indexDir, `${SCALES_FILE}.tmp`),
    norms: path.join(indexDir, `${NORMS_FILE}.tmp`),
    chunks: path.join(indexDir, `${CHUNKS_FILE}.tmp`),
    meta: path.join(indexDir, `${META_FILE}.tmp`),
  };

  let out: TmpWriter | null = null;
  try {
    out = {
      vectors: await fsp.open(tmpPaths.vectors, 'w'),
      scales: await fsp.open(tmpPaths.scales, 'w'),
      norms: await fsp.open(tmpPaths.norms, 'w'),
      chunks: await fsp.open(tmpPaths.chunks, 'w'),
    };
    // Non-null alias for use inside the try block (flushBatch, copy loops)
    const writer: TmpWriter = out;

    let dim = oldMeta?.dim ?? 0;
    let chunkCursor = 0;
    let byteCursor = 0;
    let embeddedFiles = 0;
    let cachedFiles = 0;
    const newFiles: FileRecord[] = [];
    const pathIdxs: number[] = [];
    const headingIdxs: number[] = [];
    const startLines: number[] = [];
    const endLines: number[] = [];
    const offsets: number[] = [];
    const lengths: number[] = [];
    const pathTable: string[] = [];
    const headingTable: string[] = [];
    const pathIndexByPath = new Map<string, number>();
    const headingIndexByHeading = new Map<string, number>();

    const internPath = (relPath: string): number => {
      let idx = pathIndexByPath.get(relPath);
      if (idx === undefined) {
        idx = pathTable.length;
        pathTable.push(relPath);
        pathIndexByPath.set(relPath, idx);
      }
      return idx;
    };

    const internHeading = (heading: string): number => {
      let idx = headingIndexByHeading.get(heading);
      if (idx === undefined) {
        idx = headingTable.length;
        headingTable.push(heading);
        headingIndexByHeading.set(heading, idx);
      }
      return idx;
    };

    // Embedding batch queue — flushed when it reaches the batch limit
    let pending: Array<{ pathIdx: number; headingIdx: number; chunk: VectorChunk }> = [];

    const quantize = (vec: number[]): { q: Int8Array; scale: number; norm: number } => {
      let maxAbs = 0;
      for (let i = 0; i < vec.length; i++) {
        const a = Math.abs(vec[i]);
        if (a > maxAbs) maxAbs = a;
      }
      const scale = maxAbs > 0 ? maxAbs / 127 : 1;
      const q = new Int8Array(vec.length);
      let sumSq = 0;
      for (let i = 0; i < vec.length; i++) {
        const v = Math.round(vec[i] / scale);
        q[i] = v;
        sumSq += v * v;
      }
      // Norm of the *dequantized* vector so search-time reconstruction matches
      return { q, scale, norm: scale * Math.sqrt(sumSq) };
    };

    const appendChunkText = async (text: string): Promise<number> => {
      const buf = Buffer.from(text, 'utf-8');
      await writer.chunks.write(buf);
      return buf.length;
    };

    const flushBatch = async (): Promise<void> => {
      if (pending.length === 0) return;
      const vectors = await embedDocs(pending.map((p) => p.chunk.embedText ?? p.chunk.text));
      if (vectors.length !== pending.length) {
        throw new Error(
          `Embedding provider returned ${vectors.length} vectors for ${pending.length} inputs`,
        );
      }
      for (let i = 0; i < pending.length; i++) {
        const vec = vectors[i];
        if (!Array.isArray(vec) || vec.length === 0) {
          throw new Error('Embedding provider returned an empty vector');
        }
        if (dim === 0) dim = vec.length;
        if (vec.length !== dim) {
          throw new Error(`Inconsistent embedding dimensions: expected ${dim}, got ${vec.length}`);
        }
        const { q, scale, norm } = quantize(vec);
        const scaleBuf = Buffer.alloc(4);
        scaleBuf.writeFloatLE(scale, 0);
        const normBuf = Buffer.alloc(4);
        normBuf.writeFloatLE(norm, 0);
        await writer.vectors.write(Buffer.from(q.buffer, q.byteOffset, q.byteLength));
        await writer.scales.write(scaleBuf);
        await writer.norms.write(normBuf);

        const p = pending[i];
        const len = await appendChunkText(p.chunk.text);
        pathIdxs.push(p.pathIdx);
        headingIdxs.push(p.headingIdx);
        startLines.push(p.chunk.startLine);
        endLines.push(p.chunk.endLine);
        offsets.push(byteCursor);
        lengths.push(len);
        byteCursor += len;
        chunkCursor++;
      }
      pending = [];
    };

    for (let fi = 0; fi < files.length; fi++) {
      const entry = files[fi];
      opts.onProgress?.('indexing', fi + 1, files.length);
      const relPath = entry.relPath.replace(/\\/g, '/');

      const stat = fs.statSync(entry.fullPath);
      const oldRecord = oldReadable ? oldFilesByPath.get(relPath) : undefined;
      const canReuse = !!oldRecord && oldRecord.size === stat.size && oldRecord.mtimeMs === stat.mtimeMs;

      if (canReuse && oldRecord && oldChunkMeta && oldMeta) {
        // Earlier files' queued chunks must land first — the output is ordered
        // by chunkCursor, and the reused block is written immediately below.
        await flushBatch();

        // Copy the quantized vectors/scales/norms and chunk text blocks verbatim
        const count = oldRecord.chunkCount;
        const vecStart = oldRecord.chunkIndex * dim;
        const vecLen = count * dim;
        const vecBuf = Buffer.alloc(vecLen);
        const vh = await fsp.open(oldVectorsPath, 'r');
        try {
          await vh.read(vecBuf, 0, vecLen, vecStart);
        } finally {
          await vh.close();
        }
        await writer.vectors.write(vecBuf);

        for (const [oldPath, outHandle, bytesPerItem] of [
          [oldScalesPath, writer.scales, 4],
          [oldNormsPath, writer.norms, 4],
        ] as const) {
          const buf = Buffer.alloc(count * bytesPerItem);
          const h = await fsp.open(oldPath, 'r');
          try {
            await h.read(buf, 0, buf.length, oldRecord.chunkIndex * bytesPerItem);
          } finally {
            await h.close();
          }
          await outHandle.write(buf);
        }

        const textStart = oldChunkMeta.offset[oldRecord.chunkIndex];
        let textLen = 0;
        for (let c = 0; c < count; c++) textLen += oldChunkMeta.length[oldRecord.chunkIndex + c];
        const textBuf = Buffer.alloc(textLen);
        const ch = await fsp.open(oldChunksPath, 'r');
        try {
          await ch.read(textBuf, 0, textLen, textStart);
        } finally {
          await ch.close();
        }
        await writer.chunks.write(textBuf);

        const pathIdx = internPath(relPath);
        for (let c = 0; c < count; c++) {
          const ci = oldRecord.chunkIndex + c;
          pathIdxs.push(pathIdx);
          // Re-intern: the old index points into the previous heading table
          headingIdxs.push(internHeading(oldMeta.headings[oldChunkMeta.headingIdx[ci]]));
          startLines.push(oldChunkMeta.startLine[ci]);
          endLines.push(oldChunkMeta.endLine[ci]);
          offsets.push(byteCursor);
          lengths.push(oldChunkMeta.length[ci]);
          byteCursor += oldChunkMeta.length[ci];
          chunkCursor++;
        }

        newFiles.push({
          path: relPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          chunkIndex: chunkCursor - count,
          chunkCount: count,
        });
        cachedFiles++;
        continue;
      }

      // New or changed file — read, chunk, and queue for embedding
      let content: string;
      try {
        content = fs.readFileSync(entry.fullPath, 'utf-8');
      } catch {
        continue;
      }
      if (looksBinary(content)) continue;

      const chunks = spec.chunk(relPath, content);
      // Chunks still queued for embedding come before this file's
      const firstChunk = chunkCursor + pending.length;
      const pathIdx = internPath(relPath);
      let fileChunkCount = 0;
      for (const chunk of chunks) {
        if (chunk.text.replace(/\s/g, '').length <= MIN_CHUNK_CHARS) continue;
        pending.push({ pathIdx, headingIdx: internHeading(chunk.heading), chunk });
        fileChunkCount++;
        if (pending.length >= 32) await flushBatch();
      }
      if (fileChunkCount > 0) {
        newFiles.push({
          path: relPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          chunkIndex: firstChunk,
          chunkCount: fileChunkCount,
        });
        embeddedFiles++;
      }
    }
    await flushBatch();

    const meta: IndexMeta = {
      version: FORMAT_VERSION,
      model,
      dim,
      builtAt: new Date().toISOString(),
      fileCount: newFiles.length,
      chunkCount: chunkCursor,
      paths: pathTable,
      headings: headingTable,
      files: newFiles,
      pathIdx: packUint32(Uint32Array.from(pathIdxs)),
      headingIdx: packUint32(Uint32Array.from(headingIdxs)),
      startLine: packUint32(Uint32Array.from(startLines)),
      endLine: packUint32(Uint32Array.from(endLines)),
      offset: packFloat64(Float64Array.from(offsets)),
      length: packUint32(Uint32Array.from(lengths)),
    };

    // Commit: data files first, meta.json last — readers treat any mismatch
    // (validated on load) as a missing index and the next rebuild self-heals.
    await writer.vectors.close();
    await writer.scales.close();
    await writer.norms.close();
    await writer.chunks.close();
    out = null;
    await fsp.rename(tmpPaths.vectors, path.join(indexDir, VECTORS_FILE));
    await fsp.rename(tmpPaths.scales, path.join(indexDir, SCALES_FILE));
    await fsp.rename(tmpPaths.norms, path.join(indexDir, NORMS_FILE));
    await fsp.rename(tmpPaths.chunks, path.join(indexDir, CHUNKS_FILE));
    fs.writeFileSync(tmpPaths.meta, JSON.stringify(meta), 'utf-8');
    await fsp.rename(tmpPaths.meta, path.join(indexDir, META_FILE));

    invalidateVectorCache(indexDir);

    return {
      fileCount: newFiles.length,
      chunkCount: chunkCursor,
      dim,
      embeddedFiles,
      cachedFiles,
    };
  } catch (error) {
    // Best-effort cleanup of the staging files; the previous index stays intact
    for (const p of Object.values(tmpPaths)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // ignore
      }
    }
    throw error;
  } finally {
    if (out) {
      for (const handle of [out.vectors, out.scales, out.norms, out.chunks]) {
        try {
          await handle.close();
        } catch {
          // ignore
        }
      }
    }
  }
}

// ── Search ───────────────────────────────────────────────────────────────────

function topKIndices(scores: Float32Array, k: number): number[] {
  const n = scores.length;
  const idxs: number[] = [];
  const taken = new Uint8Array(n);
  for (let pick = 0; pick < k; pick++) {
    let best = -1;
    let bestScore = 0; // only chunks with positive similarity qualify
    for (let i = 0; i < n; i++) {
      if (!taken[i] && scores[i] > bestScore) {
        bestScore = scores[i];
        best = i;
      }
    }
    if (best === -1) break;
    taken[best] = 1;
    idxs.push(best);
  }
  return idxs;
}

async function readChunkTexts(
  indexDir: string,
  indices: number[],
  chunkMeta: ChunkMetaArrays,
): Promise<string[]> {
  const handle = await fsp.open(path.join(indexDir, CHUNKS_FILE), 'r');
  try {
    const texts: string[] = [];
    for (const i of indices) {
      const len = chunkMeta.length[i];
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, chunkMeta.offset[i]);
      texts.push(buf.toString('utf-8'));
    }
    return texts;
  } finally {
    await handle.close();
  }
}

/**
 * Search a vector index, embedding the query with embedQuery and scoring all
 * chunks by cosine similarity over the quantized vectors. Returns hits sorted
 * by similarity (best first).
 */
export async function searchVectorIndex(
  indexDir: string,
  query: string,
  model: string,
  embedQuery: EmbedFn,
  topK = 3,
): Promise<VectorHit[]> {
  const q = query.trim();
  if (!q) return [];

  const index = loadIndex(indexDir);
  if (!index || index.meta.chunkCount === 0) return [];
  if (index.meta.model !== model) {
    throw new Error(
      `Index was built with "${index.meta.model}" but the current embedding model is "${model}" — reload the index.`,
    );
  }

  const [queryVec] = await embedQuery([q]);
  if (!queryVec || queryVec.length !== index.meta.dim) {
    throw new Error(
      `Query embedding has ${queryVec?.length ?? 0} dimensions but the index expects ${index.meta.dim} — reload the index.`,
    );
  }
  let qNormSq = 0;
  for (let i = 0; i < queryVec.length; i++) qNormSq += queryVec[i] * queryVec[i];
  const qNorm = Math.sqrt(qNormSq);
  if (qNorm === 0) return [];

  const { vectors, scales, norms, meta } = index;
  const dim = meta.dim;
  const count = meta.chunkCount;
  const scores = new Float32Array(count);
  for (let c = 0; c < count; c++) {
    const base = c * dim;
    let dot = 0;
    for (let i = 0; i < dim; i++) dot += queryVec[i] * vectors[base + i];
    const cn = norms[c];
    scores[c] = cn > 0 ? (dot * scales[c]) / (cn * qNorm) : 0;
  }

  const indices = topKIndices(scores, topK);
  if (indices.length === 0) return [];

  const chunkMeta = getChunkMeta(meta);
  const texts = await readChunkTexts(indexDir, indices, chunkMeta);
  return indices.map((i, rank) => ({
    source: meta.paths[chunkMeta.pathIdx[i]],
    heading: meta.headings[chunkMeta.headingIdx[i]],
    content: texts[rank],
    score: scores[i],
  }));
}
