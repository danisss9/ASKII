const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { embeddingAlias, buildOnnxRuntimeShim } = require('../stubs/build');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// screenshot-desktop's Windows backend reads its capture script and manifest
// from __dirname at runtime, which after bundling is dist/ — copy them there.
function copyScreenCaptureAssets() {
  const win32Dir = path.join(path.dirname(require.resolve('screenshot-desktop/package.json')), 'lib', 'win32');
  for (const file of fs.readdirSync(win32Dir)) {
    if (!file.endsWith('.js')) fs.copyFileSync(path.join(win32Dir, file), path.resolve(__dirname, 'dist', file));
  }
}

async function main() {
  await buildOnnxRuntimeShim(path.resolve(__dirname, 'dist'), production);
  const ctx = await esbuild.context({
    entryPoints: ['index.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/index.js',
    // The local embedding stack (embeddinggemma2 via Transformers.js) is
    // bundled; only onnxruntime-node stays external — the embedder redirects
    // it to the WASM shim built into dist/onnxruntime-node (stubs/build.js).
    external: ['onnxruntime-node'],
    banner: {
      js: '#!/usr/bin/env node\nconst __origEmit = process.emit; process.emit = function(e, ...a) { if (e === "warning" && a[0] && a[0].code === "DEP0040") return false; return __origEmit.call(this, e, ...a); };',
    },
    alias: {
      '@common': path.resolve(__dirname, '..', 'common'),
      ...embeddingAlias,
    },
    logLevel: 'info',
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    copyScreenCaptureAssets();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
