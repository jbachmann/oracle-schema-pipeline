import ExcelJS from 'exceljs';
import type { SourceDocument } from './model.js';

const MAX_ROWS = 1_048_576, MAX_CHARS = 32_767, MAX_LFS = 253;
export const dictionarySheetOrder = ['Metadata', 'Tables', 'Columns', 'Constraints', 'Indexes', 'Views',
  'View Dependencies', 'Prerequisites', 'Diagnostics'] as const;
type Value = string | number | null;
type Definition = { name: typeof dictionarySheetOrder[number]; headers: string[]; rows: Value[][]; long: string[] };
const yes = (value: boolean): string => value ? 'TRUE' : 'FALSE';
const cmp = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const key = (value: { reference: { owner: string; name: string } }): string =>
  `${value.reference.owner}.${value.reference.name}`;

function definitions(source: SourceDocument): Definition[] {
  const tables = [...source.tables].sort((a, b) => cmp(key(a), key(b)));
  const views = [...source.views].sort((a, b) => cmp(key(a), key(b)));
  const constraints = tables.flatMap(table => [...table.constraints].sort((a, b) => cmp(a.name, b.name)).flatMap(item => {
    const prefix: Value[] = [table.reference.owner, table.reference.name, item.name, yes(item.generatedName), item.kind];
    const row = (position: number, local: Value, parentOwner: Value, parentTable: Value, parentConstraint: Value,
      parentColumn: Value, expression: Value, deleteRule: Value, indexOwner: Value, indexName: Value): Value[] =>
      [...prefix, position, local, parentOwner, parentTable, parentConstraint, parentColumn, expression, deleteRule,
        indexOwner, indexName, yes(item.state.enabled), yes(item.state.validated), yes(item.state.deferrable),
        yes(item.state.initiallyDeferred), yes(item.state.rely)];
    if (item.kind === 'primary-key' || item.kind === 'unique') return item.columns.map((column, index) =>
      row(index + 1, column, null, null, null, null, null, null, item.backingIndex?.owner ?? null, item.backingIndex?.name ?? null));
    if (item.kind === 'foreign-key') return item.columnPairs.map((pair, index) => row(index + 1, pair.childColumn,
      item.parentTable.owner, item.parentTable.name, item.parentConstraint.name, pair.parentColumn, null, item.onDelete, null, null));
    if (item.kind === 'check') return [row(1, null, null, null, null, null, item.expression, null, null, null)];
    return [row(1, item.column, null, null, null, null, null, null, null, null)];
  }));
  return [
    { name: 'Metadata', headers: ['Property', 'Value'], long: [], rows: [
      ['Workbook format', 'Source data dictionary 1'], ['Source document format', source.formatVersion],
      ['Source kind', source.kind], ['Dialect', source.dialect], ['Source Oracle version', source.sourceVersion],
      ['Extraction timestamp', source.extractedAt], ['Target table count', source.targetTables.length],
      ['Target view count', source.targetViews.length], ['Included table count', source.tables.length],
      ['Included view count', source.views.length], ['Prerequisite count', source.prerequisites.length],
      ['Diagnostic count', source.diagnostics.length],
    ] },
    { name: 'Tables', headers: ['Owner', 'Table Name', 'Role', 'Comment', 'Source Tablespace', 'Source Compression',
      'Unsupported Features', 'Column Count', 'Constraint Count', 'Index Count'], long: ['Comment', 'Unsupported Features'],
      rows: tables.map(t => [t.reference.owner, t.reference.name, t.role, t.comment, t.sourcePhysical.tablespace,
        t.sourcePhysical.compression, [...t.unsupportedFeatures].sort(cmp).join('\n'), t.columns.length, t.constraints.length, t.indexes.length]) },
    { name: 'Columns', headers: ['Table Owner', 'Table Name', 'Table Role', 'Position', 'Column Name', 'Comment',
      'Datatype Owner', 'Datatype Name', 'Byte Length', 'Character Length', 'Length Semantics', 'Precision', 'Scale',
      'Nullable', 'Default Expression', 'Default On Null', 'Virtual', 'Invisible', 'Identity Generation', 'Identity Options',
      'Collation'], long: ['Comment', 'Default Expression', 'Identity Options'], rows: tables.flatMap(t =>
        [...t.columns].sort((a, b) => a.position - b.position || cmp(a.name, b.name)).map(c => [t.reference.owner,
          t.reference.name, t.role, c.position, c.name, c.comment, c.dataType.owner, c.dataType.name, c.dataType.byteLength,
          c.dataType.characterLength, c.dataType.lengthSemantics, c.dataType.precision, c.dataType.scale, yes(c.nullable),
          c.defaultExpression, yes(c.defaultOnNull), yes(c.virtual), yes(c.invisible), c.identity?.generation ?? null,
          c.identity?.options ?? null, c.collation])) },
    { name: 'Constraints', headers: ['Table Owner', 'Table Name', 'Constraint Name', 'Generated Name', 'Kind',
      'Member Position', 'Child/Local Column', 'Parent Owner', 'Parent Table', 'Parent Constraint', 'Parent Column',
      'Check Expression', 'Delete Rule', 'Backing Index Owner', 'Backing Index Name', 'Enabled', 'Validated', 'Deferrable',
      'Initially Deferred', 'Rely'], long: ['Check Expression'], rows: constraints },
    { name: 'Indexes', headers: ['Table Owner', 'Table Name', 'Index Owner', 'Index Name', 'Type', 'Unique', 'Visible',
      'Status', 'Partitioned', 'Compression', 'Key Position', 'Column', 'Expression', 'Direction'], long: ['Expression'],
      rows: tables.flatMap(t => [...t.indexes].sort((a, b) => cmp(key(a), key(b))).flatMap(i => i.keys.map((k, p) =>
        [t.reference.owner, t.reference.name, i.reference.owner, i.reference.name, i.type, yes(i.unique), yes(i.visible),
          i.status, yes(i.partitioned), i.compression, p + 1, k.column, k.expression, k.direction]))) },
    { name: 'Views', headers: ['Owner', 'View Name', 'Role', 'Columns', 'Query', 'Read Only', 'Check Option', 'Bequeath',
      'Status', 'Collation', 'Editioning', 'Typed', 'Superview', 'Container Data', 'Unsupported Features'],
      long: ['Columns', 'Query', 'Unsupported Features'], rows: views.map(v => [v.reference.owner, v.reference.name, v.role,
        v.columns.join('\n'), v.query, yes(v.readOnly), v.checkOption, v.bequeath, v.status, v.collation, yes(v.editioning),
        yes(v.typed), yes(v.superview), yes(v.containerData), [...v.unsupportedFeatures].sort(cmp).join('\n')]) },
    { name: 'View Dependencies', headers: ['View Owner', 'View Name', 'View Role', 'Dependency Position',
      'Dependency Owner', 'Dependency Name', 'Dependency Type', 'Database Link'], long: [], rows: views.flatMap(v =>
        v.dependencies.map((d, p) => [v.reference.owner, v.reference.name, v.role, p + 1, d.reference.owner,
          d.reference.name, d.type, d.databaseLink])) },
    { name: 'Prerequisites', headers: ['Required By Owner', 'Required By Name', 'Referenced Owner', 'Referenced Name',
      'Type', 'Database Link'], long: [], rows: [...source.prerequisites].sort((a, b) => cmp(
        `${a.requiredBy.owner}.${a.requiredBy.name}.${a.reference.owner}.${a.reference.name}.${a.type}`,
        `${b.requiredBy.owner}.${b.requiredBy.name}.${b.reference.owner}.${b.reference.name}.${b.type}`))
      .map(p => [p.requiredBy.owner, p.requiredBy.name, p.reference.owner, p.reference.name, p.type, p.databaseLink]) },
    { name: 'Diagnostics', headers: ['Severity', 'Code', 'Object', 'Message'], long: ['Message'],
      rows: [...source.diagnostics].sort((a, b) => cmp(`${a.severity}.${a.code}.${a.object}.${a.message}`,
        `${b.severity}.${b.code}.${b.object}.${b.message}`)).map(d => [d.severity, d.code, d.object, d.message]) },
  ];
}

function validate(definition: Definition): void {
  const count = definition.rows.length + 1;
  if (count > MAX_ROWS) throw new Error(`Workbook row limit exceeded: ${definition.name} requires ${count} rows; maximum ${MAX_ROWS}.`);
  definition.rows.forEach((row, r) => row.forEach((value, c) => {
    if (typeof value !== 'string') return;
    const object = String(row[0] ?? `row ${r + 2}`), field = definition.headers[c]!;
    if (value.length > MAX_CHARS) throw new Error(`Workbook cell limit exceeded: ${definition.name} ${object} ${field} has ${value.length} characters; maximum ${MAX_CHARS}.`);
    const lineFeeds = value.split('\n').length - 1;
    if (lineFeeds > MAX_LFS) throw new Error(`Workbook line-feed limit exceeded: ${definition.name} ${object} ${field} has ${lineFeeds} line feeds; maximum ${MAX_LFS}.`);
  }));
}

export function buildDictionaryWorkbook(source: SourceDocument): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook(), timestamp = new Date(source.extractedAt);
  workbook.creator = 'oracle-schema-pipeline'; workbook.title = 'Source Data Dictionary';
  workbook.created = timestamp; workbook.modified = timestamp;
  for (const definition of definitions(source)) {
    validate(definition);
    const sheet = workbook.addWorksheet(definition.name, { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.addRow(definition.headers); definition.rows.forEach(row => sheet.addRow(row));
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: definition.headers.length } };
    sheet.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    });
    definition.headers.forEach((header, index) => {
      const column = sheet.getColumn(index + 1);
      column.width = definition.long.includes(header) ? 48 : Math.min(24, Math.max(12, header.length + 2));
      if (definition.long.includes(header)) column.alignment = { wrapText: true, vertical: 'top' };
    });
    for (let row = 2; row <= sheet.rowCount; row++) {
      sheet.getRow(row).alignment = { vertical: 'top' };
      if (row % 2 === 0) sheet.getRow(row).eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F6FA' } };
      });
    }
  }
  return workbook;
}

export async function createDictionaryBuffer(source: SourceDocument): Promise<Buffer> {
  return Buffer.from(await buildDictionaryWorkbook(source).xlsx.writeBuffer());
}
