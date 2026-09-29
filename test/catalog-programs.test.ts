import { test } from 'node:test';
import assert from 'node:assert/strict';
import oracle, { type Connection } from 'oracledb';
import { OracleCatalog } from '../src/catalog.js';
import { ExtractionProgress, type ProgressEvent } from '../src/progress.js';
const reference = { owner: 'Owner "é', name: 'P & one' };
const object = (type: string) => ({
  OBJECT_TYPE: type,
  STATUS: 'VALID',
  ORACLE_MAINTAINED: 'N',
  SHARING: 'NONE',
});
const ddl = `\nCREATE PACKAGE "Owner ""é"."P & one" AS\n${'-- é\n'.repeat(10000)}END;\n/\n`;

function fake(
  options: {
    objects?: readonly object[];
    ddl?: unknown;
    failFetch?: boolean;
    complete?: boolean;
    failTransform?: boolean;
    dependency?: object;
    failExecute?: boolean;
  } = {},
) {
  const calls: {
    sql: string;
    binds: Record<string, string>;
    options: oracle.ExecuteOptions;
  }[] = [];
  let closes = 0,
    active = false;
  const connection = {
    async execute(
      sql: string,
      binds: Record<string, string> = {},
      execution: oracle.ExecuteOptions = {},
    ) {
      assert.equal(active, false, 'Queries must finish sequentially');
      calls.push({ sql, binds, options: execution });
      if (options.failExecute) throw new Error('private SQL credential marker');
      if (sql.startsWith('BEGIN')) {
        if (options.failTransform && sql.includes('SQLTERMINATOR'))
          throw new Error('private transform marker');
        return {};
      }
      active = true;
      const isDdl = sql.includes('GET_DDL');
      let rows: readonly unknown[] = isDdl
        ? [{ DDL: options.ddl === undefined ? ddl : options.ddl }]
        : sql.includes('AS complete')
          ? options.complete === false
            ? []
            : [{ COMPLETE: 1 }]
          : sql.includes('FROM all_objects')
            ? (options.objects ?? [object('PACKAGE'), object('PACKAGE BODY')])
            : options.dependency
              ? [options.dependency]
              : [];
      return {
        resultSet: {
          async getRows() {
            if (isDdl && options.failFetch)
              throw new Error('private partial CLOB marker');
            const result = rows;
            rows = [];
            return result;
          },
          async close() {
            closes++;
            active = false;
          },
        },
      };
    },
  } as unknown as Connection;
  return { connection, calls, closes: () => closes };
}

test('program reads preserve complete CLOBs, bound identifiers, transforms and progress categories', async () => {
  const transport = fake(),
    events: ProgressEvent[] = [];
  const program = await new OracleCatalog(
    transport.connection,
    'all',
    new ExtractionProgress((event) => events.push(event)),
  ).program(reference, 'PACKAGE');
  assert.deepEqual(
    program.units.map((unit) => unit.type),
    ['PACKAGE_SPEC', 'PACKAGE_BODY'],
  );
  assert.equal(program.units[0].ddl, ddl);
  const queries = transport.calls.filter((call) =>
    call.sql.includes('GET_DDL'),
  );
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0].binds, {
    unit: 'PACKAGE_SPEC',
    name: reference.name,
    owner: reference.owner,
  });
  assert.deepEqual(queries[0].options.fetchInfo, {
    DDL: { type: oracle.STRING },
  });
  assert.ok(
    transport.calls.every((call) => !call.sql.includes(reference.name)),
  );
  assert.ok(transport.calls.at(-1)!.sql.includes("'DEFAULT', TRUE"));
  assert.equal(
    transport.closes(),
    transport.calls.filter((call) => !call.sql.startsWith('BEGIN')).length,
  );
  assert.ok(events.some((event) => event.queryCategory === 'program-ddl'));
  assert.ok(
    events.some((event) => event.queryCategory === 'program-dependencies'),
  );
  assert.ok(!JSON.stringify(events).includes('CREATE PACKAGE'));
});

for (const [name, options, code] of [
  ['no visibility', { complete: false }, 'PROGRAM_METADATA_UNAVAILABLE'],
  [
    'wrong type',
    { objects: [object('FUNCTION')] },
    'PROGRAM_METADATA_UNAVAILABLE',
  ],
  ['missing', { objects: [] }, 'PROGRAM_METADATA_UNAVAILABLE'],
  [
    'duplicate unit',
    { objects: [object('PACKAGE'), object('PACKAGE')] },
    'CATALOG_CARDINALITY',
  ],
  ['missing ddl', { ddl: null }, 'PROGRAM_METADATA_UNAVAILABLE'],
  ['partial CLOB', { failFetch: true }, 'PROGRAM_METADATA_UNAVAILABLE'],
  [
    'transform failure',
    { failTransform: true },
    'PROGRAM_METADATA_UNAVAILABLE',
  ],
  ['driver failure', { failExecute: true }, 'PROGRAM_METADATA_UNAVAILABLE'],
  [
    'unknown status',
    { objects: [{ ...object('PACKAGE'), STATUS: 'UNKNOWN' }] },
    'CATALOG_UNKNOWN_VALUE',
  ],
  [
    'unknown platform flag',
    {
      dependency: {
        REFERENCED_OWNER: 'SYS',
        REFERENCED_NAME: 'STANDARD',
        REFERENCED_TYPE: 'PACKAGE',
        REFERENCED_LINK_NAME: null,
        ORACLE_MAINTAINED: null,
      },
    },
    'CATALOG_INCOMPLETE_METADATA',
  ],
] as const) {
  test(`program metadata rejects ${name} safely`, async () => {
    const transport = fake(options);
    await assert.rejects(
      new OracleCatalog(transport.connection).program(reference, 'PACKAGE'),
      (error) => {
        assert.match(String(error), new RegExp(code));
        assert.ok(!String(error).includes('private'));
        return true;
      },
    );
    if (options.failFetch || options.failTransform || 'ddl' in options)
      assert.ok(transport.calls.at(-1)!.sql.includes("'DEFAULT', TRUE"));
    if (options.failFetch) assert.equal(transport.closes(), 4);
  });
}

test('legitimate specification-only packages and platform dependencies remain explicit', async () => {
  const transport = fake({
    objects: [object('PACKAGE')],
    dependency: {
      REFERENCED_OWNER: 'SYS',
      REFERENCED_NAME: 'STANDARD',
      REFERENCED_TYPE: 'PACKAGE',
      REFERENCED_LINK_NAME: null,
      ORACLE_MAINTAINED: 'Y',
    },
  });
  const program = await new OracleCatalog(transport.connection).program(
    reference,
    'PACKAGE',
  );
  assert.equal(program.units.length, 1);
  assert.equal(program.units[0].dependencies[0].oracleMaintained, true);
});

test('runtime program kind allowlist prevents metadata reads for unrelated objects', async () => {
  const transport = fake();
  await assert.rejects(
    new OracleCatalog(transport.connection).program(
      reference,
      'TABLE' as never,
    ),
    /PROGRAM_METADATA_UNAVAILABLE/,
  );
  assert.equal(transport.calls.length, 0);
});
