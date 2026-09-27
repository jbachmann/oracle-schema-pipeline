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
    'foreignKeys:CHILD',
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
      tables: [],
      views: [view.reference, view.reference],
    },
    progress,
  );

  assert.deepEqual(source.views[0].dependencies, view.dependencies);
  assert.deepEqual(callsAtViewCompletion, ['view:ROOT']);
  assert.equal(source.views.length, 1);
  assert.equal(source.tables.length, 1);
  assert.equal(source.tables[0].role, 'view-dependency');
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

test('explicit targets outrank parents and parents outrank view-only dependencies', async () => {
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
    tables: [child.reference, child.reference],
    views: [catalog.views[0].reference],
  });

  assert.deepEqual(
    source.tables.map(({ reference, role }) => [reference.name, role]),
    [
      ['BASE', 'view-dependency'],
      ['CHILD', 'target'],
      ['PARENT', 'direct-parent'],
    ],
  );
  assert.deepEqual(
    catalog.calls.filter((call) => call.startsWith('foreignKeys:')),
    ['foreignKeys:CHILD'],
  );
  assert.deepEqual(
    catalog.calls.filter((call) => call.startsWith('table:')),
    ['table:BASE', 'table:CHILD', 'table:PARENT'],
  );
});
