import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const cli = resolve('src/cli.ts');
const tsx = resolve('node_modules/tsx/dist/loader.mjs');
const source = resolve('examples/source.json');
for (const location of ['default', 'relative', 'absolute']) {
  test(`CLI uses ${location} staging and preserves workbook bytes`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'publication-cli-'));
    try {
      await mkdir(join(directory, 'outputs'));
      const staging =
        location === 'default' ? '.oracle-schema-tmp' : 'configured';
      const args = [
        '--import',
        tsx,
        cli,
        'dictionary',
        '--input',
        source,
        '--output',
        'outputs/dictionary.xlsx',
      ];
      if (location !== 'default')
        args.push(
          '--temp-dir',
          location === 'relative' ? staging : join(directory, staging),
        );
      await execute(process.execPath, args, { cwd: directory });
      assert.deepEqual(await readdir(join(directory, staging)), []);
      const bytes = await readFile(join(directory, 'outputs/dictionary.xlsx'));
      assert.equal(bytes.subarray(0, 2).toString(), 'PK');
      const { default: ExcelJS } = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(join(directory, 'outputs/dictionary.xlsx'));
      assert.ok(workbook.worksheets.length > 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const custom of [false, true]) {
  test(`transform publishes a verifiable ${custom ? 'custom' : 'default'} completion manifest`, async () => {
    const { verifyCompletion } = await import('../src/completion.js');
    const directory = await mkdtemp(join(tmpdir(), 'publication-transform-'));
    try {
      const args = [
        '--import',
        tsx,
        cli,
        'transform',
        '--input',
        source,
        '--output',
        'target.json',
      ];
      if (custom)
        args.push('--report', 'changes.json', '--completion', 'finished.json');
      await execute(process.execPath, args, { cwd: directory });
      await verifyCompletion(
        join(directory, custom ? 'finished.json' : 'target.json.complete.json'),
        [
          { role: 'target', path: join(directory, 'target.json') },
          {
            role: 'report',
            path: join(
              directory,
              custom ? 'changes.json' : 'target.json.report.json',
            ),
          },
        ],
      );
      const target = JSON.parse(
        await readFile(join(directory, 'target.json'), 'utf8'),
      );
      const { generateSql } = await import('../src/generate.js');
      await execute(
        process.execPath,
        [
          '--import',
          tsx,
          cli,
          'generate',
          '--input',
          'target.json',
          '--output',
          'clone.sql',
        ],
        { cwd: directory },
      );
      assert.equal(
        await readFile(join(directory, 'clone.sql'), 'utf8'),
        generateSql(target),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const conflict of [
  'report-exists',
  'completion-exists',
  'report-alias',
  'completion-alias',
]) {
  test(`transform preflights ${conflict} before publishing any output`, async () => {
    const { writeFile, access } = await import('node:fs/promises');
    const directory = await mkdtemp(join(tmpdir(), 'publication-preflight-'));
    try {
      const args = [
        '--import',
        tsx,
        cli,
        'transform',
        '--input',
        source,
        '--output',
        'target.json',
      ];
      if (conflict.endsWith('exists')) {
        const path = conflict.startsWith('report')
          ? 'target.json.report.json'
          : 'target.json.complete.json';
        await writeFile(join(directory, path), 'original');
      } else
        args.push(
          conflict.startsWith('report') ? '--report' : '--completion',
          './target.json',
        );
      await assert.rejects(
        execute(process.execPath, args, { cwd: directory }),
        (error: unknown) => {
          assert.match(
            (error as { stderr: string }).stderr,
            conflict.endsWith('exists')
              ? /OUTPUT_EXISTS/
              : /OUTPUT_PATH_CONFLICT/,
          );
          return true;
        },
      );
      await assert.rejects(access(join(directory, 'target.json')));
      if (conflict.endsWith('exists')) {
        const path = conflict.startsWith('report')
          ? 'target.json.report.json'
          : 'target.json.complete.json';
        assert.equal(await readFile(join(directory, path), 'utf8'), 'original');
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('semantic errors still publish a complete reviewable transform bundle', async () => {
  const { writeFile, access } = await import('node:fs/promises');
  const { verifyCompletion } = await import('../src/completion.js');
  const directory = await mkdtemp(join(tmpdir(), 'publication-semantic-'));
  try {
    const document = JSON.parse(await readFile(source, 'utf8'));
    document.tables[0].unsupportedFeatures.push('unsupported test feature');
    await writeFile(join(directory, 'source.json'), JSON.stringify(document));
    await assert.rejects(
      execute(
        process.execPath,
        [
          '--import',
          tsx,
          cli,
          'transform',
          '--input',
          'source.json',
          '--output',
          'target.json',
        ],
        { cwd: directory },
      ),
      { code: 2 },
    );
    await verifyCompletion(join(directory, 'target.json.complete.json'), [
      { role: 'target', path: join(directory, 'target.json') },
      { role: 'report', path: join(directory, 'target.json.report.json') },
    ]);
    await assert.rejects(
      execute(
        process.execPath,
        [
          '--import',
          tsx,
          cli,
          'validate',
          '--input',
          'target.json',
          '--report',
          'validation.json',
        ],
        { cwd: directory },
      ),
      { code: 2 },
    );
    const diagnostics = JSON.parse(
      await readFile(join(directory, 'validation.json'), 'utf8'),
    );
    assert.ok(
      diagnostics.some(
        (item: { severity: string }) => item.severity === 'error',
      ),
    );
    await assert.rejects(
      execute(
        process.execPath,
        [
          '--import',
          tsx,
          cli,
          'generate',
          '--input',
          'target.json',
          '--output',
          'invalid.sql',
        ],
        { cwd: directory },
      ),
      { code: 1 },
    );
    await assert.rejects(access(join(directory, 'invalid.sql')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('renderability failures reach reports and block generation before staging SQL', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { sourceFixture } = await import('./fixtures.js');
  const directory = await mkdtemp(join(tmpdir(), 'publication-renderability-'));
  try {
    const document = sourceFixture();
    document.tables[0].columns[0].defaultExpression = `'${'x'.repeat(2400)}'`;
    await writeFile(join(directory, 'source.json'), JSON.stringify(document));
    const run = (...args: string[]) =>
      execute(process.execPath, ['--import', tsx, cli, ...args], {
        cwd: directory,
      });
    await assert.rejects(
      run('transform', '--input', 'source.json', '--output', 'target.json'),
      { code: 2 },
    );
    const report = JSON.parse(
      await readFile(join(directory, 'target.json.report.json'), 'utf8'),
    );
    const errors = report.filter(
      (d: { severity: string }) => d.severity === 'error',
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'SQL_LINE_LIMIT');
    await assert.rejects(
      run('validate', '--input', 'target.json', '--report', 'validation.json'),
      { code: 2 },
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, 'validation.json'), 'utf8')),
      errors,
    );
    // Output-path preflight may create the staging root, but no SQL is staged.
    await assert.rejects(
      run(
        'generate',
        '--input',
        'target.json',
        '--output',
        'clone.sql',
        '--temp-dir',
        'sql-staging',
      ),
      (error: unknown) => {
        assert.equal((error as { code: number }).code, 1);
        assert.match(
          (error as { stderr: string }).stderr,
          /SQL_LINE_LIMIT.*APP.*CHILD.*2400/,
        );
        return true;
      },
    );
    const files = await readdir(directory);
    assert.ok(!files.includes('clone.sql'));
    assert.deepEqual(await readdir(join(directory, 'sql-staging')), []);
    await writeFile(join(directory, 'malformed.json'), '{');
    for (const command of ['transform', 'validate', 'generate'])
      await assert.rejects(
        run(
          command,
          '--input',
          'malformed.json',
          '--output',
          'malformed-output',
        ),
        { code: 1 },
      );
    assert.ok(!(await readdir(directory)).includes('malformed-output'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
