import { ExtractionProgress, type ProgressEvent } from '../../src/progress.js';
import {
  assertIndependentFacts,
  assertDestinationBehavior,
} from './independent-facts.js';
import { OracleCatalog } from '../../src/catalog.js';
import { extractSource } from '../../src/extract.js';
import { transformSource } from '../../src/transform.js';
import { buildDictionaryWorkbook } from '../../src/dictionary.js';
import { generateSql } from '../../src/generate.js';
import { validateTarget } from '../../src/validate.js';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import oracle from 'oracledb';
import { targetDocumentSchema, type TargetDocument } from '../../src/model.js';

import { comparableExpression as normalizeExpression } from '../helpers/sql-comparison.js';
const schemas = ['IAM', 'CATALOG', 'COMMERCE', 'FINANCE'];
const selectedViews = [
  { owner: 'FINANCE', name: 'OPEN_ORDER_FINANCE' },
  { owner: 'CATALOG', name: 'Product Availability' },
];
const password = process.env.ORACLE_PWD ?? 'OracleDev123';

async function command(
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string } = {},
) {
  return await new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(file, args, {
        env: options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve({ stdout, stderr })
          : reject(
              new Error(
                `${file} ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`,
              ),
            ),
      );
      child.stdin.end(options.input);
    },
  );
}

async function compose(...args: string[]) {
  return await command('docker', ['compose', ...args]);
}

async function publishedDsn(service: string): Promise<string> {
  const { stdout } = await compose('port', service, '1521');
  const port = /:(\d+)\s*$/.exec(stdout)?.[1];
  if (!port)
    throw new Error(
      `Cannot determine ${service} listener port from: ${stdout}`,
    );
  return `127.0.0.1:${port}/FREEPDB1`;
}

async function runSqlplus(service: string, sql: string): Promise<string> {
  const script = `WHENEVER SQLERROR EXIT SQL.SQLCODE\nWHENEVER OSERROR EXIT FAILURE\n${sql}\nEXIT SUCCESS\n`;
  return (
    await command(
      'docker',
      ['compose', 'exec', '-T', service, 'sqlplus', '-s', '/ as sysdba'],
      { input: script },
    )
  ).stdout;
}

async function pipeline(args: string[], outputDirectory: string) {
  return await command(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', ...args],
    {
      env: {
        ...process.env,
        ORACLE_PASSWORD: password,
        TMPDIR: outputDirectory,
      },
    },
  );
}

async function selectedTables(
  dsn: string,
): Promise<Array<{ owner: string; name: string }>> {
  const connection = await oracle.getConnection({
    user: 'SYSTEM',
    password,
    connectString: dsn,
  });
  try {
    const result = await connection.execute<{
      OWNER: string;
      TABLE_NAME: string;
    }>(
      `
      SELECT owner, table_name FROM dba_tables
       WHERE owner IN (${schemas.map((_, index) => `:s${index}`).join(',')})
       ORDER BY owner, table_name`,
      Object.fromEntries(schemas.map((schema, index) => [`s${index}`, schema])),
      { outFormat: oracle.OUT_FORMAT_OBJECT },
    );
    return (result.rows ?? []).map((row) => ({
      owner: row.OWNER,
      name: row.TABLE_NAME,
    }));
  } finally {
    await connection.close();
  }
}

/** Remove extraction-time and intentionally policy-dependent facts only. */
function comparable(document: TargetDocument): unknown {
  return document.tables
    .map((table) => ({
      reference: table.reference,
      role: table.role,
      comment: table.comment,
      unsupportedFeatures: table.unsupportedFeatures,
      columns: table.columns.map((column) => ({
        ...column,
        // Oracle assigns a new ISEQ$$_ name on replay. Identity options carry
        // the structural behavior; the backing sequence default is incidental.
        defaultExpression: column.identity
          ? null
          : normalizeExpression(column.defaultExpression),
      })),
      constraints: table.constraints
        .map((constraint) => {
          const common = { ...constraint, generatedName: undefined };
          return constraint.kind === 'check'
            ? {
                ...common,
                expression: normalizeExpression(constraint.expression),
              }
            : common;
        })
        .sort((left, right) => left.name.localeCompare(right.name)),
      indexes: table.indexes,
    }))
    .sort((left, right) =>
      `${left.reference.owner}.${left.reference.name}`.localeCompare(
        `${right.reference.owner}.${right.reference.name}`,
      ),
    );
}

function comparableViews(document: TargetDocument): unknown {
  return document.views
    .map((view) => ({
      ...view,
      query: normalizeExpression(view.query),
      dependencies: [...view.dependencies].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
    }))
    .sort((left, right) =>
      JSON.stringify(left.reference).localeCompare(
        JSON.stringify(right.reference),
      ),
    );
}

test(
  'generated SQL reconstructs the seeded source structure',
  { timeout: 15 * 60_000 },
  async () => {
    if (process.env.ORACLE_INTEGRATION_USE_EXISTING !== '1')
      await compose('up', '-d', '--wait');

    const sourceDsn =
      process.env.ORACLE_SOURCE_DSN ?? (await publishedDsn('oracle-source'));
    const destinationDsn =
      process.env.ORACLE_DESTINATION_DSN ??
      (await publishedDsn('oracle-destination'));
    const directory = await mkdtemp(join(tmpdir(), 'oracle-schema-roundtrip-'));
    const tableFile = join(directory, 'objects.json');
    const sourceFile = join(directory, 'source.json');
    const targetFile = join(directory, 'target.json');
    const sqlFile = join(directory, 'clone.sql');
    const replayFile = join(directory, 'replayed-source.json');
    const replayTargetFile = join(directory, 'replayed-target.json');

    await assertIndependentFacts(sourceDsn, password);
    const tables = await selectedTables(sourceDsn);
    assert.equal(
      tables.length,
      98,
      'source fixture must contain exactly 98 application tables',
    );
    await writeFile(
      tableFile,
      `${JSON.stringify({ version: 2, tables, views: selectedViews }, null, 2)}\n`,
    );

    const extractionOutput = await pipeline(
      [
        'extract',
        '--progress-json',
        '--dsn',
        sourceDsn,
        '--user',
        'SYSTEM[SCHEMA_READER]',
        '--objects',
        tableFile,
        '--output',
        sourceFile,
      ],
      directory,
    );
    const progressEvents = extractionOutput.stderr
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ProgressEvent);
    assert.ok(
      progressEvents.some(
        (event) =>
          event.stage === 'query' &&
          event.event === 'complete' &&
          typeof event.rows === 'number',
      ),
    );
    assert.equal(progressEvents.at(-1)!.stage, 'publication');
    assert.equal(progressEvents.at(-1)!.event, 'complete');
    assert.equal(new Set(progressEvents.map((event) => event.runId)).size, 1);
    assert.ok(!extractionOutput.stderr.includes(password));
    assert.ok(!extractionOutput.stderr.includes(sourceDsn));
    assert.match(extractionOutput.stdout, /^Extracted 98 table definitions/);
    await pipeline(
      ['transform', '--input', sourceFile, '--output', targetFile],
      directory,
    );
    await pipeline(['validate', '--input', targetFile], directory);
    const orderedTarget = targetDocumentSchema.parse(
      JSON.parse(await readFile(targetFile, 'utf8')),
    );
    // The independently extracted catalog model uses the same offline preflight.
    const overlongTarget = structuredClone(orderedTarget);
    const defaultColumn = overlongTarget.tables
      .flatMap((table) => table.columns)
      .find((column) => !column.virtual && !column.identity)!;
    defaultColumn.defaultExpression = `'${'x'.repeat(2400)}'`;
    assert.ok(
      validateTarget(overlongTarget).some(
        (diagnostic) => diagnostic.code === 'SQL_LINE_LIMIT',
      ),
    );
    assert.throws(() => generateSql(overlongTarget), /SQL_LINE_LIMIT/);
    const shuffledTarget = structuredClone(orderedTarget);
    shuffledTarget.views.reverse();
    for (const view of shuffledTarget.views) view.dependencies.reverse();
    assert.equal(generateSql(shuffledTarget), generateSql(orderedTarget));
    await pipeline(
      ['generate', '--input', targetFile, '--output', sqlFile],
      directory,
    );
    const generatedSql = await readFile(sqlFile, 'utf8');
    assert.ok(
      generatedSql.lastIndexOf('FOREIGN KEY') <
        generatedSql.indexOf('CREATE VIEW'),
    );
    assert.ok(
      generatedSql.indexOf('CREATE VIEW "COMMERCE"."OPEN_ORDERS"') <
        generatedSql.indexOf('CREATE VIEW "COMMERCE"."ORDER_PRODUCT_ROLLUP"'),
    );
    assert.ok(
      generatedSql.indexOf(
        'GRANT SELECT ON "COMMERCE"."OPEN_ORDERS" TO "FINANCE";',
      ) < generatedSql.indexOf('CREATE VIEW "FINANCE"."OPEN_ORDER_FINANCE"'),
    );

    await runSqlplus(
      'oracle-destination',
      `ALTER SESSION SET CONTAINER=FREEPDB1;\nBEGIN\n${schemas
        .map(
          (schema) =>
            `  BEGIN EXECUTE IMMEDIATE 'DROP USER ${schema} CASCADE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1918 THEN RAISE; END IF; END;`,
        )
        .join('\n')}\nEND;\n/`,
    );
    await runSqlplus(
      'oracle-destination',
      `ALTER SESSION SET CONTAINER=FREEPDB1;\n${await readFile(sqlFile, 'utf8')}`,
    );

    await pipeline(
      [
        'extract',
        '--dsn',
        destinationDsn,
        '--catalog-scope',
        'dba',
        '--user',
        'SYSTEM',
        '--objects',
        tableFile,
        '--output',
        replayFile,
      ],
      directory,
    );
    await pipeline(
      ['transform', '--input', replayFile, '--output', replayTargetFile],
      directory,
    );

    await assertIndependentFacts(destinationDsn, password);
    await assertDestinationBehavior(destinationDsn, password);

    const expected = targetDocumentSchema.parse(
      JSON.parse(await readFile(targetFile, 'utf8')),
    );
    const actual = targetDocumentSchema.parse(
      JSON.parse(await readFile(replayTargetFile, 'utf8')),
    );
    const users = expected.tables.find(
      (table) =>
        table.reference.owner === 'IAM' &&
        table.reference.name === 'PRINCIPALS',
    )!;
    const products = expected.tables.find(
      (table) =>
        table.reference.owner === 'CATALOG' &&
        table.reference.name === 'PRODUCTS',
    )!;
    assert.equal(users.comment, "Users' directory & lifecycle — exact text");
    assert.equal(
      users.columns.find((column) => column.name === 'EMAIL')!.comment,
      "Primary address\nUnicode Ω & apostrophe's test",
    );
    assert.equal(
      products.columns.find((column) => column.name === 'PRODUCT_NAME')!.comment
        ?.length,
      3900,
    );
    assert.deepEqual(comparable(actual), comparable(expected));
    assert.deepEqual(comparableViews(actual), comparableViews(expected));
    assert.equal(expected.views.length, 5);

    const verification = await runSqlplus(
      'oracle-destination',
      `ALTER SESSION SET CONTAINER=FREEPDB1;
SET HEADING OFF FEEDBACK OFF PAGES 0
SELECT (SELECT COUNT(*) FROM dba_tables WHERE owner IN ('IAM','CATALOG','COMMERCE','FINANCE')) || ':' ||
       (SELECT COUNT(*) FROM dba_constraints WHERE owner IN ('IAM','CATALOG','COMMERCE','FINANCE') AND constraint_type='R') || ':' ||
       (SELECT COUNT(*) FROM dba_views WHERE owner IN ('IAM','CATALOG','COMMERCE','FINANCE')) || ':' ||
       (SELECT COUNT(*) FROM dba_objects WHERE owner IN ('IAM','CATALOG','COMMERCE','FINANCE') AND status<>'VALID')
FROM dual;`,
    );
    assert.match(verification.replace(/\s/gu, ''), /98:\d+:5:0/);
    const queryResult = await runSqlplus(
      'oracle-destination',
      `ALTER SESSION SET CONTAINER=FREEPDB1;
SET HEADING OFF FEEDBACK OFF PAGES 0
SELECT COUNT(*) FROM FINANCE.open_order_finance;`,
    );
    assert.match(queryResult.replace(/\s/gu, ''), /0/);
  },
);

test(
  'view restriction facts agree with Oracle, workbook and replay behavior',
  { timeout: 180_000 },
  async () => {
    const connection = await oracle.getConnection({
      user: 'SYSTEM',
      password,
      connectString:
        process.env.ORACLE_DESTINATION_DSN ??
        (await publishedDsn('oracle-destination')),
    });
    const owner = 'CATALOG';
    const table = 'CATALOG_DECODE_PROBE';
    const cases = [
      {
        name: 'CATALOG_DECODE_PLAIN',
        suffix: '',
        readOnly: false,
        check: 'NONE',
        type: null,
      },
      {
        name: 'CATALOG_DECODE_RO',
        suffix: ' WITH READ ONLY',
        readOnly: true,
        check: 'NONE',
        type: 'O',
      },
      {
        name: 'CATALOG_DECODE_CHECK',
        suffix: ' WITH CHECK OPTION CONSTRAINT CATALOG_DECODE_CK',
        readOnly: false,
        check: 'CASCADED',
        type: 'V',
      },
    ];
    const created = new Set<string>();
    let tableCreated = false;
    try {
      await connection.execute(`CREATE TABLE ${owner}.${table} (ID NUMBER)`);
      tableCreated = true;
      await connection.execute(`INSERT INTO ${owner}.${table} VALUES (1)`);
      await connection.commit();
      for (const item of cases) {
        await connection.execute(
          `CREATE VIEW ${owner}.${item.name} AS SELECT ID FROM ${owner}.${table} WHERE ID > 0${item.suffix}`,
        );
        created.add(item.name);
      }
      const source = await extractSource(new OracleCatalog(connection), {
        version: 2,
        tables: [],
        views: cases.map(({ name }) => ({ owner, name })),
      });
      const workbook = buildDictionaryWorkbook(source).getWorksheet('Views')!;
      const sql = generateSql(transformSource(source));
      for (const item of cases) {
        const view = source.views.find(
          (view) => view.reference.name === item.name,
        )!;
        assert.equal(view.readOnly, item.readOnly);
        assert.equal(view.checkOption, item.check);
        const row = workbook
          .getRows(2, cases.length)!
          .find((row) => row.getCell(2).value === item.name)!;
        assert.equal(row.getCell(6).value, item.readOnly ? 'TRUE' : 'FALSE');
        assert.equal(row.getCell(7).value, item.check);
        const statement = sql
          .match(/CREATE VIEW [\s\S]*?;/g)!
          .find((statement) => statement.includes(`"${item.name}"`))!;
        assert.equal(
          (statement.match(/WITH (?:READ ONLY|CHECK OPTION)/g) ?? []).length,
          item.type ? 1 : 0,
        );
        await connection.execute(`DROP VIEW ${owner}.${item.name}`);
        created.delete(item.name);
        await connection.execute(statement.slice(0, -1));
        created.add(item.name);
        const facts = await connection.execute<{
          READ_ONLY: string;
          CONSTRAINT_TYPE: string | null;
        }>(
          `SELECT v.read_only,c.constraint_type FROM all_views v LEFT JOIN all_constraints c
          ON c.owner=v.owner AND c.table_name=v.view_name AND c.constraint_type IN ('O','V')
          WHERE v.owner=:owner AND v.view_name=:name`,
          { owner, name: item.name },
          { outFormat: oracle.OUT_FORMAT_OBJECT },
        );
        assert.deepEqual(facts.rows, [
          { READ_ONLY: item.readOnly ? 'Y' : 'N', CONSTRAINT_TYPE: item.type },
        ]);
        const update = () =>
          connection.execute(`UPDATE ${owner}.${item.name} SET ID=-1`);
        if (item.type === 'O') await assert.rejects(update(), /ORA-42399/);
        else if (item.type === 'V') await assert.rejects(update(), /ORA-01402/);
        else assert.equal((await update()).rowsAffected, 1);
        await connection.rollback();
      }
    } finally {
      try {
        for (const name of created)
          await connection.execute(`DROP VIEW ${owner}.${name}`);
        if (tableCreated)
          await connection.execute(`DROP TABLE ${owner}.${table} PURGE`);
      } finally {
        await connection.close();
      }
    }
  },
);

test('restricted ALL catalog sessions have only explicit grants and reject hidden dependencies', async () => {
  const connectString =
    process.env.ORACLE_SOURCE_DSN ?? (await publishedDsn('oracle-source'));
  for (const user of ['SCHEMA_READER', 'LIMITED_READER']) {
    const connection = await oracle.getConnection({
      user: `SYSTEM[${user}]`,
      password,
      connectString,
    });
    try {
      const rows = async (sql: string) =>
        (
          await connection.execute(
            sql,
            {},
            {
              outFormat: oracle.OUT_FORMAT_ARRAY,
            },
          )
        ).rows;
      assert.deepEqual(
        await rows('SELECT privilege FROM session_privs ORDER BY privilege'),
        [['CREATE SESSION']],
      );
      assert.deepEqual(await rows('SELECT role FROM session_roles'), []);
      assert.deepEqual(
        await rows(
          'SELECT DISTINCT privilege FROM user_tab_privs WHERE grantee=USER',
        ),
        [['SELECT']],
      );
      await assert.rejects(
        connection.execute('SELECT COUNT(*) FROM dba_tables'),
        /ORA-00942/,
      );
      if (user === 'LIMITED_READER') {
        const catalog = new OracleCatalog(connection);
        await assert.rejects(
          extractSource(catalog, {
            version: 2,
            tables: [{ owner: 'IAM', name: 'ORG_UNITS' }],
            views: [],
          }),
          /CATALOG_(?:INCOMPLETE_METADATA|CARDINALITY)/,
        );
        await assert.rejects(
          extractSource(catalog, {
            version: 2,
            tables: [],
            views: [{ owner: 'COMMERCE', name: 'OPEN_ORDERS' }],
          }),
          /CATALOG_(?:INCOMPLETE_METADATA|CARDINALITY)/,
        );
      }
    } finally {
      await connection.close();
    }
  }
});

test(
  'bounded catalog batches match single-member extraction of the live multi-owner selection',
  { timeout: 120_000 },
  async () => {
    const dsn =
      process.env.ORACLE_SOURCE_DSN ?? (await publishedDsn('oracle-source'));
    const connection = await oracle.getConnection({
      user: 'SYSTEM[SCHEMA_READER]',
      password,
      connectString: dsn,
    });
    try {
      const selection = {
        version: 2 as const,
        tables: await selectedTables(dsn),
        views: selectedViews,
      };
      const counts: number[] = [];
      const documents = [];
      for (const size of [1, 32]) {
        let queries = 0;
        const progress = new ExtractionProgress((event) => {
          if (event.stage === 'query' && event.event === 'complete') queries++;
        });
        const { extractedAt: _, ...document } = await extractSource(
          new OracleCatalog(connection, 'all', progress, size),
          selection,
          progress,
        );
        documents.push(document);
        counts.push(queries);
      }
      assert.deepEqual(documents[1], documents[0]);
      assert.ok(
        counts[1] < counts[0],
        `Expected fewer queries: ${counts.join(' -> ')}`,
      );
    } finally {
      await connection.close();
    }
  },
);
