const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// The embedding stack runs on the WASM ONNX backend: these two tiny shims are
// copied next to the bundle so the embedder can redirect onnxruntime-node and
// sharp to them (the ~300 MB native runtime is never shipped).
function copyEmbeddingShims() {
  fs.cpSync(path.resolve(__dirname, 'stubs/onnxruntime-node'), path.resolve(__dirname, 'dist/onnxruntime-node'), { recursive: true });
  fs.cpSync(path.resolve(__dirname, 'stubs/sharp'), path.resolve(__dirname, 'dist/sharp-stub'), { recursive: true });
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',

  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      if (!result.errors.length) copyEmbeddingShims();
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(`    ${location.file}:${location.line}:${location.column}:`);
      });
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
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
      'vscode',
    ],
    logLevel: 'silent',
    alias: {
      '@common': path.resolve(__dirname, 'common'),
    },
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
    ],
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
