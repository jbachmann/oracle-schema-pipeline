import ExcelJS from 'exceljs';
import type {
  ForeignKeyDefinition,
  SourceDocument,
  TableDefinition,
} from './model.js';

const MAX_ROWS = 1_048_576;
const MAX_CHARS = 32_767;
const MAX_CELL_LINE_FEEDS = 253;
export const dictionarySheetOrder = [
  'Metadata',
  'Tables',
  'Columns',
  'Constraints',
  'Indexes',
  'Views',
  'View Dependencies',
  'Prerequisites',
  'Diagnostics',
] as const;
type CellValue = string | number | null;
type SheetDefinition = {
  name: (typeof dictionarySheetOrder)[number];
  headers: string[];
  rows: CellValue[][];
  wrappedHeaders: string[];
};
const booleanText = (value: boolean): string => (value ? 'TRUE' : 'FALSE');
const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
const referenceKey = (value: {
  reference: { owner: string; name: string };
}): string => `${value.reference.owner}.${value.reference.name}`;

type ConstraintMember = {
  position: number;
  localColumn?: string;
  parentOwner?: string;
  parentTable?: string;
  parentConstraint?: string;
  parentColumn?: string;
  expression?: string;
  deleteRule?: ForeignKeyDefinition['onDelete'];
  indexOwner?: string;
  indexName?: string;
};

function buildConstraintRows(table: TableDefinition): CellValue[][] {
  return [...table.constraints]
    .sort((a, b) => compareText(a.name, b.name))
    .flatMap((constraint) => {
      const constraintRow = (member: ConstraintMember): CellValue[] => [
        table.reference.owner,
        table.reference.name,
        constraint.name,
        booleanText(constraint.generatedName),
        constraint.kind,
        member.position,
        member.localColumn ?? null,
        member.parentOwner ?? null,
        member.parentTable ?? null,
        member.parentConstraint ?? null,
        member.parentColumn ?? null,
        member.expression ?? null,
        member.deleteRule ?? null,
        member.indexOwner ?? null,
        member.indexName ?? null,
        booleanText(constraint.state.enabled),
        booleanText(constraint.state.validated),
        booleanText(constraint.state.deferrable),
        booleanText(constraint.state.initiallyDeferred),
        booleanText(constraint.state.rely),
      ];

      switch (constraint.kind) {
        case 'primary-key':
        case 'unique':
          return constraint.columns.map((column, index) =>
            constraintRow({
              position: index + 1,
              localColumn: column,
              indexOwner: constraint.backingIndex?.owner,
              indexName: constraint.backingIndex?.name,
            }),
          );
        case 'foreign-key':
          return constraint.columnPairs.map((pair, index) =>
            constraintRow({
              position: index + 1,
              localColumn: pair.childColumn,
              parentOwner: constraint.parentTable.owner,
              parentTable: constraint.parentTable.name,
              parentConstraint: constraint.parentConstraint.name,
              parentColumn: pair.parentColumn,
              deleteRule: constraint.onDelete,
            }),
          );
        case 'check':
          return [
            constraintRow({ position: 1, expression: constraint.expression }),
          ];
        case 'not-null':
          return [
            constraintRow({ position: 1, localColumn: constraint.column }),
          ];
      }
    });
}

function buildSheetDefinitions(source: SourceDocument): SheetDefinition[] {
  const tables = [...source.tables].sort((a, b) =>
    compareText(referenceKey(a), referenceKey(b)),
  );
  const views = [...source.views].sort((a, b) =>
    compareText(referenceKey(a), referenceKey(b)),
  );
  return [
    {
      name: 'Metadata',
      headers: ['Property', 'Value'],
      wrappedHeaders: [],
      rows: [
        ['Workbook format', 'Source data dictionary 1'],
        ['Source document format', source.formatVersion],
        ['Source kind', source.kind],
        ['Dialect', source.dialect],
        ['Source Oracle version', source.sourceVersion],
        ['Extraction timestamp', source.extractedAt],
        ['Target table count', source.targetTables.length],
        ['Target view count', source.targetViews.length],
        ['Target procedure count', source.targetProcedures.length],
        ['Target function count', source.targetFunctions.length],
        ['Target package count', source.targetPackages.length],
        ['Program unit count', source.programUnits.length],
        ['Sequence count', source.sequences.length],
        ['Synonym count', source.synonyms.length],
        [
          'Program definitions',
          'Exact source and dependency metadata are authoritative in JSON.',
        ],
        ['Included table count', source.tables.length],
        ['Included view count', source.views.length],
        ['Prerequisite count', source.prerequisites.length],
        ['Diagnostic count', source.diagnostics.length],
      ],
    },
    {
      name: 'Tables',
      headers: [
        'Owner',
        'Table Name',
        'Role',
        'Comment',
        'Source Tablespace',
        'Source Compression',
        'Unsupported Features',
        'Column Count',
        'Constraint Count',
        'Index Count',
      ],
      wrappedHeaders: ['Comment', 'Unsupported Features'],
      rows: tables.map((table) => [
        table.reference.owner,
        table.reference.name,
        table.role,
        table.comment,
        table.sourcePhysical.tablespace,
        table.sourcePhysical.compression,
        [...table.unsupportedFeatures].sort(compareText).join('\n'),
        table.columns.length,
        table.constraints.length,
        table.indexes.length,
      ]),
    },
    {
      name: 'Columns',
      headers: [
        'Table Owner',
        'Table Name',
        'Table Role',
        'Position',
        'Column Name',
        'Comment',
        'Datatype Owner',
        'Datatype Name',
        'Byte Length',
        'Character Length',
        'Length Semantics',
        'Precision',
        'Scale',
        'Nullable',
        'Default Expression',
        'Default On Null',
        'Virtual',
        'Invisible',
        'Identity Generation',
        'Identity Options',
        'Collation',
      ],
      wrappedHeaders: ['Comment', 'Default Expression', 'Identity Options'],
      rows: tables.flatMap((table) =>
        [...table.columns]
          .sort(
            (a, b) => a.position - b.position || compareText(a.name, b.name),
          )
          .map((column) => [
            table.reference.owner,
            table.reference.name,
            table.role,
            column.position,
            column.name,
            column.comment,
            column.dataType.owner,
            column.dataType.name,
            column.dataType.byteLength,
            column.dataType.characterLength,
            column.dataType.lengthSemantics,
            column.dataType.precision,
            column.dataType.scale,
            booleanText(column.nullable),
            column.defaultExpression,
            booleanText(column.defaultOnNull),
            booleanText(column.virtual),
            booleanText(column.invisible),
            column.identity?.generation ?? null,
            column.identity?.options ?? null,
            column.collation,
          ]),
      ),
    },
    {
      name: 'Constraints',
      headers: [
        'Table Owner',
        'Table Name',
        'Constraint Name',
        'Generated Name',
        'Kind',
        'Member Position',
        'Child/Local Column',
        'Parent Owner',
        'Parent Table',
        'Parent Constraint',
        'Parent Column',
        'Check Expression',
        'Delete Rule',
        'Backing Index Owner',
        'Backing Index Name',
        'Enabled',
        'Validated',
        'Deferrable',
        'Initially Deferred',
        'Rely',
      ],
      wrappedHeaders: ['Check Expression'],
      rows: tables.flatMap(buildConstraintRows),
    },
    {
      name: 'Indexes',
      headers: [
        'Table Owner',
        'Table Name',
        'Index Owner',
        'Index Name',
        'Type',
        'Unique',
        'Visible',
        'Status',
        'Partitioned',
        'Compression',
        'Key Position',
        'Column',
        'Expression',
        'Direction',
      ],
      wrappedHeaders: ['Expression'],
      rows: tables.flatMap((table) =>
        [...table.indexes]
          .sort((a, b) => compareText(referenceKey(a), referenceKey(b)))
          .flatMap((index) =>
            index.keys.map((indexKey, position) => [
              table.reference.owner,
              table.reference.name,
              index.reference.owner,
              index.reference.name,
              index.type,
              booleanText(index.unique),
              booleanText(index.visible),
              index.status,
              booleanText(index.partitioned),
              index.compression,
              position + 1,
              indexKey.column,
              indexKey.expression,
              indexKey.direction,
            ]),
          ),
      ),
    },
    {
      name: 'Views',
      headers: [
        'Owner',
        'View Name',
        'Role',
        'Columns',
        'Query',
        'Read Only',
        'Check Option',
        'Bequeath',
        'Status',
        'Collation',
        'Editioning',
        'Typed',
        'Superview',
        'Container Data',
        'Unsupported Features',
      ],
      wrappedHeaders: ['Columns', 'Query', 'Unsupported Features'],
      rows: views.map((view) => [
        view.reference.owner,
        view.reference.name,
        view.role,
        view.columns.join('\n'),
        view.query,
        booleanText(view.readOnly),
        view.checkOption,
        view.bequeath,
        view.status,
        view.collation,
        booleanText(view.editioning),
        booleanText(view.typed),
        booleanText(view.superview),
        booleanText(view.containerData),
        [...view.unsupportedFeatures].sort(compareText).join('\n'),
      ]),
    },
    {
      name: 'View Dependencies',
      headers: [
        'View Owner',
        'View Name',
        'View Role',
        'Dependency Position',
        'Dependency Owner',
        'Dependency Name',
        'Dependency Type',
        'Database Link',
      ],
      wrappedHeaders: [],
      rows: views.flatMap((view) =>
        view.dependencies.map((dependency, position) => [
          view.reference.owner,
          view.reference.name,
          view.role,
          position + 1,
          dependency.reference.owner,
          dependency.reference.name,
          dependency.type,
          dependency.databaseLink,
        ]),
      ),
    },
    {
      name: 'Prerequisites',
      headers: [
        'Required By Owner',
        'Required By Name',
        'Referenced Owner',
        'Referenced Name',
        'Type',
        'Database Link',
      ],
      wrappedHeaders: [],
      rows: [...source.prerequisites]
        .sort((a, b) =>
          compareText(
            `${a.requiredBy.owner}.${a.requiredBy.name}.${a.reference.owner}.${a.reference.name}.${a.type}`,
            `${b.requiredBy.owner}.${b.requiredBy.name}.${b.reference.owner}.${b.reference.name}.${b.type}`,
          ),
        )
        .map((prerequisite) => [
          prerequisite.requiredBy.owner,
          prerequisite.requiredBy.name,
          prerequisite.reference.owner,
          prerequisite.reference.name,
          prerequisite.type,
          prerequisite.databaseLink,
        ]),
    },
    {
      name: 'Diagnostics',
      headers: ['Severity', 'Code', 'Object', 'Message'],
      wrappedHeaders: ['Message'],
      rows: [...source.diagnostics]
        .sort((a, b) =>
          compareText(
            `${a.severity}.${a.code}.${a.object}.${a.message}`,
            `${b.severity}.${b.code}.${b.object}.${b.message}`,
          ),
        )
        .map((diagnostic) => [
          diagnostic.severity,
          diagnostic.code,
          diagnostic.object,
          diagnostic.message,
        ]),
    },
  ];
}

function validateSheetLimits(definition: SheetDefinition): void {
  const count = definition.rows.length + 1;
  if (count > MAX_ROWS) {
    throw new Error(
      `Workbook row limit exceeded: ${definition.name} requires ${count} rows; maximum ${MAX_ROWS}.`,
    );
  }
  definition.rows.forEach((row, rowIndex) =>
    row.forEach((value, columnIndex) => {
      if (typeof value !== 'string') {
        return;
      }
      const object = String(row[0] ?? `row ${rowIndex + 2}`);
      const field = definition.headers[columnIndex]!;
      if (value.length > MAX_CHARS) {
        throw new Error(
          `Workbook cell limit exceeded: ${definition.name} ${object} ${field} has ${value.length} characters; maximum ${MAX_CHARS}.`,
        );
      }
      const lineFeeds = value.split('\n').length - 1;
      if (lineFeeds > MAX_CELL_LINE_FEEDS) {
        throw new Error(
          `Workbook line-feed limit exceeded: ${definition.name} ${object} ${field} has ${lineFeeds} line feeds; maximum ${MAX_CELL_LINE_FEEDS}.`,
        );
      }
    }),
  );
}

function formatWorksheet(
  sheet: ExcelJS.Worksheet,
  definition: SheetDefinition,
): void {
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: definition.headers.length },
  };
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1F4E78' },
    };
  });
  definition.headers.forEach((header, index) => {
    const column = sheet.getColumn(index + 1);
    const shouldWrap = definition.wrappedHeaders.includes(header);
    column.width = shouldWrap
      ? 48
      : Math.min(24, Math.max(12, header.length + 2));
    if (shouldWrap) {
      column.alignment = { wrapText: true, vertical: 'top' };
    }
  });
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    row.alignment = { vertical: 'top' };
    if (rowNumber % 2 === 0) {
      row.eachCell((cell) => {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF2F6FA' },
        };
      });
    }
  }
}

export function buildDictionaryWorkbook(
  source: SourceDocument,
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const timestamp = new Date(source.extractedAt);
  workbook.creator = 'oracle-schema-pipeline';
  workbook.title = 'Source Data Dictionary';
  workbook.created = timestamp;
  workbook.modified = timestamp;
  for (const definition of buildSheetDefinitions(source)) {
    validateSheetLimits(definition);
    const sheet = workbook.addWorksheet(definition.name, {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    sheet.addRow(definition.headers);
    definition.rows.forEach((row) => sheet.addRow(row));
    formatWorksheet(sheet, definition);
  }
  return workbook;
}

export async function createDictionaryBuffer(
  source: SourceDocument,
): Promise<Buffer> {
  return Buffer.from(await buildDictionaryWorkbook(source).xlsx.writeBuffer());
}
