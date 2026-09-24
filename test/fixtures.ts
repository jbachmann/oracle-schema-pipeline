import {
  sourceDocumentSchema,
  type ColumnDefinition,
  type ConstraintDefinition,
  type ObjectReference,
  type SourceDocument,
  type TableDefinition,
} from '../src/model.js';
export const enabledState = {
  enabled: true,
  validated: true,
  deferrable: false,
  initiallyDeferred: false,
  rely: false,
};
export function numberColumn(name: string, position: number): ColumnDefinition {
  return {
    name,
    position,
    comment: null,
    dataType: {
      name: 'NUMBER',
      owner: null,
      byteLength: 22,
      characterLength: 0,
      lengthSemantics: null,
      precision: 10,
      scale: 0,
    },
    nullable: false,
    defaultExpression: null,
    defaultOnNull: false,
    virtual: false,
    invisible: false,
    identity: null,
    collation: null,
  };
}
function primaryKey(name: string, owner: string): ConstraintDefinition {
  return {
    kind: 'primary-key',
    name,
    columns: ['TENANT_ID', 'ID'],
    backingIndex: { owner, name },
    generatedName: false,
    state: { ...enabledState },
  };
}
export function ordinaryTable(owner: string, name: string): TableDefinition {
  return {
    reference: { owner, name },
    role: 'target',
    comment: null,
    unsupportedFeatures: [],
    sourcePhysical: { tablespace: 'PROD_DATA', compression: 'DISABLED' },
    columns: [numberColumn('TENANT_ID', 1), numberColumn('ID', 2)],
    constraints: [primaryKey(`PK_${name}`, owner)],
    indexes: [
      {
        reference: { owner, name: `PK_${name}` },
        type: 'NORMAL',
        unique: true,
        visible: true,
        status: 'VALID',
        partitioned: false,
        compression: 'DISABLED',
        keys: ['TENANT_ID', 'ID'].map((column) => ({
          column,
          expression: null,
          direction: 'ASC',
        })),
      },
    ],
  };
}
export function fk(
  name: string,
  parent: ObjectReference,
): ConstraintDefinition {
  return {
    kind: 'foreign-key',
    name,
    generatedName: false,
    state: { ...enabledState },
    parentTable: parent,
    parentConstraint: { owner: parent.owner, name: `PK_${parent.name}` },
    onDelete: 'NO ACTION',
    columnPairs: [
      { childColumn: 'TENANT_ID', parentColumn: 'TENANT_ID' },
      { childColumn: 'ID', parentColumn: 'ID' },
    ],
  };
}
export function sourceFixture(): SourceDocument {
  const child = ordinaryTable('APP', 'CHILD'),
    parent = ordinaryTable('SHARED', 'PARENT');
  child.constraints.push(fk('FK_CHILD_PARENT', parent.reference));
  parent.role = 'direct-parent';
  parent.constraints.push(
    fk('FK_PARENT_GRANDPARENT', { owner: 'OTHER', name: 'GRANDPARENT' }),
  );
  return sourceDocumentSchema.parse({
    formatVersion: 3,
    kind: 'source',
    dialect: 'oracle',
    sourceVersion: '19.0.0.0.0',
    extractedAt: '2026-09-22T00:00:00.000Z',
    targetTables: [child.reference],
    targetViews: [],
    views: [],
    tables: [child, parent],
    prerequisites: [],
    diagnostics: [],
  });
}
