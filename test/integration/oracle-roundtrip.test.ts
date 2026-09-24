import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import oracle from 'oracledb';
import { targetDocumentSchema, type TargetDocument } from '../../src/model.js';

const exec = promisify(execFile);
const schemas = ['IAM', 'CATALOG', 'COMMERCE', 'FINANCE'];
const selectedViews = [{ owner: 'FINANCE', name: 'OPEN_ORDER_FINANCE' }, { owner: 'CATALOG', name: 'Product Availability' }];
const password = process.env.ORACLE_PWD ?? 'OracleDev123';

async function command(file: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}) {
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args, { env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ stdout, stderr }) :
      reject(new Error(`${file} ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`)));
    child.stdin.end(options.input);
  });
}

async function compose(...args: string[]) {
  return await command('docker', ['compose', ...args]);
}

async function publishedDsn(service: string): Promise<string> {
  const { stdout } = await compose('port', service, '1521');
  const port = /:(\d+)\s*$/.exec(stdout)?.[1];
  if (!port) throw new Error(`Cannot determine ${service} listener port from: ${stdout}`);
  return `127.0.0.1:${port}/FREEPDB1`;
}

async function runSqlplus(service: string, sql: string): Promise<string> {
  const script = `WHENEVER SQLERROR EXIT SQL.SQLCODE\nWHENEVER OSERROR EXIT FAILURE\n${sql}\nEXIT SUCCESS\n`;
  return (await command('docker', ['compose', 'exec', '-T', service, 'sqlplus', '-s', '/ as sysdba'], { input: script })).stdout;
}

async function pipeline(args: string[], outputDirectory: string): Promise<void> {
  await command(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    env: { ...process.env, ORACLE_PASSWORD: password, TMPDIR: outputDirectory },
  });
}

async function selectedTables(dsn: string): Promise<Array<{ owner: string; name: string }>> {
  const connection = await oracle.getConnection({ user: 'SYSTEM', password, connectString: dsn });
  try {
    const result = await connection.execute<{ OWNER: string; TABLE_NAME: string }>(`
      SELECT owner, table_name FROM dba_tables
       WHERE owner IN (${schemas.map((_, index) => `:s${index}`).join(',')})
       ORDER BY owner, table_name`, Object.fromEntries(schemas.map((schema, index) => [`s${index}`, schema])),
      { outFormat: oracle.OUT_FORMAT_OBJECT });
    return (result.rows ?? []).map(row => ({ owner: row.OWNER, name: row.TABLE_NAME }));
  } finally { await connection.close(); }
}

function normalizeExpression(value: string | null): string | null {
  if (value === null) return null;
  let normalized = value.trim().replace(/\s+/gu, ' ');
  while (normalized.startsWith('(') && normalized.endsWith(')')) {
    let depth = 0, wraps = true;
    for (let index = 0; index < normalized.length; index++) {
      if (normalized[index] === '(') depth++;
      else if (normalized[index] === ')') depth--;
      if (depth === 0 && index < normalized.length - 1) { wraps = false; break; }
    }
    if (!wraps) break;
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

/** Remove extraction-time and intentionally policy-dependent facts only. */
function comparable(document: TargetDocument): unknown {
  return document.tables.map(table => ({
    reference: table.reference,
    role: table.role,
    unsupportedFeatures: table.unsupportedFeatures,
    columns: table.columns.map(column => ({ ...column,
      // Oracle assigns a new ISEQ$$_ name on replay. Identity options carry
      // the structural behavior; the backing sequence default is incidental.
      defaultExpression: column.identity ? null : normalizeExpression(column.defaultExpression),
    })),
    constraints: table.constraints.map(constraint => {
      const common = { ...constraint, generatedName: undefined };
      return constraint.kind === 'check'
        ? { ...common, expression: normalizeExpression(constraint.expression) }
        : common;
    }).sort((left, right) => left.name.localeCompare(right.name)),
    indexes: table.indexes,
  })).sort((left, right) =>
    `${left.reference.owner}.${left.reference.name}`.localeCompare(`${right.reference.owner}.${right.reference.name}`));
}

function comparableViews(document: TargetDocument): unknown {
  return document.views.map(view => ({ ...view, query: normalizeExpression(view.query),
    dependencies: [...view.dependencies].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  })).sort((left, right) => JSON.stringify(left.reference).localeCompare(JSON.stringify(right.reference)));
}

test('generated SQL reconstructs the seeded source structure', { timeout: 15 * 60_000 }, async () => {
  if (process.env.ORACLE_INTEGRATION_USE_EXISTING !== '1') await compose('up', '-d', '--wait');

  const sourceDsn = process.env.ORACLE_SOURCE_DSN ?? await publishedDsn('oracle-source');
  const destinationDsn = process.env.ORACLE_DESTINATION_DSN ?? await publishedDsn('oracle-destination');
  const directory = await mkdtemp(join(tmpdir(), 'oracle-schema-roundtrip-'));
  const tableFile = join(directory, 'objects.json');
  const sourceFile = join(directory, 'source.json');
  const targetFile = join(directory, 'target.json');
  const sqlFile = join(directory, 'clone.sql');
  const replayFile = join(directory, 'replayed-source.json');
  const replayTargetFile = join(directory, 'replayed-target.json');

  const tables = await selectedTables(sourceDsn);
  assert.equal(tables.length, 98, 'source fixture must contain exactly 98 application tables');
  await writeFile(tableFile, `${JSON.stringify({ version: 2, tables, views: selectedViews }, null, 2)}\n`);

  await pipeline(['extract', '--dsn', sourceDsn, '--user', 'SYSTEM', '--objects', tableFile, '--output', sourceFile], directory);
  await pipeline(['transform', '--input', sourceFile, '--output', targetFile], directory);
  await pipeline(['validate', '--input', targetFile], directory);
  await pipeline(['generate', '--input', targetFile, '--output', sqlFile], directory);
  const generatedSql = await readFile(sqlFile, 'utf8');
  assert.ok(generatedSql.lastIndexOf('FOREIGN KEY') < generatedSql.indexOf('CREATE VIEW'));
  assert.ok(generatedSql.indexOf('CREATE VIEW "COMMERCE"."OPEN_ORDERS"') < generatedSql.indexOf('CREATE VIEW "COMMERCE"."ORDER_PRODUCT_ROLLUP"'));
  assert.ok(generatedSql.indexOf('GRANT SELECT ON "COMMERCE"."OPEN_ORDERS" TO "FINANCE";') < generatedSql.indexOf('CREATE VIEW "FINANCE"."OPEN_ORDER_FINANCE"'));

  await runSqlplus('oracle-destination', `ALTER SESSION SET CONTAINER=FREEPDB1;\nBEGIN\n${schemas.map(schema =>
    `  BEGIN EXECUTE IMMEDIATE 'DROP USER ${schema} CASCADE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1918 THEN RAISE; END IF; END;`).join('\n')}\nEND;\n/`);
  await runSqlplus('oracle-destination', `ALTER SESSION SET CONTAINER=FREEPDB1;\n${await readFile(sqlFile, 'utf8')}`);

  await pipeline(['extract', '--dsn', destinationDsn, '--user', 'SYSTEM', '--objects', tableFile, '--output', replayFile], directory);
  await pipeline(['transform', '--input', replayFile, '--output', replayTargetFile], directory);

  const expected = targetDocumentSchema.parse(JSON.parse(await readFile(targetFile, 'utf8')));
  const actual = targetDocumentSchema.parse(JSON.parse(await readFile(replayTargetFile, 'utf8')));
  assert.deepEqual(comparable(actual), comparable(expected));
  assert.deepEqual(comparableViews(actual), comparableViews(expected));
  assert.equal(expected.views.length, 5);

  const verification = await runSqlplus('oracle-destination', `ALTER SESSION SET CONTAINER=FREEPDB1;
SET HEADING OFF FEEDBACK OFF PAGES 0
SELECT (SELECT COUNT(*) FROM dba_tables WHERE owner IN ('IAM','CATALOG','COMMERCE','FINANCE')) || ':' ||
       (SELECT COUNT(*) FROM dba_constraints WHERE owner IN ('IAM','CATALOG','COMMERCE','FINANCE') AND constraint_type='R') || ':' ||
       (SELECT COUNT(*) FROM dba_views WHERE owner IN ('IAM','CATALOG','COMMERCE','FINANCE')) || ':' ||
       (SELECT COUNT(*) FROM dba_objects WHERE owner IN ('IAM','CATALOG','COMMERCE','FINANCE') AND status<>'VALID')
FROM dual;`);
  assert.match(verification.replace(/\s/gu, ''), /98:\d+:5:0/);
  const queryResult = await runSqlplus('oracle-destination', `ALTER SESSION SET CONTAINER=FREEPDB1;
SET HEADING OFF FEEDBACK OFF PAGES 0
SELECT COUNT(*) FROM FINANCE.open_order_finance;`);
  assert.match(queryResult.replace(/\s/gu, ''), /0/);
});
