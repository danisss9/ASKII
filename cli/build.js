const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// The embedding stack runs on the WASM ONNX backend: these two tiny shims are
// copied next to the bundle so the embedder can redirect onnxruntime-node and
// sharp to them (the ~300 MB native runtime is never shipped in dev trees).
function copyEmbeddingShims() {
  fs.cpSync(path.resolve(__dirname, '..', 'stubs', 'onnxruntime-node'), path.resolve(__dirname, 'dist', 'onnxruntime-node'), { recursive: true });
  fs.cpSync(path.resolve(__dirname, '..', 'stubs', 'sharp'), path.resolve(__dirname, 'dist', 'sharp-stub'), { recursive: true });
}

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['index.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/index.js',
    // The local embedding stack (embeddinggemma2 via Transformers.js) stays
    // external: it ships as real node_modules so its .wasm assets resolve.
    external: [
      '@huggingface/transformers',
      '@huggingface/jinja',
      '@huggingface/tokenizers',
      'onnxruntime-web',
      'onnxruntime-common',
      'onnxruntime-node',
      'sharp',
      'flatbuffers',
      'guid-typescript',
      'long',
      'platform',
      'protobufjs',
    ],
    banner: {
      js: '#!/usr/bin/env node\nconst __origEmit = process.emit; process.emit = function(e, ...a) { if (e === "warning" && a[0] && a[0].code === "DEP0040") return false; return __origEmit.call(this, e, ...a); };',
    },
    alias: {
      '@common': path.resolve(__dirname, '..', 'common'),
    },
    logLevel: 'info',
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    copyEmbeddingShims();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
