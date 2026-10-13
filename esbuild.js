const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { embeddingAlias, buildOnnxRuntimeShim } = require('./stubs/build');

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
      if (!result.errors.length) copyScreenCaptureAssets();
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(`    ${location.file}:${location.line}:${location.column}:`);
      });
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  await buildOnnxRuntimeShim(path.resolve(__dirname, 'dist'), production);
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    // The local embedding stack (embeddinggemma2 via Transformers.js) is
    // bundled; only onnxruntime-node stays external — the embedder redirects
    // it to the WASM shim built into dist/onnxruntime-node (stubs/build.js).
    external: ['onnxruntime-node', 'vscode'],
    logLevel: 'silent',
    alias: {
      '@common': path.resolve(__dirname, 'common'),
      ...embeddingAlias,
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
