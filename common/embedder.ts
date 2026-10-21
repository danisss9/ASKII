import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Local EmbeddingGemma 2 ───────────────────────────────────────────────────
// Runs embeddinggemma2 fully in-process via Transformers.js + ONNX. No API
// keys, no external service. Weights are downloaded once on first use
// (~314 MB q8) and cached under ~/.askii/models, shared by the CLI and the
// VS Code extension.
//
// ONNX backend: Transformers.js is bundled into both the extension and the
// CLI; its runtime `onnxruntime-node` load is redirected to our WASM shim
// (stubs/onnxruntime-node, built into dist/onnxruntime-node), which forwards
// "cpu" sessions to the bundled onnxruntime-web.
//
// Retrieval follows the model card's instruction prefixes:
//   documents → "title: none | text: {content}"
//   queries   → "task: {task} | query: {query}"

// Stored in vector-index metadata — bump when the ONNX repo or quantization
// changes so existing indexes rebuild.
export const EMBEDDING_MODEL_ID = 'embeddinggemma2-q8';
export const EMBEDDING_DIM = 768;

const HF_REPO = 'onnx-community/embeddinggemma-2-ONNX';
const EMBEDDING_BATCH_SIZE = 8;

// One cache for every ASKII process — the CLI and the VS Code extension both
// read the weights from here, so they are downloaded once per machine.
const MODEL_CACHE_DIR = path.join(os.homedir(), '.askii', 'models');
const MODEL_REPO_DIR = path.join(MODEL_CACHE_DIR, ...HF_REPO.split('/'));
// Files a q8 text-only load reads; when all exist, loading needs no network.
const MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx',
  'onnx/model_quantized.onnx_data',
];
const DOWNLOAD_LOCK = path.join(MODEL_CACHE_DIR, '.download.lock');
const LOCK_POLL_MS = 1000;
// A first download is ~314 MB; past this, waiting on another process is given up
const LOCK_MAX_WAIT_MS = 30 * 60 * 1000;
// Sizes of the files of the last load that succeeded — a later mismatch means
// a file was truncated or replaced, and it is deleted so it downloads again.
const VERIFIED_MANIFEST = path.join(MODEL_REPO_DIR, '.askii-verified.json');
const FETCH_TIMEOUT_MS = 30_000;

function fileUrl(file: string): string {
  return `https://huggingface.co/${HF_REPO}/resolve/main/${file}`;
}

/**
 * The upstream repo is multimodal — its config makes Transformers.js create
 * vision/audio sessions that the WASM runtime cannot serve (their weights use
 * external data files only the native runtime reads from disk). Text embeddings
 * only need the text tower, so before the first load we pre-seed the cached
 * config.json without the multimodal encoders, exactly as the model card
 * suggests for text-only use. This also skips ~300 MB of vision/audio weight
 * downloads. Best-effort: on failure the stock config is used.
 */
async function seedTextOnlyConfig(): Promise<void> {
  const configPath = path.join(MODEL_REPO_DIR, 'config.json');
  let config: Record<string, unknown> | undefined;
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      // Corrupt (e.g. a write cut short) — drop it and fetch a fresh copy
      fs.rmSync(configPath, { force: true });
    }
  }
  if (!config) {
    const res = await fetch(fileUrl('config.json'), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`config.json download failed: ${res.status}`);
    config = (await res.json()) as Record<string, unknown>;
  }
  if (!('vision_config' in config) && !('audio_config' in config)) return; // already text-only

  for (const key of [
    'vision_config',
    'audio_config',
    'audio_token_id',
    'boa_token_id',
    'boi_token_id',
    'image_token_id',
    'video_token_id',
    'eoi_token_id',
    'eoa_token_index',
    'vision_soft_tokens_per_image',
  ]) {
    delete config[key];
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Self-heal caches from earlier multimodal runs — those weights are never loaded
  const onnxDir = path.join(MODEL_REPO_DIR, 'onnx');
  try {
    for (const file of fs.readdirSync(onnxDir)) {
      if (/^(vision_encoder|audio_encoder)/.test(file)) fs.unlinkSync(path.join(onnxDir, file));
    }
  } catch {
    // cache dir not created yet — nothing to clean
  }
}

function readManifest(): Record<string, number> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(VERIFIED_MANIFEST, 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : null;
  } catch {
    return null;
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(path.join(MODEL_REPO_DIR, file)).size;
  } catch {
    return -1;
  }
}

/** Records the sizes of a cache that loaded successfully. */
function writeManifest(): void {
  try {
    const sizes = Object.fromEntries(MODEL_FILES.map((file) => [file, fileSize(file)]));
    fs.writeFileSync(VERIFIED_MANIFEST, JSON.stringify(sizes, null, 2));
  } catch {
    // best-effort
  }
}

/**
 * True when every model file is present and non-empty — and, once a load has
 * succeeded, the same size as then. A file that no longer matches (truncated
 * download, partial copy) is deleted so the next load fetches it again.
 */
function isModelCached(): boolean {
  const manifest = readManifest();
  let complete = true;
  for (const file of MODEL_FILES) {
    const size = fileSize(file);
    const expected = manifest?.[file];
    if (size <= 0 || (typeof expected === 'number' && expected !== size)) {
      if (size >= 0) fs.rmSync(path.join(MODEL_REPO_DIR, file), { force: true });
      complete = false;
    }
  }
  if (!complete) fs.rmSync(VERIFIED_MANIFEST, { force: true });
  return complete;
}

/**
 * After a failed load: compares each cached file with the size Hugging Face
 * reports and deletes the ones that differ, so a retry re-downloads only
 * those. Returns the names of the files removed.
 */
async function removeMismatchedFiles(): Promise<string[]> {
  const removed: string[] = [];
  for (const file of MODEL_FILES) {
    const size = fileSize(file);
    if (size < 0) continue;
    try {
      const res = await fetch(fileUrl(file), {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const remote = Number(res.headers.get('x-linked-size') ?? res.headers.get('content-length'));
      // config.json is rewritten locally (text-only), so only sizes of the others are comparable
      if (file !== 'config.json' && res.ok && remote > 0 && remote !== size) {
        fs.rmSync(path.join(MODEL_REPO_DIR, file), { force: true });
        removed.push(file);
      }
    } catch {
      // offline — nothing to compare against
    }
  }
  return removed;
}

/** A lock is stale when its owner process is gone (crashed mid-download). */
function isLockStale(): boolean {
  try {
    const pid = Number(fs.readFileSync(DOWNLOAD_LOCK, 'utf-8'));
    if (!Number.isInteger(pid) || pid <= 0) {
      // Owner has not written its pid yet — stale only if it never will
      return Date.now() - fs.statSync(DOWNLOAD_LOCK).mtimeMs > 60_000;
    }
    process.kill(pid, 0); // throws ESRCH when the process no longer exists
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'EPERM'; // EPERM: alive, not ours
  }
}

/**
 * Serializes first-time downloads across processes, so a CLI run and the VS
 * Code extension starting together on an empty cache download the weights
 * once: the second waits, then loads from the cache the first filled.
 */
async function withDownloadLock<T>(fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(MODEL_CACHE_DIR, { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      fs.writeFileSync(DOWNLOAD_LOCK, String(process.pid), { flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (isLockStale()) {
      fs.rmSync(DOWNLOAD_LOCK, { force: true });
      continue;
    }
    if (Date.now() - started > LOCK_MAX_WAIT_MS) {
      throw new Error(
        `another ASKII process has been downloading the embedding model for over 30 minutes (lock: ${DOWNLOAD_LOCK}) — delete the lock file if that process is gone`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(DOWNLOAD_LOCK, { force: true });
  }
}

export interface EmbedderProgress {
  (file: string, receivedMB: number, totalMB: number): void;
}

export interface EmbedTextsOptions {
  /** 'document' indexes content, 'query' embeds a retrieval query (default). */
  role?: 'document' | 'query';
  /** Query task prefix, e.g. 'code retrieval' or 'search result'. */
  task?: string;
  onProgress?: EmbedderProgress;
  batchSize?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Extractor = any;

/**
 * Redirects @huggingface/transformers' unconditional runtime
 * `require('onnxruntime-node')` (made through createRequire, so the bundler
 * cannot rewrite it) to the WASM shim built next to the bundle. The native
 * runtime is a ~300 MB platform-specific package, so bundles ship without it.
 */
function redirectNativeBackend(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Module = require('module') as {
      _resolveFilename: (request: string, ...rest: unknown[]) => string;
    };
    const shim = path.join(__dirname, 'onnxruntime-node', 'index.js');
    const original = Module._resolveFilename;
    Module._resolveFilename = function (request: string, ...rest: unknown[]) {
      return original.call(this, request === 'onnxruntime-node' ? shim : request, ...rest);
    };
  } catch {
    // without the redirect, transformers reports the missing native runtime
  }
}

let extractorPromise: Promise<Extractor> | null = null;

async function getExtractor(onProgress?: EmbedderProgress): Promise<Extractor> {
  // Reuse the in-flight load; only the first caller reports download progress.
  if (!extractorPromise) {
    extractorPromise = (async () => {
      redirectNativeBackend();
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = MODEL_CACHE_DIR;
      env.allowLocalModels = false;

      // Transformers.js emits 'progress' while reading cached files too —
      // report only files missing from the cache, i.e. real downloads.
      const downloading = new Map<string, boolean>();
      const isDownloading = (file: string): boolean => {
        let missing = downloading.get(file);
        if (missing === undefined) {
          missing = !fs.existsSync(path.join(MODEL_REPO_DIR, file));
          downloading.set(file, missing);
        }
        return missing;
      };

      const load = async () => {
        await seedTextOnlyConfig();
        return pipeline('feature-extraction', HF_REPO, {
          dtype: 'q8',
          ...(onProgress
            ? {
                progress_callback: (info: { status?: string; file?: string; loaded?: number; total?: number }) => {
                  if (info.status === 'progress' && info.file && info.total && isDownloading(info.file)) {
                    onProgress(info.file, (info.loaded ?? 0) / 1e6, info.total / 1e6);
                  }
                },
              }
            : {}),
        });
      };
      const extractor = await (isModelCached() ? load() : withDownloadLock(load));
      writeManifest();
      return extractor;
    })().catch(async (error) => {
      extractorPromise = null; // allow a retry on the next call
      const removed = await removeMismatchedFiles();
      const hint = removed.length
        ? ` Incomplete cached file(s) removed (${removed.join(', ')}) — try again to re-download them.`
        : '';
      throw new Error(
        `Failed to load the local embedding model (${HF_REPO}) — first use downloads ~314 MB to ${MODEL_CACHE_DIR}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }.${hint}`,
      );
    });
  }
  return extractorPromise;
}

function prefix(text: string, opts: EmbedTextsOptions): string {
  if (opts.role === 'document') {
    return `title: none | text: ${text}`;
  }
  return `task: ${opts.task ?? 'search result'} | query: ${text}`;
}

/**
 * Embed texts with the local embeddinggemma2 model. Returns one L2-normalized
 * vector (dim 768) per input, in input order.
 */
export async function embedTexts(
  texts: string[],
  opts: EmbedTextsOptions = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor(opts.onProgress);
  const batchSize = Math.max(1, opts.batchSize ?? EMBEDDING_BATCH_SIZE);
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize).map((t) => prefix(t, opts));
    const res = await extractor(batch, { pooling: 'mean', normalize: true });
    out.push(...(res.tolist() as number[][]));
  }
  return out;
}

/** Embeds indexed content (uses the model's document prefix). */
export function embedDocuments(
  texts: string[],
  onProgress?: EmbedderProgress,
): Promise<number[][]> {
  return embedTexts(texts, { role: 'document', onProgress });
}

/** Embeds a retrieval query (uses the model's query prefix). */
export function embedQuery(
  texts: string[],
  task: 'search result' | 'code retrieval' = 'search result',
): Promise<number[][]> {
  return embedTexts(texts, { role: 'query', task });
}
