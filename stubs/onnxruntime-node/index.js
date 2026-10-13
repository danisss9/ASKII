// ASKII shim — stands in for the native onnxruntime-node package with the
// WASM backend from onnxruntime-web (which ships an official Node build).
// @huggingface/transformers requires "onnxruntime-node" unconditionally and
// requests the "cpu" execution provider; this forwards everything to
// onnxruntime-web, rewriting "cpu" to its "wasm" provider.
//
// Reason: the native runtime is ~300 MB of per-platform binaries — far too
// heavy to ship inside askii — while the WASM runtime is ~14 MB and
// platform-independent.
//
// stubs/build.js bundles this file together with onnxruntime-web into
// dist/onnxruntime-node/ and copies the wasm binary and its loader next to it,
// so the extension and the CLI need no node_modules at runtime.
const fs = require('fs');
const path = require('path');
const url = require('url');
const ortWeb = require('onnxruntime-web');

// Transformers.js defaults wasmPaths to a CDN URL — fine in browsers, but
// Node's ESM loader rejects the blob: URLs it produces. Point it at the wasm
// files shipped next to this bundle (as a file:// URL — the .mjs loader
// import()s it, and on Windows a bare path parses as a "c:" protocol).
// Trailing slash is required — ORT concatenates wasmPaths + filename as raw
// strings, so "…/dir" would yield "…/dirort-wasm-simd-threaded.wasm".
ortWeb.env.wasm.wasmPaths = url.pathToFileURL(path.join(__dirname, path.sep)).href;

function toWasmProviders(providers) {
  if (!providers) return providers;
  return providers.map((p) => (typeof p === 'string' && p === 'cpu' ? 'wasm' : p));
}

// ORT-web cannot read external-data files itself in Node — entries given as
// plain paths are ignored by the wasm. Load them into buffers here.
function materializeExternalData(options) {
  if (!Array.isArray(options.externalData)) return;
  options.externalData = options.externalData.map((entry) => {
    if (typeof entry !== 'string') return entry;
    try {
      return { path: path.basename(entry), data: new Uint8Array(fs.readFileSync(entry)) };
    } catch {
      return entry; // unreadable — let ORT report the original error
    }
  });
}

// Transformers.js withholds session_options.externalData in Node when every
// entry is a path string (the native runtime reads those from disk itself).
// The WASM runtime can't — so when we see an .onnx model path, proactively
// attach its sibling external-data files as buffers.
function attachModelExternalData(modelArg, options) {
  if (typeof modelArg !== 'string' || !modelArg.toLowerCase().endsWith('.onnx')) return;
  if (options.externalData && options.externalData.length > 0) return;
  try {
    const dir = path.dirname(modelArg);
    const base = path.basename(modelArg).replace(/\.onnx$/i, '');
    const files = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.onnx_data`));
    if (files.length === 0) return;
    options.externalData = files.map((f) => ({
      path: f,
      data: new Uint8Array(fs.readFileSync(path.join(dir, f))),
    }));
  } catch {
    // best-effort — ORT reports the original error if the data is missing
  }
}

const InferenceSession = Object.assign({}, ortWeb.InferenceSession);
InferenceSession.create = async function create(...args) {
  const optionsArg = args.find((a) => a && typeof a === 'object' && !Array.isArray(a));
  for (const arg of args) {
    if (typeof arg === 'string') {
      if (optionsArg) attachModelExternalData(arg, optionsArg);
    } else if (arg && typeof arg === 'object') {
      if (Array.isArray(arg.executionProviders)) {
        arg.executionProviders = toWasmProviders(arg.executionProviders);
      }
      materializeExternalData(arg);
    }
  }
  return ortWeb.InferenceSession.create(...args);
};

module.exports = Object.assign({}, ortWeb, { InferenceSession });
