import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { suite, test } from 'mocha';
import {
  parseWorkspaceActions,
  applyModifyAction,
  writeBackup,
  backupOrRecordCreated,
  recordCreatedFile,
  restoreAllBackups,
  type WorkspaceAction,
} from '../common/workspace';
import { decodeIfDoubleEscaped } from '../common/utils';

function makeTmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'askii-workspace-'));
}

suite('common/workspace — parseWorkspaceActions', () => {
  test('keeps every advertised action type, including code_search', () => {
    const actions = parseWorkspaceActions(
      '[{"type":"code_search","query":"auth"},{"type":"run","command":"npm test"},{"type":"bogus"}]',
    );
    assert.deepStrictEqual(
      actions?.map((a) => a.type),
      ['code_search', 'run'],
    );
  });

  test('returns null (not []) when no valid array is found', () => {
    assert.strictEqual(parseWorkspaceActions('I will look at the files first.'), null);
    // Truncated mid-array, e.g. by an output-token limit
    assert.strictEqual(parseWorkspaceActions('[{"type":"write","path":"a.ts","content":"x'), null);
    assert.deepStrictEqual(parseWorkspaceActions('[]'), []);
  });

  test('finds the array despite brackets in surrounding prose and fences', () => {
    const actions = parseWorkspaceActions(
      'Checking [config] first:\n[{"type":"view","path":"a.ts"}]\nThen [more].',
    );
    assert.deepStrictEqual(actions, [{ type: 'view', path: 'a.ts' }]);
    assert.deepStrictEqual(parseWorkspaceActions('```json\n[{"type":"list","path":"."}]\n```'), [
      { type: 'list', path: '.' },
    ]);
  });
});

suite('common/workspace — applyModifyAction', () => {
  const modify = (fields: Partial<WorkspaceAction>): WorkspaceAction => ({
    type: 'modify',
    path: 'f.ts',
    ...fields,
  });

  test('replacement text is literal — $&, $$ and $\' are not expanded', () => {
    const result = applyModifyAction(
      'const x = 1;\n',
      modify({ oldContent: '1', newContent: "s.replace(/a/, '$&$$') + $'" }),
    );
    assert.deepStrictEqual(result, { text: "const x = s.replace(/a/, '$&$$') + $';\n" });
  });

  test('keeps escape sequences in code intact', () => {
    const result = applyModifyAction(
      'print("old")\n',
      modify({ oldContent: 'print("old")', newContent: 'print("a\\nb\\t\\"c\\"")' }),
    );
    assert.deepStrictEqual(result, { text: 'print("a\\nb\\t\\"c\\"")\n' });
  });

  test('requires oldContent or a line range instead of prepending', () => {
    assert.ok('error' in applyModifyAction('abc', modify({ newContent: 'x' })));
    assert.ok('error' in applyModifyAction('abc', modify({ oldContent: 'zzz', newContent: 'x' })));
  });

  test('line-range modify keeps CRLF endings and clamps startLine 0', () => {
    const result = applyModifyAction(
      'a\r\nb\r\nc\r\n',
      modify({ startLine: 2, endLine: 2, newContent: 'B1\nB2' }),
    );
    assert.deepStrictEqual(result, { text: 'a\r\nB1\r\nB2\r\nc\r\n' });
    assert.deepStrictEqual(
      applyModifyAction('a\nb\n', modify({ startLine: 0, endLine: 1, newContent: 'A' })),
      { text: 'A\nb\n' },
    );
  });
});

suite('common/utils — decodeIfDoubleEscaped', () => {
  test('leaves real multi-line code (with \\n inside string literals) untouched', () => {
    const code = 'console.log("a\\nb");\nconst p = "C:\\\\temp";\n';
    assert.strictEqual(decodeIfDoubleEscaped(code), code);
  });

  test('decodes content that arrived escaped twice', () => {
    assert.strictEqual(
      decodeIfDoubleEscaped('line one\\nsay \\"hi\\"\\n\\tindented'),
      'line one\nsay "hi"\n\tindented',
    );
  });

  test('leaves single-line files with \\n only inside string literals untouched', () => {
    const minified = 'var a="x\\ny",b=\'p\\nq\';function f(){return a+b}';
    assert.strictEqual(decodeIfDoubleEscaped(minified), minified);
    const json = '{"msg":"line1\\nline2","n":1}';
    assert.strictEqual(decodeIfDoubleEscaped(json), json);
  });

  test('decodes double-escaped code without quotes or with single quotes', () => {
    assert.strictEqual(
      decodeIfDoubleEscaped('def f():\\n    return 1\\n'),
      'def f():\n    return 1\n',
    );
    assert.strictEqual(
      decodeIfDoubleEscaped("const a = 'x';\\nfoo();"),
      "const a = 'x';\nfoo();",
    );
  });
});

suite('common/workspace — backups and undo', () => {
  test('a second edit keeps the original backup', () => {
    const root = makeTmpWorkspace();
    try {
      const file = path.join(root, 'a.txt');
      fs.writeFileSync(file, 'original');
      writeBackup(root, file);
      fs.writeFileSync(file, 'edit 1');
      writeBackup(root, file);
      fs.writeFileSync(file, 'edit 2');

      restoreAllBackups(root);
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), 'original');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('writing over an existing file backs it up instead of recording it as created', () => {
    const root = makeTmpWorkspace();
    try {
      const existing = path.join(root, 'README.md');
      const fresh = path.join(root, 'new.md');
      fs.writeFileSync(existing, 'keep me');
      backupOrRecordCreated(root, existing);
      fs.writeFileSync(existing, 'overwritten');
      backupOrRecordCreated(root, fresh);
      fs.writeFileSync(fresh, 'created');

      const { deleted } = restoreAllBackups(root);
      assert.strictEqual(fs.readFileSync(existing, 'utf-8'), 'keep me');
      assert.strictEqual(fs.existsSync(fresh), false);
      assert.deepStrictEqual(deleted, ['new.md']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('delete then re-create restores the original rather than deleting it', () => {
    const root = makeTmpWorkspace();
    try {
      const file = path.join(root, 'x.ts');
      fs.writeFileSync(file, 'original');
      writeBackup(root, file);
      fs.unlinkSync(file);
      recordCreatedFile(root, 'x.ts');
      fs.writeFileSync(file, 'recreated');

      restoreAllBackups(root);
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), 'original');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
