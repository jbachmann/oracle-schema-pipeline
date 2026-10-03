import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSource, type SourceCatalog } from '../src/extract.js';
import { objectKey, type ObjectReference } from '../src/model.js';
import { ExtractionProgress, type ProgressEvent } from '../src/progress.js';
import { fk, ordinaryTable, ordinaryView } from './fixtures.js';

class TestCatalog implements SourceCatalog {
  tables = [ordinaryTable('APP', 'CHILD')];
  views = [ordinaryView('ROOT')];
  calls: string[] = [];

  async databaseVersion() {
    this.calls.push('version');
    return '23';
  }

  async foreignKeys(reference: ObjectReference) {
    this.calls.push(`foreignKeys:${reference.name}`);
    return this.findTable(reference).constraints.filter(
      (constraint) => constraint.kind === 'foreign-key',
    );
  }

  async table(reference: ObjectReference) {
    this.calls.push(`table:${reference.name}`);
    return structuredClone(this.findTable(reference));
  }

  async prerequisites(reference: ObjectReference) {
    this.calls.push(`prerequisites:${reference.name}`);
    return [];
  }

  async view(reference: ObjectReference) {
    this.calls.push(`view:${reference.name}`);
    return structuredClone(this.findView(reference));
  }

  async viewDependencies(reference: ObjectReference) {
    this.calls.push(`viewDependencies:${reference.name}`);
    return structuredClone(this.findView(reference).dependencies);
  }

  private findTable(reference: ObjectReference) {
    const table = this.tables.find(
      (table) => objectKey(table.reference) === objectKey(reference),
    );
    assert.ok(table, `Unexpected table: ${objectKey(reference)}`);
    return table;
  }

  private findView(reference: ObjectReference) {
    const view = this.views.find(
      (view) => objectKey(view.reference) === objectKey(reference),
    );
    assert.ok(view, `Unexpected view: ${objectKey(reference)}`);
    return view;
  }
}

for (const missing of ['view', 'viewDependencies', 'both'] as const) {
  test(`selected views reject a catalog missing ${missing} before reading metadata`, async () => {
    const catalog = new TestCatalog();
    const sourceCatalog: SourceCatalog = catalog;
    if (missing !== 'viewDependencies') sourceCatalog.view = undefined;
    if (missing !== 'view') sourceCatalog.viewDependencies = undefined;
    const events: ProgressEvent[] = [];

    await assert.rejects(
      extractSource(
        sourceCatalog,
        { version: 2, tables: [], views: [catalog.views[0].reference] },
        new ExtractionProgress((event) => events.push(event)),
      ),
      { message: 'Catalog does not support views.' },
    );
    assert.deepEqual(catalog.calls, []);
    assert.deepEqual(
      events.map(({ stage, event }) => [stage, event]),
      [
        ['extract', 'start'],
        ['extract', 'failure'],
      ],
    );
  });
}

test('table-only catalogs extract tables without view capabilities', async () => {
  const catalog = new TestCatalog();
  const sourceCatalog: SourceCatalog = catalog;
  sourceCatalog.view = undefined;
  sourceCatalog.viewDependencies = undefined;

  const source = await extractSource(sourceCatalog, {
    version: 2,
    tables: [catalog.tables[0].reference],
    views: [],
  });

  assert.deepEqual(source.views, []);
  assert.equal(source.tables[0].role, 'target');
  assert.deepEqual(catalog.calls, [
    'table:CHILD',
    'prerequisites:CHILD',
    'version',
  ]);
});

test('view methods retain their catalog receiver and remote edges remain unfetched', async () => {
  const catalog = new TestCatalog();
  const view = catalog.views[0];
  view.dependencies = [
    {
      reference: catalog.tables[0].reference,
      type: 'TABLE',
      databaseLink: null,
    },
    {
      reference: { owner: 'REMOTE', name: 'TABLE' },
      type: 'TABLE',
      databaseLink: 'REMOTE_DB',
    },
    {
      reference: { owner: 'REMOTE', name: 'VIEW' },
      type: 'VIEW',
      databaseLink: 'REMOTE_DB',
    },
  ];
  const events: string[] = [];
  let callsAtViewCompletion: string[] = [];
  const progress = new ExtractionProgress(({ stage, event }) => {
    events.push(`${stage}:${event}`);
    if (stage === 'object' && event === 'complete' && events.length === 3) {
      callsAtViewCompletion = [...catalog.calls];
    }
  });
  const source = await extractSource(
    catalog,
    {
      version: 2,
      tables: [catalog.tables[0].reference],
      views: [view.reference, view.reference],
    },
    progress,
  );

  assert.deepEqual(source.views[0].dependencies, view.dependencies);
  assert.deepEqual(callsAtViewCompletion, ['view:ROOT']);
  assert.equal(source.views.length, 1);
  assert.equal(source.tables.length, 1);
  assert.equal(source.tables[0].role, 'target');
  assert.deepEqual(catalog.calls, [
    'view:ROOT',
    'viewDependencies:ROOT',
    'table:CHILD',
    'prerequisites:CHILD',
    'version',
  ]);
  assert.deepEqual(events, [
    'extract:start',
    'object:start',
    'object:complete',
    'object:start',
    'object:complete',
    'extract:complete',
  ]);
});

test('every explicitly selected table has target role', async () => {
  const catalog = new TestCatalog();
  const child = catalog.tables[0];
  const parent = ordinaryTable('APP', 'PARENT');
  const base = ordinaryTable('APP', 'BASE');
  child.constraints.push(
    fk('SELF', child.reference),
    fk('PARENT', parent.reference),
  );
  catalog.tables.push(parent, base);
  catalog.views[0].dependencies = catalog.tables.map((table) => ({
    reference: table.reference,
    type: 'TABLE',
    databaseLink: null,
  }));

  const source = await extractSource(catalog, {
    version: 2,
    tables: [
      child.reference,
      child.reference,
      parent.reference,
      base.reference,
    ],
    views: [catalog.views[0].reference],
  });

  assert.deepEqual(
    source.tables.map(({ reference, role }) => [reference.name, role]),
    [
      ['BASE', 'target'],
      ['CHILD', 'target'],
      ['PARENT', 'target'],
    ],
  );
  assert.deepEqual(
    catalog.calls.filter((call) => call.startsWith('foreignKeys:')),
    [],
  );
  assert.deepEqual(
    catalog.calls.filter((call) => call.startsWith('table:')),
    ['table:BASE', 'table:CHILD', 'table:PARENT'],
  );
});

test('prefetch hooks preserve explicit scope, view cycles and remote boundaries', async () => {
  const createCatalog = () => {
    const catalog = new TestCatalog();
    const child = catalog.tables[0];
    const sibling = ordinaryTable('APP', 'SIBLING');
    const parent = ordinaryTable('APP', 'PARENT');
    const base = ordinaryTable('APP', 'BASE');
    child.constraints.push(fk('PARENT', parent.reference));
    sibling.constraints.push(fk('PARENT', parent.reference));
    parent.constraints.push(
      fk('GRANDPARENT', { owner: 'APP', name: 'UNSELECTED' }),
    );
    catalog.tables.push(parent, base, sibling);
    catalog.views = ['ROOT', 'A', 'B', 'SHARED', 'Z'].map(ordinaryView);
    const edge = (name: string) => ({
      reference: { owner: 'REPORTING', name },
      type: 'VIEW' as const,
      databaseLink: null,
    });
    catalog.views[0].dependencies = [edge('B'), edge('A')];
    catalog.views[1].dependencies = [edge('SHARED')];
    catalog.views[2].dependencies = [edge('SHARED')];
    catalog.views[3].dependencies = [
      edge('ROOT'),
      { reference: base.reference, type: 'TABLE', databaseLink: null },
    ];
    catalog.views[4].dependencies = [
      { reference: parent.reference, type: 'TABLE', databaseLink: null },
      { reference: child.reference, type: 'TABLE', databaseLink: null },
      {
        reference: { owner: 'REMOTE', name: 'NO_READ' },
        type: 'VIEW',
        databaseLink: 'LINK',
      },
    ];
    return catalog;
  };
  const fallback = createCatalog();
  const prefetched = createCatalog();
  const selection = {
    version: 2 as const,
    tables: [
      fallback.tables[0].reference,
      fallback.tables[3].reference,
      fallback.tables[1].reference,
      fallback.tables[2].reference,
      fallback.tables[0].reference,
    ],
    views: [fallback.views[0].reference, fallback.views[4].reference],
  };
  const requests = {
    tables: [] as ObjectReference[],
    views: [] as ObjectReference[],
    foreignKeys: [] as ObjectReference[],
  };
  const catalog: SourceCatalog = prefetched;
  catalog.prefetchTables = async function (references) {
    assert.equal(this, prefetched);
    requests.tables.push(...references);
  };
  catalog.prefetchViews = async function (references) {
    assert.equal(this, prefetched);
    requests.views.push(...references);
  };
  catalog.prefetchForeignKeys = async function (references) {
    assert.equal(this, prefetched);
    requests.foreignKeys.push(...references);
  };
  const before = await extractSource(fallback, selection);
  const after = await extractSource(catalog, selection);
  assert.deepEqual(
    { ...after, extractedAt: '' },
    { ...before, extractedAt: '' },
  );
  assert.deepEqual(prefetched.calls, fallback.calls);
  assert.deepEqual(
    requests.foreignKeys.map((ref) => ref.name),
    [],
  );
  assert.deepEqual(
    requests.tables.map((ref) => ref.name),
    ['BASE', 'CHILD', 'PARENT', 'SIBLING'],
  );
  assert.equal(requests.views.length, 5);
  assert.equal(new Set(requests.views.map(objectKey)).size, 5);
  assert.ok(!requests.views.some((ref) => ref.owner === 'REMOTE'));
  assert.deepEqual(
    after.tables.map(({ reference, role }) => [reference.name, role]),
    [
      ['BASE', 'target'],
      ['CHILD', 'target'],
      ['PARENT', 'target'],
      ['SIBLING', 'target'],
    ],
  );
});

for (const count of [1, 2, 3]) {
  test(`explicit selection of ${count} tables in a chain never expands table reads`, async () => {
    const catalog = new TestCatalog();
    const [a, b, c] = ['A', 'B', 'C'].map((name) => ordinaryTable('APP', name));
    a.constraints.push(fk('A_B', b.reference), fk('A_SELF', a.reference));
    b.constraints.push(fk('B_C', c.reference));
    c.unsupportedFeatures.push('Excluded unsupported parent must not be read');
    catalog.tables = [a, b, c];
    // Return catalog-owned definitions to detect accidental mutation.
    catalog.table = async (reference) => {
      catalog.calls.push(`table:${reference.name}`);
      return catalog.tables.find(
        (table) => objectKey(table.reference) === objectKey(reference),
      )!;
    };
    const original = structuredClone(catalog.tables);
    const requested = catalog.tables
      .slice(0, count)
      .map((table) => table.reference);
    const prefetches: ObjectReference[][] = [];
    const sourceCatalog: SourceCatalog = catalog;
    sourceCatalog.prefetchTables = async (refs) => {
      prefetches.push(refs);
    };
    sourceCatalog.prefetchForeignKeys = async () => {
      assert.fail('FK discovery is forbidden');
    };
    const source = await extractSource(sourceCatalog, {
      version: 2,
      tables: [...requested, requested[0]],
      views: [],
    });
    assert.deepEqual(source.targetTables, requested);
    assert.deepEqual(
      source.tables.map((table) => table.reference),
      requested,
    );
    assert.deepEqual(prefetches, [requested]);
    assert.deepEqual(catalog.tables, original);
    assert.ok(!catalog.calls.some((call) => call.startsWith('foreignKeys:')));
    assert.deepEqual(
      catalog.calls.filter((call) => call.startsWith('table:')),
      requested.map((ref) => `table:${ref.name}`),
    );
    assert.equal(source.diagnostics.length, count === 3 ? 0 : 1);
    const { transformSource, transformationReport } =
      await import('../src/transform.js');
    const { policySchema } = await import('../src/model.js');
    const { generateSql } = await import('../src/generate.js');
    const before = structuredClone(source);
    const target = transformSource(source, policySchema.parse({}));
    assert.deepEqual(source, before);
    assert.deepEqual(
      transformationReport(target).filter(
        (d) => d.code === 'OMIT_UNSELECTED_FK',
      ),
      source.diagnostics,
    );
    if (count < 3) {
      const sql = generateSql(target);
      assert.doesNotMatch(sql, /"APP"\."C"/);
      if (count === 1) assert.doesNotMatch(sql, /"APP"\."B"/);
      assert.match(sql, /A_SELF/);
    }
  });
}

test('selection uses exact owner and quoted name identity and never discovers incoming children', async () => {
  const catalog = new TestCatalog();
  const a = ordinaryTable('Odd"Owner', 'Same.Name');
  const b = ordinaryTable('Other', 'Same.Name');
  const child = ordinaryTable('Other', 'INCOMING');
  a.constraints.push(fk('EXTERNAL', b.reference));
  b.constraints.push(fk('BACK', a.reference));
  child.constraints.push(fk('INCOMING', a.reference));
  catalog.tables = [a, b, child];
  const source = await extractSource(catalog, {
    version: 2,
    tables: [a.reference],
    views: [],
  });
  assert.deepEqual(
    source.tables.map((t) => t.reference),
    [a.reference],
  );
  assert.equal(source.diagnostics.length, 1);
  assert.equal(
    source.diagnostics[0].object,
    '"Odd""Owner"."Same.Name"/EXTERNAL',
  );
  assert.ok(source.diagnostics[0].message.includes('"Other"."Same.Name"'));
  const cycle = await extractSource(catalog, {
    version: 2,
    tables: [b.reference, a.reference],
    views: [],
  });
  assert.equal(cycle.tables.length, 2);
  assert.equal(cycle.diagnostics.length, 0);
  assert.equal(
    cycle.tables
      .flatMap((t) => t.constraints)
      .filter((c) => c.kind === 'foreign-key').length,
    2,
  );
});

for (const transitive of [false, true]) {
  test(`${transitive ? 'transitive' : 'direct'} view base tables require explicit selection and expose a safe error code`, async () => {
    const catalog = new TestCatalog();
    const base = ordinaryView('BASE');
    const table = catalog.tables[0].reference;
    base.dependencies = [
      { reference: table, type: 'TABLE', databaseLink: null },
    ];
    if (transitive) {
      catalog.views[0].dependencies = [
        { reference: base.reference, type: 'VIEW', databaseLink: null },
      ];
      catalog.views.push(base);
    } else {
      catalog.views[0].dependencies = base.dependencies;
    }
    const events: ProgressEvent[] = [];
    const selection = {
      version: 2 as const,
      tables: [] as ObjectReference[],
      views: [catalog.views[0].reference],
    };
    await assert.rejects(
      extractSource(
        catalog,
        selection,
        new ExtractionProgress((event) => events.push(event)),
      ),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, 'UNSELECTED_VIEW_TABLE');
        assert.match(
          (error as Error).message,
          /requires unselected table "APP"\."CHILD"; add/,
        );
        return true;
      },
    );
    assert.equal(events.at(-1)?.errorCode, 'UNSELECTED_VIEW_TABLE');
    assert.ok(!catalog.calls.some((call) => call.startsWith('table:')));
    selection.tables.push(table);
    assert.equal((await extractSource(catalog, selection)).tables.length, 1);
  });
}

test('view-only selection without local tables succeeds', async () => {
  const catalog = new TestCatalog();
  const source = await extractSource(catalog, {
    version: 2,
    tables: [],
    views: [catalog.views[0].reference],
  });
  assert.deepEqual(source.tables, []);
  assert.equal(source.views.length, 1);
});
