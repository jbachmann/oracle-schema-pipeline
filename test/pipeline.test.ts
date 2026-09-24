import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSource, type SourceCatalog } from '../src/extract.js';
import { transformSource, transformationReport } from '../src/transform.js';
import { generateSql } from '../src/generate.js';
import { validateTarget } from '../src/validate.js';
import {
  objectKey,
  qualifiedName,
  sourceDocumentSchema,
  targetDocumentSchema,
  policySchema,
} from '../src/model.js';
import { renderDataType } from '../src/types.js';
import {
  sourceFixture,
  ordinaryView,
  ordinaryTable,
  fk,
  numberColumn,
  enabledState,
} from './fixtures.js';

const hasError = (target: unknown, code: string) =>
  validateTarget(target).some(
    (item) => item.code === code && item.severity === 'error',
  );
test('one-hop extraction captures parent FK facts but never fetches grandparent table', async () => {
  const fixture = sourceFixture(),
    fetched: string[] = [],
    rootLookups: string[] = [];
  const catalog: SourceCatalog = {
    async databaseVersion() {
      return '19';
    },
    async foreignKeys(reference) {
      rootLookups.push(reference.name);
      return fixture.tables
        .find((table) => objectKey(table.reference) === objectKey(reference))!
        .constraints.filter((constraint) => constraint.kind === 'foreign-key');
    },
    async table(reference) {
      fetched.push(reference.name);
      return structuredClone(
        fixture.tables.find(
          (table) => objectKey(table.reference) === objectKey(reference),
        )!,
      );
    },
    async prerequisites() {
      return [];
    },
  };
  const source = await extractSource(catalog, {
    version: 2,
    tables: fixture.targetTables,
    views: [],
  });
  assert.deepEqual(rootLookups, ['CHILD']);
  assert.deepEqual(fetched, ['CHILD', 'PARENT']);
  assert.ok(
    source.tables[1].constraints.some(
      (constraint) => constraint.name === 'FK_PARENT_GRANDPARENT',
    ),
  );
});
test('transformation removes only parent-origin FKs and does not mutate source', () => {
  const source = sourceFixture(),
    before = JSON.stringify(source),
    target = transformSource(source);
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(
    target.tables.flatMap((table) =>
      table.constraints
        .filter((constraint) => constraint.kind === 'foreign-key')
        .map((constraint) => constraint.name),
    ),
    ['FK_CHILD_PARENT'],
  );
  assert.ok(
    transformationReport(target).some((item) => item.code === 'OMIT_PARENT_FK'),
  );
  assert.equal(
    validateTarget(target).filter((item) => item.severity === 'error').length,
    0,
  );
});
test('explicit second target retains its FK and requires its direct parent definition', () => {
  const source = sourceFixture();
  source.targetTables.push(source.tables[1].reference);
  const grandparent = ordinaryTable('OTHER', 'GRANDPARENT');
  grandparent.role = 'direct-parent';
  source.tables.push(grandparent);
  const target = transformSource(source);
  assert.equal(validateTarget(target).length, 0);
  assert.ok(generateSql(target).includes('FK_PARENT_GRANDPARENT'));
});
test('generation orders all tables, indexes, candidate keys and FKs; composite order preserved', () => {
  const sql = generateSql(transformSource(sourceFixture()));
  assert.ok(
    sql.lastIndexOf('CREATE TABLE') < sql.indexOf('CREATE UNIQUE INDEX'),
  );
  assert.ok(
    sql.lastIndexOf('CREATE UNIQUE INDEX') < sql.indexOf('ADD CONSTRAINT "PK_'),
  );
  assert.ok(sql.lastIndexOf('PRIMARY KEY') < sql.indexOf('FOREIGN KEY'));
  assert.ok(
    sql.includes(
      'FOREIGN KEY ("TENANT_ID", "ID") REFERENCES "SHARED"."PARENT" ("TENANT_ID", "ID")',
    ),
  );
  assert.equal(
    (sql.match(/CREATE UNIQUE INDEX "SHARED"\."PK_PARENT"/g) ?? []).length,
    1,
  );
  assert.ok(sql.includes('USING INDEX "SHARED"."PK_PARENT"'));
  assert.ok(sql.includes('GRANT REFERENCES ON "SHARED"."PARENT" TO "APP";'));
  assert.ok(!sql.includes('GRANDPARENT'));
  assert.ok(!sql.includes('PROD_DATA'));
  assert.ok(!sql.includes('STORAGE ('));
});
test('runtime validation rejects unknown fields and format versions', () => {
  assert.throws(() =>
    sourceDocumentSchema.parse({ ...sourceFixture(), formatVersion: 2 }),
  );
  assert.throws(() =>
    sourceDocumentSchema.parse({ ...sourceFixture(), formatVersion: 999 }),
  );
  assert.throws(() =>
    sourceDocumentSchema.parse({ ...sourceFixture(), typo: true }),
  );
  assert.throws(() => targetDocumentSchema.parse(sourceFixture()));
});
test('comments pass through and render exactly before indexes', () => {
  const source = sourceFixture();
  source.tables[0].comment = "Customer's orders & returns Ω";
  source.tables[0].columns[0].comment = 'first line\nsecond line';
  const target = transformSource(source);
  assert.equal(target.tables[0].comment, source.tables[0].comment);
  assert.equal(
    target.tables[0].columns[0].comment,
    source.tables[0].columns[0].comment,
  );
  const sql = generateSql(target);
  assert.ok(sql.includes("UNISTR('\\03A9')"));
  assert.ok(sql.includes('EXECUTE IMMEDIATE'));
  assert.ok(sql.includes('CHR(10)'));
  assert.ok(
    sql.indexOf('COMMENT ON TABLE') < sql.indexOf('CREATE UNIQUE INDEX'),
  );
  assert.ok(
    sql.split('\n').every((line) => Buffer.byteLength(line, 'utf8') <= 2400),
  );
});
test('null comments are omitted and long comments use bounded dynamic DDL', () => {
  const target = transformSource(sourceFixture());
  target.tables[0].comment = 'x'.repeat(3999);
  const sql = generateSql(target);
  assert.ok(sql.includes('EXECUTE IMMEDIATE'));
  assert.ok(!sql.includes('COMMENT ON TABLE "SHARED"."PARENT"'));
  assert.ok(
    sql.split('\n').every((line) => Buffer.byteLength(line, 'utf8') <= 2400),
  );
});
test('missing parent or mismatched ordered parent key blocks SQL', () => {
  const target = transformSource(sourceFixture());
  target.tables.pop();
  assert.ok(hasError(target, 'MISSING_PARENT'));
  assert.throws(() => generateSql(target), /MISSING_PARENT/);
  const mismatch = transformSource(sourceFixture());
  const foreignKey = mismatch.tables[0].constraints.find(
    (constraint) => constraint.kind === 'foreign-key',
  )!;
  if (foreignKey.kind === 'foreign-key') foreignKey.columnPairs.reverse();
  assert.ok(hasError(mismatch, 'MISSING_PARENT_KEY'));
});
test('parent-only FKs cannot be restored manually without validation failure', () => {
  const target = transformSource(sourceFixture());
  target.tables[1].constraints.push(fk('FK_BACK', target.tables[0].reference));
  assert.ok(hasError(target, 'PARENT_FK_RETAINED'));
});
test('missing backing indexes and duplicate schema constraint names are rejected', () => {
  const target = transformSource(sourceFixture());
  target.tables[0].indexes = [];
  assert.ok(hasError(target, 'MISSING_BACKING_INDEX'));
  target.tables[0].constraints.push(
    structuredClone(target.tables[0].constraints[0]),
  );
  assert.ok(hasError(target, 'DUPLICATE_CONSTRAINT'));
});
test('deferrable FK, delete action, disabled and validation state survive generation', () => {
  const target = transformSource(sourceFixture());
  const constraint = target.tables[0].constraints.find(
    (constraint) => constraint.kind === 'foreign-key',
  )!;
  if (constraint.kind === 'foreign-key') {
    constraint.onDelete = 'SET NULL';
    constraint.state = {
      enabled: false,
      validated: false,
      deferrable: true,
      initiallyDeferred: true,
      rely: true,
    };
  }
  assert.ok(
    generateSql(target).includes(
      'ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED RELY DISABLE NOVALIDATE',
    ),
  );
});
test('defaults and named not-null constraints are emitted once, including DEFAULT ON NULL', () => {
  const target = transformSource(sourceFixture()),
    table = target.tables[0],
    column = numberColumn('VALUE', 3);
  column.defaultExpression = '42';
  column.defaultOnNull = true;
  table.columns.push(column);
  table.constraints.push({
    kind: 'not-null',
    name: 'NN_VALUE',
    column: 'VALUE',
    generatedName: false,
    state: { ...enabledState },
  });
  const sql = generateSql(target);
  assert.equal((sql.match(/CONSTRAINT "NN_VALUE"/g) ?? []).length, 1);
  assert.ok(sql.includes('DEFAULT ON NULL 42 CONSTRAINT "NN_VALUE" NOT NULL'));
});
test('NUMBER negative scale and CHAR/BYTE semantics are preserved', () => {
  const policy = policySchema.parse({}),
    column = numberColumn('X', 1);
  column.dataType.precision = null;
  column.dataType.scale = -2;
  assert.equal(renderDataType(column, policy), 'NUMBER(*,-2)');
  column.dataType = {
    name: 'VARCHAR2',
    owner: null,
    byteLength: 400,
    characterLength: 100,
    lengthSemantics: 'CHAR',
    precision: null,
    scale: null,
  };
  assert.equal(renderDataType(column, policy), 'VARCHAR2(100 CHAR)');
  column.dataType.lengthSemantics = 'BYTE';
  assert.equal(renderDataType(column, policy), 'VARCHAR2(400 BYTE)');
});
test('unsupported identity, specialized tables and internal index expressions block generation', () => {
  const target = transformSource(sourceFixture());
  target.tables[0].columns[0].identity = {
    generation: 'ALWAYS',
    options: 'START WITH: 1',
  };
  target.tables[0].unsupportedFeatures.push('Partitioned table');
  target.tables[0].indexes[0].keys[0] = {
    column: null,
    expression: 'SYS_OP_DESCEND("TENANT_ID")',
    direction: 'DESC',
  };
  assert.ok(hasError(target, 'UNSUPPORTED_IDENTITY'));
  assert.ok(hasError(target, 'UNSUPPORTED_FEATURE'));
  assert.ok(hasError(target, 'INTERNAL_INDEX_EXPRESSION'));
  assert.throws(() => generateSql(target));
});
test('external prerequisites must be acknowledged and schemas preprovisioned', () => {
  const source = sourceFixture();
  source.prerequisites.push({
    requiredBy: source.tables[0].reference,
    reference: { owner: 'APP', name: 'NEXT_VALUE' },
    type: 'SEQUENCE',
    databaseLink: null,
  });
  assert.ok(hasError(transformSource(source), 'UNACKNOWLEDGED_PREREQUISITE'));
  const target = transformSource(source, {
    createSchemas: false,
    externalPrerequisites: [
      { reference: { owner: 'APP', name: 'NEXT_VALUE' }, type: 'SEQUENCE' },
    ],
  });
  assert.equal(validateTarget(target).length, 0);
  assert.ok(!generateSql(target).includes('CREATE USER'));
});
test('quoted identifiers and SQL fragments remain intact', () => {
  const source = sourceFixture();
  const column = numberColumn('Odd"Name', 3);
  column.nullable = true;
  column.defaultExpression = 'CASE WHEN 1=1 THEN 7 ELSE 9 END';
  source.tables[0].columns.push(column);
  source.tables[0].constraints.push({
    kind: 'check',
    name: 'CK_ODD',
    expression: '"Odd""Name" >= 0',
    generatedName: false,
    state: { ...enabledState },
  });
  const sql = generateSql(transformSource(source));
  assert.ok(sql.includes('"Odd""Name" NUMBER'));
  assert.ok(sql.includes(column.defaultExpression));
  assert.ok(sql.includes('CHECK ("Odd""Name" >= 0)'));
});
test('function indexes and virtual columns keep their expressions', () => {
  const target = transformSource(sourceFixture()),
    table = target.tables[0];
  const virtual = numberColumn('DOUBLE_ID', 3);
  virtual.virtual = true;
  virtual.nullable = true;
  virtual.defaultExpression = '"ID" * 2';
  table.columns.push(virtual);
  table.indexes.push({
    ...structuredClone(table.indexes[0]),
    reference: { owner: 'APP', name: 'IX_EXPRESSION' },
    unique: false,
    type: 'FUNCTION-BASED NORMAL',
    keys: [{ column: null, expression: 'ABS("ID")', direction: 'ASC' }],
  });
  const sql = generateSql(target);
  assert.ok(sql.includes('GENERATED ALWAYS AS ("ID" * 2) VIRTUAL'));
  assert.ok(sql.includes('(ABS("ID") ASC)'));
});
test('deterministic offline output and repeated JSON round trips', () => {
  const target = transformSource(JSON.parse(JSON.stringify(sourceFixture())));
  assert.equal(
    generateSql(target),
    generateSql(JSON.parse(JSON.stringify(target))),
  );
});

test('identity options preserve large numeric bounds and never emit the source sequence default', () => {
  const target = transformSource(sourceFixture()),
    column = target.tables[0].columns[1];
  column.identity = {
    generation: 'BY DEFAULT',
    options:
      'START WITH: 1, INCREMENT BY: 1, MAX_VALUE: 9999999999999999999999999999, MIN_VALUE: 1, CYCLE_FLAG: N, CACHE_SIZE: 20, ORDER_FLAG: N',
  };
  column.defaultOnNull = true;
  column.defaultExpression = '"APP"."ISEQ$$_123".nextval';
  const sql = generateSql(target);
  assert.ok(sql.includes('GENERATED BY DEFAULT ON NULL AS IDENTITY'));
  assert.ok(sql.includes('MAXVALUE 9999999999999999999999999999'));
  assert.ok(!sql.includes('ISEQ$$_123'));
});
test('dollar replacement patterns in quoted index names remain literal', () => {
  const target = transformSource(sourceFixture()),
    table = target.tables[0];
  table.indexes[0].reference.name = 'IX$&$1';
  const key = table.constraints.find(
    (constraint) => constraint.kind === 'primary-key',
  )!;
  if (key.kind === 'primary-key')
    key.backingIndex = { ...table.indexes[0].reference };
  assert.ok(
    generateSql(target).includes('USING INDEX "APP"."IX$&$1" ENABLE VALIDATE'),
  );
});

test('modeled view facts block generation independently of annotations', () => {
  const mutations: [string, (view: ReturnType<typeof ordinaryView>) => void][] =
    [
      ...(['editioning', 'typed', 'superview', 'containerData'] as const).map(
        (flag) =>
          [
            'UNSUPPORTED_VIEW',
            (view: ReturnType<typeof ordinaryView>) => {
              view[flag] = true;
            },
          ] as [string, (view: ReturnType<typeof ordinaryView>) => void],
      ),
      [
        'DUPLICATE_VIEW_COLUMN',
        (view) => {
          view.columns = ['ID', 'ID'];
        },
      ],
      [
        'UNSUPPORTED_COLLATION',
        (view) => {
          view.collation = 'BINARY_CI';
        },
      ],
      [
        'UNSUPPORTED_VIEW',
        (view) => {
          view.readOnly = true;
          view.checkOption = 'LOCAL';
        },
      ],
      [
        'OBJECT_NAME_COLLISION',
        (view) => {
          view.reference = { owner: 'APP', name: 'CHILD' };
        },
      ],
    ];
  for (const [code, mutate] of mutations) {
    const target = transformSource(sourceFixture()),
      view = ordinaryView('V');
    mutate(view);
    target.views = [view];
    target.targetViews = [view.reference];
    assert.ok(
      validateTarget(target).some(
        (d) => d.code === code && d.object === qualifiedName(view.reference),
      ),
      code,
    );
    assert.ok(
      transformationReport(target).some((d) => d.code === code),
      code,
    );
    assert.throws(() => generateSql(target), new RegExp(code));
  }
});

test('unreachable views and retained nonroot FKs cannot expand the closure', () => {
  const target = transformSource(sourceFixture()),
    view = ordinaryView('EXTRA');
  const extra = ordinaryTable('APP', 'EXTRA_TABLE');
  extra.role = 'view-dependency';
  view.role = 'dependency';
  view.dependencies = [
    { reference: extra.reference, type: 'TABLE', databaseLink: null },
  ];
  target.views.push(view);
  target.tables.push(extra);
  assert.ok(hasError(target, 'EXTRA_VIEW'));
  assert.ok(hasError(target, 'EXTRA_TABLE'));
  target.tables[1].constraints.push(fk('FK_EXTRA', extra.reference));
  assert.ok(hasError(target, 'EXTRA_TABLE'));
  assert.throws(() => generateSql(target), /EXTRA_VIEW/);
});

test('view diamonds, duplicate edges, mixed table roles and shuffles are deterministic', () => {
  const target = transformSource(sourceFixture());
  const views = ['ROOT', 'a', 'Z', 'BASE'].map(ordinaryView);
  for (const view of views.slice(1)) view.role = 'dependency';
  const edge = (view: (typeof views)[number]) => ({
    reference: view.reference,
    type: 'VIEW',
    databaseLink: null,
  });
  views[0].dependencies = [edge(views[1]), edge(views[2]), edge(views[1])];
  views[1].dependencies = [edge(views[3])];
  views[2].dependencies = [edge(views[3])];
  views[3].dependencies = target.tables.map((t) => ({
    reference: t.reference,
    type: 'TABLE',
    databaseLink: null,
  }));
  target.views = views;
  target.targetViews = [views[0].reference];
  assert.deepEqual(validateTarget(target), []);
  const sql = generateSql(target);
  assert.ok(
    sql.indexOf('CREATE VIEW "REPORTING"."Z"') <
      sql.indexOf('CREATE VIEW "REPORTING"."a"'),
  );
  target.tables.reverse();
  for (const table of target.tables) {
    table.columns.reverse();
    table.indexes.reverse();
    table.constraints.reverse();
  }
  target.views.reverse();
  for (const view of target.views) view.dependencies.reverse();
  assert.equal(generateSql(target), sql);
  target.tables.find((t) => t.role === 'direct-parent')!.role =
    'view-dependency';
  assert.ok(hasError(target, 'ROLE_MISMATCH'));
});

test('missing roots, missing view edges and cycles remain blocking', () => {
  const target = transformSource(sourceFixture()),
    view = ordinaryView('V');
  target.targetViews = [view.reference];
  assert.ok(hasError(target, 'MISSING_TARGET'));
  target.views = [view];
  view.dependencies = [
    {
      reference: { owner: 'REPORTING', name: 'ABSENT' },
      type: 'VIEW',
      databaseLink: null,
    },
  ];
  assert.ok(hasError(target, 'MISSING_VIEW_DEPENDENCY'));
  view.dependencies[0].reference = view.reference;
  assert.ok(hasError(target, 'VIEW_DEPENDENCY_CYCLE'));
  assert.throws(() => generateSql(target), /VIEW_DEPENDENCY_CYCLE/);
});

test('timestamp precision boundaries and inconsistent metadata are checked before rendering', () => {
  for (const scale of [-1, 0, 9, 10, 99]) {
    const target = transformSource(sourceFixture()),
      column = numberColumn('TS', 3);
    column.nullable = true;
    column.dataType.name = 'TIMESTAMP';
    column.dataType.scale = scale;
    target.tables[0].columns.push(column);
    if (scale === 0 || scale === 9) {
      assert.deepEqual(validateTarget(target), []);
      assert.ok(generateSql(target).includes(`TIMESTAMP(${scale})`));
    } else {
      assert.ok(
        validateTarget(target).some(
          (d) => d.code === 'UNSUPPORTED_TYPE' && d.object.endsWith('.TS'),
        ),
      );
      assert.throws(() => generateSql(target), /UNSUPPORTED_TYPE/);
    }
  }
  const column = numberColumn('TS', 1);
  column.dataType.name = 'TIMESTAMP(6)';
  column.dataType.scale = 9;
  assert.throws(() => renderDataType(column, policySchema.parse({})), /agree/);
});

test('view-only table dependencies are accepted without expanding their foreign keys', () => {
  const source = sourceFixture(),
    view = ordinaryView('V');
  source.targetTables = [];
  source.targetViews = [view.reference];
  source.views = [view];
  source.tables = [source.tables[1]];
  source.tables[0].role = 'view-dependency';
  view.dependencies = [
    {
      reference: source.tables[0].reference,
      type: 'TABLE',
      databaseLink: null,
    },
  ];
  const target = transformSource(source);
  assert.deepEqual(validateTarget(target), []);
  assert.ok(!generateSql(target).includes('GRANDPARENT'));
  target.views[0].dependencies[0].databaseLink = 'REMOTE';
  assert.ok(hasError(target, 'REMOTE_VIEW_DEPENDENCY'));
  assert.ok(hasError(target, 'EXTRA_TABLE'));
});

test('CLI rejects an invalid target before creating SQL', async () => {
  const { mkdtemp, writeFile, access, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const directory = await mkdtemp(join(tmpdir(), 'semantic-validation-'));
  try {
    const target = transformSource(sourceFixture());
    const view = ordinaryView('UNRELATED');
    view.role = 'dependency';
    target.views.push(view);
    const input = join(directory, 'target.json'),
      output = join(directory, 'clone.sql');
    await writeFile(input, JSON.stringify(target));
    await assert.rejects(
      promisify(execFile)(process.execPath, [
        '--import',
        'tsx',
        'src/cli.ts',
        'generate',
        '--input',
        input,
        '--output',
        output,
      ]),
      /EXTRA_VIEW/,
    );
    await assert.rejects(access(output), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('v4 view text owns restriction syntax and v3 requires re-extraction', () => {
  const source = sourceFixture();
  for (const restriction of ['READ ONLY', 'CHECK OPTION']) {
    const view = ordinaryView('RESTRICTED');
    view.query += ` WITH ${restriction}`;
    view.readOnly = restriction === 'READ ONLY';
    view.checkOption = restriction === 'CHECK OPTION' ? 'CASCADED' : 'NONE';
    source.views = [view];
    source.targetViews = [view.reference];
    const target = transformSource(source);
    assert.equal(
      generateSql(target).split(`WITH ${restriction}`).length - 1,
      1,
    );
    assert.throws(
      () => sourceDocumentSchema.parse({ ...source, formatVersion: 3 }),
      /re-extract/,
    );
    assert.throws(
      () => targetDocumentSchema.parse({ ...target, formatVersion: 3 }),
      /re-extract/,
    );
    assert.throws(
      () => generateSql({ ...target, formatVersion: 3 }),
      /re-extract/,
    );
  }
});
