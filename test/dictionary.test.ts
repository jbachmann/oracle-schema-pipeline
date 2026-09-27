import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  buildDictionaryWorkbook,
  createDictionaryBuffer,
  dictionarySheetOrder,
} from '../src/dictionary.js';
import { enabledState, sourceFixture } from './fixtures.js';

test('dictionary has fixed sheets, formatting, stable rows, and exact comments', async () => {
  const source = sourceFixture();
  source.tables[0]!.comment = 'Exact table\ncomment 😀';
  source.tables[0]!.columns[0]!.comment = '';
  source.tables[0]!.columns[1]!.comment = '=HYPERLINK("bad")';
  const workbook = buildDictionaryWorkbook(source);
  assert.deepEqual(
    workbook.worksheets.map((sheet) => sheet.name),
    dictionarySheetOrder,
  );
  const tables = workbook.getWorksheet('Tables')!,
    columns = workbook.getWorksheet('Columns')!;
  assert.equal(tables.views[0]?.state, 'frozen');
  assert.ok(tables.autoFilter);
  assert.equal(tables.getRow(2).getCell(1).value, 'APP');
  assert.equal(tables.getRow(2).getCell(4).value, 'Exact table\ncomment 😀');
  assert.equal(columns.getRow(2).getCell(6).value, '');
  assert.equal(columns.getRow(3).getCell(6).value, '=HYPERLINK("bad")');
  assert.equal(columns.getRow(3).getCell(6).type, ExcelJS.ValueType.String);
  assert.equal(columns.getRow(4).getCell(6).value, null);
  assert.equal(
    workbook.worksheets.some((sheet) => sheet.hasMerges),
    false,
  );
  const reloaded = new ExcelJS.Workbook();
  const bytes = await createDictionaryBuffer(source);
  await reloaded.xlsx.load(
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  assert.equal(
    reloaded.getWorksheet('Columns')!.getRow(2).getCell(6).value,
    '',
  );
  assert.equal(
    reloaded.getWorksheet('Columns')!.getRow(3).getCell(6).value,
    '=HYPERLINK("bad")',
  );
  assert.equal(
    reloaded.getWorksheet('Columns')!.getRow(3).getCell(6).type,
    ExcelJS.ValueType.String,
  );
});

test('composite constraint and index members retain one-based order', () => {
  const workbook = buildDictionaryWorkbook(sourceFixture());
  const constraints = workbook.getWorksheet('Constraints')!;
  assert.deepEqual(
    [
      constraints.getRow(2).getCell(6).value,
      constraints.getRow(3).getCell(6).value,
    ],
    [1, 2],
  );
  const indexes = workbook.getWorksheet('Indexes')!;
  assert.deepEqual(
    [indexes.getRow(2).getCell(11).value, indexes.getRow(3).getCell(11).value],
    [1, 2],
  );
});

test('all constraint kinds preserve complete rows and sorted member order', () => {
  const source = sourceFixture();
  const table = source.tables[0]!;
  source.tables = [table];
  table.constraints = [
    {
      kind: 'unique',
      name: 'UQ_CHILD',
      generatedName: false,
      columns: ['ID', 'TENANT_ID'],
      backingIndex: null,
      state: { ...enabledState },
    },
    {
      kind: 'primary-key',
      name: 'PK_CHILD',
      generatedName: false,
      columns: ['TENANT_ID', 'ID'],
      backingIndex: { owner: 'INDEX_OWNER', name: 'CHILD_PK_INDEX' },
      state: { ...enabledState },
    },
    {
      kind: 'not-null',
      name: 'NN_CHILD',
      generatedName: true,
      column: 'ID',
      state: { ...enabledState },
    },
    {
      kind: 'foreign-key',
      name: 'FK_CHILD',
      generatedName: false,
      parentTable: { owner: 'SHARED', name: 'PARENT' },
      parentConstraint: { owner: 'SHARED', name: 'PK_PARENT' },
      columnPairs: [
        { childColumn: 'TENANT_ID', parentColumn: 'PARENT_TENANT' },
        { childColumn: 'ID', parentColumn: 'PARENT_ID' },
      ],
      onDelete: 'CASCADE',
      state: {
        enabled: false,
        validated: true,
        deferrable: true,
        initiallyDeferred: false,
        rely: true,
      },
    },
    {
      kind: 'check',
      name: 'CK_CHILD',
      generatedName: false,
      expression: '"ID" > 0',
      state: {
        enabled: true,
        validated: false,
        deferrable: false,
        initiallyDeferred: true,
        rely: false,
      },
    },
  ];
  const originalSource = structuredClone(source);
  const sheet = buildDictionaryWorkbook(source).getWorksheet('Constraints')!;
  const rows = Array.from({ length: sheet.rowCount - 1 }, (_, rowIndex) =>
    Array.from(
      { length: sheet.columnCount },
      (_, columnIndex) =>
        sheet.getRow(rowIndex + 2).getCell(columnIndex + 1).value,
    ),
  );
  assert.deepEqual(rows, [
    [
      'APP',
      'CHILD',
      'CK_CHILD',
      'FALSE',
      'check',
      1,
      null,
      null,
      null,
      null,
      null,
      '"ID" > 0',
      null,
      null,
      null,
      'TRUE',
      'FALSE',
      'FALSE',
      'TRUE',
      'FALSE',
    ],
    [
      'APP',
      'CHILD',
      'FK_CHILD',
      'FALSE',
      'foreign-key',
      1,
      'TENANT_ID',
      'SHARED',
      'PARENT',
      'PK_PARENT',
      'PARENT_TENANT',
      null,
      'CASCADE',
      null,
      null,
      'FALSE',
      'TRUE',
      'TRUE',
      'FALSE',
      'TRUE',
    ],
    [
      'APP',
      'CHILD',
      'FK_CHILD',
      'FALSE',
      'foreign-key',
      2,
      'ID',
      'SHARED',
      'PARENT',
      'PK_PARENT',
      'PARENT_ID',
      null,
      'CASCADE',
      null,
      null,
      'FALSE',
      'TRUE',
      'TRUE',
      'FALSE',
      'TRUE',
    ],
    [
      'APP',
      'CHILD',
      'NN_CHILD',
      'TRUE',
      'not-null',
      1,
      'ID',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'TRUE',
      'TRUE',
      'FALSE',
      'FALSE',
      'FALSE',
    ],
    [
      'APP',
      'CHILD',
      'PK_CHILD',
      'FALSE',
      'primary-key',
      1,
      'TENANT_ID',
      null,
      null,
      null,
      null,
      null,
      null,
      'INDEX_OWNER',
      'CHILD_PK_INDEX',
      'TRUE',
      'TRUE',
      'FALSE',
      'FALSE',
      'FALSE',
    ],
    [
      'APP',
      'CHILD',
      'PK_CHILD',
      'FALSE',
      'primary-key',
      2,
      'ID',
      null,
      null,
      null,
      null,
      null,
      null,
      'INDEX_OWNER',
      'CHILD_PK_INDEX',
      'TRUE',
      'TRUE',
      'FALSE',
      'FALSE',
      'FALSE',
    ],
    [
      'APP',
      'CHILD',
      'UQ_CHILD',
      'FALSE',
      'unique',
      1,
      'ID',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'TRUE',
      'TRUE',
      'FALSE',
      'FALSE',
      'FALSE',
    ],
    [
      'APP',
      'CHILD',
      'UQ_CHILD',
      'FALSE',
      'unique',
      2,
      'TENANT_ID',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'TRUE',
      'TRUE',
      'FALSE',
      'FALSE',
      'FALSE',
    ],
  ]);
  assert.deepEqual(source, originalSource);
});

test('cell and line-feed limits reject without truncation', () => {
  const oversized = sourceFixture();
  oversized.tables[0]!.comment = 'x'.repeat(32_768);
  assert.throws(
    () => buildDictionaryWorkbook(oversized),
    /Workbook cell limit exceeded: Tables APP Comment has 32768 characters; maximum 32767\./,
  );
  const lines = sourceFixture();
  lines.tables[0]!.comment = '\n'.repeat(254);
  assert.throws(
    () => buildDictionaryWorkbook(lines),
    /Workbook line-feed limit exceeded: Tables APP Comment has 254 line feeds; maximum 253\./,
  );
});
