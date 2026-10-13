const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

// The local embedding stack (embeddinggemma2 via Transformers.js) is bundled
// into the main bundle; Transformers.js then loads "onnxruntime-node" at
// runtime, which the embedder redirects to <outDir>/onnxruntime-node — the
// WASM shim bundled with onnxruntime-web, plus the wasm binary and its loader.
// Everything ships inside dist/, so neither the VSIX nor the npm package needs
// node_modules (the ~300 MB native runtime is never shipped).

const ORT_WASM_FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];

// Bundle-time aliases for the main bundle: Transformers.js imports sharp
// unconditionally, but ASKII only embeds text.
const embeddingAlias = {
  sharp: path.resolve(__dirname, 'sharp'),
};

async function buildOnnxRuntimeShim(outDir, production) {
  const shimDir = path.join(outDir, 'onnxruntime-node');
  await esbuild.build({
    entryPoints: [path.resolve(__dirname, 'onnxruntime-node', 'index.js')],
    bundle: true,
    format: 'cjs',
    minify: production,
    platform: 'node',
    outfile: path.join(shimDir, 'index.js'),
    logLevel: 'warning',
  });
  const ortDist = path.dirname(require.resolve('onnxruntime-web', { paths: [__dirname] }));
  for (const file of ORT_WASM_FILES) {
    fs.copyFileSync(path.join(ortDist, file), path.join(shimDir, file));
  }
}

module.exports = { embeddingAlias, buildOnnxRuntimeShim };
