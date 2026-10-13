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

/**
 * The upstream repo is multimodal — its config makes Transformers.js create
 * vision/audio sessions that the WASM runtime cannot serve (their weights use
 * external data files only the native runtime reads from disk). Text embeddings
 * only need the text tower, so before the first load we pre-seed the cached
 * config.json without the multimodal encoders, exactly as the model card
 * suggests for text-only use. This also skips ~300 MB of vision/audio weight
 * downloads. Best-effort: on failure the stock config is used.
 */
async function seedTextOnlyConfig(cacheDir: string): Promise<void> {
  const configPath = path.join(cacheDir, 'onnx-community', 'embeddinggemma-2-ONNX', 'config.json');
  let config: Record<string, unknown>;
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } else {
    const res = await fetch(`https://huggingface.co/${HF_REPO}/resolve/main/config.json`);
    if (!res.ok) throw new Error(`config.json download failed: ${res.status}`);
    config = await res.json();
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
  const onnxDir = path.join(cacheDir, 'onnx-community', 'embeddinggemma-2-ONNX', 'onnx');
  try {
    for (const file of fs.readdirSync(onnxDir)) {
      if (/^(vision_encoder|audio_encoder)/.test(file)) fs.unlinkSync(path.join(onnxDir, file));
    }
  } catch {
    // cache dir not created yet — nothing to clean
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
      const cacheDir = path.join(os.homedir(), '.askii', 'models');
      env.cacheDir = cacheDir;
      env.allowLocalModels = false;
      await seedTextOnlyConfig(cacheDir);
      return pipeline('feature-extraction', HF_REPO, {
        dtype: 'q8',
        ...(onProgress
          ? {
              progress_callback: (info: { status?: string; file?: string; loaded?: number; total?: number }) => {
                if (info.status === 'progress' && info.file && info.total) {
                  onProgress(info.file, (info.loaded ?? 0) / 1e6, info.total / 1e6);
                }
              },
            }
          : {}),
      });
    })().catch((error) => {
      extractorPromise = null; // allow a retry on the next call
      throw new Error(
        `Failed to load the local embedding model (${HF_REPO}) — first use downloads ~314 MB to ${path.join(
          os.homedir(),
          '.askii',
          'models',
        )}: ${error instanceof Error ? error.message : 'Unknown error'}`,
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
