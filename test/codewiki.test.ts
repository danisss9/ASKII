import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { suite, test } from 'mocha';
import { walkCodeFiles, splitCodeIntoChunks } from '../common/codewiki';
import { splitIntoChunks } from '../common/wiki';
import {
  rebuildVectorIndex,
  searchVectorIndex,
  hasVectorIndex,
  invalidateVectorCache,
  type EmbedFn,
  type VectorIndexSpec,
} from '../common/vectordb';

// ── Fake embedding: token-overlap bag of words in 8 dims ─────────────────────
// Texts sharing tokens get high cosine similarity, so ranking is deterministic.

const DIM = 8;

const fakeEmbed: EmbedFn = async (texts) =>
  texts.map((text) => {
    const vec = new Array<number>(DIM).fill(0);
    const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
    for (const word of words) {
      let h = 0;
      for (let i = 0; i < word.length; i++) h = (h * 31 + word.charCodeAt(i)) >>> 0;
      vec[h % DIM] += 1;
    }
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    return norm > 0 ? vec.map((v) => v / norm) : vec;
  });

function makeTmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'askii-vectordb-'));
}

function write(root: string, relPath: string, content: string): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

function lines(count: number, token: string): string {
  return `${Array.from({ length: count }, (_, i) => `${token} line ${i};`).join('\n')}\n`;
}

function specFor(root: string): VectorIndexSpec {
  return {
    listFiles: () =>
      walkCodeFiles(root).map((fullPath) => ({
        fullPath,
        relPath: path.relative(root, fullPath).replace(/\\/g, '/'),
      })),
    chunk: (relPath: string, content: string) =>
      splitCodeIntoChunks(content).map((c) => ({
        ...c,
        heading: `${relPath} (${c.heading})`,
        embedText: `${relPath} (lines ${c.startLine}-${c.endLine})\n${c.text}`,
      })),
  };
}

suite('common/codewiki', () => {
  test('walkCodeFiles returns code files only and honors .gitignore', () => {
    const root = makeTmpWorkspace();
    try {
      write(root, '.gitignore', 'secret/\nignored.ts\n');
      write(root, 'a.ts', 'const alpha = 1;\n');
      write(root, 'sub/b.py', 'beta = 2\n');
      write(root, 'ignored.ts', 'const nope = 3;\n');
      write(root, 'secret/c.js', 'const nope = 4;\n');
      write(root, 'README.md', '# docs\n');
      write(root, 'notes.txt', 'plain text\n');
      write(root, 'data.json', '{ "not": "code" }\n');
      write(root, 'config.yml', 'not: code\n');
      write(root, 'img.png', 'not really an image but wrong extension\n');
      write(root, 'node_modules/x.js', 'const vendor = 1;\n');
      write(root, 'dist/y.js', 'const built = 1;\n');
      write(root, '.hidden/z.ts', 'const hidden = 1;\n');

      const rels = walkCodeFiles(root)
        .map((p) => path.relative(root, p).replace(/\\/g, '/'))
        .sort();
      assert.deepStrictEqual(rels, ['a.ts', 'sub/b.py']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('splitCodeIntoChunks uses overlapping windows', () => {
    const fileLines: string[] = [];
    for (let i = 1; i <= 150; i++) fileLines.push(`line number ${i} of the file`);
    const chunks = splitCodeIntoChunks(fileLines.join('\n'));
    assert.strictEqual(chunks.length, 3);
    assert.deepStrictEqual(
      chunks.map((c) => [c.startLine, c.endLine]),
      [
        [1, 60],
        [51, 110],
        [101, 150],
      ],
    );
  });
});

suite('common/wiki', () => {
  test('splitIntoChunks chunks by heading and tracks line spans', () => {
    const md = [
      '# Intro',
      'Welcome to the documentation, this section has plenty of prose text here.',
      '',
      '## Usage',
      'Run the tool with the config file and read the output carefully.',
      '',
      '## Advanced',
      'Advanced flags and tuning knobs are described in this final section.',
    ].join('\n');
    const chunks = splitIntoChunks(md);
    assert.deepStrictEqual(
      chunks.map((c) => c.heading),
      ['Intro', 'Usage', 'Advanced'],
    );
    assert.deepStrictEqual(
      chunks.map((c) => [c.startLine, c.endLine]),
      [
        [1, 3],
        [4, 6],
        [7, 8],
      ],
    );
  });
});

suite('common/vectordb', () => {
  test('rebuild, search, and formatting round-trip', async () => {
    const root = makeTmpWorkspace();
    const indexDir = path.join(root, '.askii', 'code-wiki');
    try {
      write(root, 'src/alpha.ts', lines(80, 'alpha'));
      write(root, 'src/beta.py', lines(80, 'beta'));

      const stats = await rebuildVectorIndex(indexDir, 'test-model', specFor(root), fakeEmbed);
      assert.strictEqual(stats.fileCount, 2);
      assert.ok(stats.chunkCount >= 2);
      assert.strictEqual(stats.embeddedFiles, 2);
      assert.strictEqual(stats.dim, DIM);
      assert.strictEqual(hasVectorIndex(indexDir), true);

      const hits = await searchVectorIndex(indexDir, 'alpha alpha', 'test-model', fakeEmbed, 3);
      assert.ok(hits.length > 0);
      assert.strictEqual(hits[0].source, 'src/alpha.ts');
      assert.strictEqual(hits[0].heading, 'src/alpha.ts (lines 1-60)');
      assert.ok(hits[0].content.includes('alpha line'));

      // invalidate + reload from disk still finds the same top hit
      invalidateVectorCache(indexDir);
      const hits2 = await searchVectorIndex(indexDir, 'alpha alpha', 'test-model', fakeEmbed, 3);
      assert.strictEqual(hits2[0].source, 'src/alpha.ts');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('incremental rebuild reuses unchanged files and re-embeds changed ones', async () => {
    const root = makeTmpWorkspace();
    const indexDir = path.join(root, '.askii', 'code-wiki');
    try {
      write(root, 'a.ts', lines(70, 'alpha'));
      write(root, 'b.py', lines(70, 'beta'));

      const first = await rebuildVectorIndex(indexDir, 'test-model', specFor(root), fakeEmbed);
      assert.strictEqual(first.embeddedFiles, 2);
      assert.strictEqual(first.cachedFiles, 0);

      const second = await rebuildVectorIndex(indexDir, 'test-model', specFor(root), fakeEmbed);
      assert.strictEqual(second.embeddedFiles, 0);
      assert.strictEqual(second.cachedFiles, 2);
      assert.strictEqual(second.chunkCount, first.chunkCount);

      // Reused chunks still map to their own file, text and heading — b.py's
      // chunks sat behind a.ts's in the first build's embedding queue.
      for (const [token, file] of [
        ['beta', 'b.py'],
        ['alpha', 'a.ts'],
      ]) {
        const reused = await searchVectorIndex(indexDir, `${token} ${token}`, 'test-model', fakeEmbed, 3);
        assert.strictEqual(reused[0].source, file);
        assert.ok(reused[0].content.includes(`${token} line`));
        assert.ok(reused[0].heading?.startsWith(`${file} (lines`), `heading: ${reused[0].heading}`);
      }

      // Change b.py with an explicitly different mtime (Windows mtime granularity)
      write(root, 'b.py', lines(70, 'gamma'));
      const future = new Date(Date.now() + 10_000);
      fs.utimesSync(path.join(root, 'b.py'), future, future);

      const third = await rebuildVectorIndex(indexDir, 'test-model', specFor(root), fakeEmbed);
      assert.strictEqual(third.embeddedFiles, 1);
      assert.strictEqual(third.cachedFiles, 1);

      // Searches keep working after the incremental rebuild
      const hits = await searchVectorIndex(indexDir, 'gamma gamma', 'test-model', fakeEmbed, 3);
      assert.ok(hits.length > 0);
      assert.strictEqual(hits[0].source, 'b.py');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('changing the embedding model forces a full rebuild and rejects stale queries', async () => {
    const root = makeTmpWorkspace();
    const indexDir = path.join(root, '.askii', 'code-wiki');
    try {
      write(root, 'a.ts', lines(70, 'alpha'));

      const first = await rebuildVectorIndex(indexDir, 'model-one', specFor(root), fakeEmbed);
      assert.strictEqual(first.embeddedFiles, 1);

      const second = await rebuildVectorIndex(indexDir, 'model-two', specFor(root), fakeEmbed);
      assert.strictEqual(second.embeddedFiles, 1);
      assert.strictEqual(second.cachedFiles, 0);

      await assert.rejects(searchVectorIndex(indexDir, 'alpha', 'model-one', fakeEmbed, 3), /reload the index/);
      // The rebuilt model works
      const hits = await searchVectorIndex(indexDir, 'alpha', 'model-two', fakeEmbed, 3);
      assert.ok(hits.length > 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('binary files are skipped and embedText overrides the stored text', async () => {
    const root = makeTmpWorkspace();
    const indexDir = path.join(root, '.askii', 'code-wiki');
    try {
      write(root, 'good.ts', lines(70, 'alpha'));
      fs.writeFileSync(path.join(root, 'bad.ts'), Buffer.from('const x = 1;\0\0binary', 'utf-8'));

      const stats = await rebuildVectorIndex(indexDir, 'test-model', specFor(root), fakeEmbed);
      assert.strictEqual(stats.fileCount, 1);

      // The chunk stored on disk is the raw code; the embedText variant (with
      // the path header) is what got embedded — search still ranks by content.
      const hits = await searchVectorIndex(indexDir, 'good.ts alpha', 'test-model', fakeEmbed, 3);
      assert.ok(hits.length > 0);
      assert.ok(!hits[0].content.startsWith('good.ts')); // stored text is verbatim
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
