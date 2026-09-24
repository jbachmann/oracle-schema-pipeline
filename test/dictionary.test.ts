import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  buildDictionaryWorkbook,
  createDictionaryBuffer,
  dictionarySheetOrder,
} from '../src/dictionary.js';
import { sourceFixture } from './fixtures.js';

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
