import { z } from 'zod';

// One definition supplies both compile-time types and runtime JSON validation.
// Strict objects make misspelled properties fail instead of being ignored.
export const identifierSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      Buffer.byteLength(value, 'utf8') <= 128 && !/[\x00-\x1f]/u.test(value),
    'Invalid Oracle identifier',
  );

export const objectReferenceSchema = z
  .object({ owner: identifierSchema, name: identifierSchema })
  .strict();
export type ObjectReference = z.infer<typeof objectReferenceSchema>;

export const procedureSelectionSchema = objectReferenceSchema
  .extend({
    package: identifierSchema.optional(),
  })
  .strict();
export type ProcedureSelection = z.infer<typeof procedureSelectionSchema>;

const legacySelectionSchema = z
  .object({
    version: z.literal(2),
    tables: z.array(objectReferenceSchema).default([]),
    views: z.array(objectReferenceSchema).default([]),
  })
  .strict();
const programSelectionSchema = z
  .object({
    version: z.literal(3),
    tables: z.array(objectReferenceSchema).default([]),
    views: z.array(objectReferenceSchema).default([]),
    procedures: z.array(procedureSelectionSchema).default([]),
    packages: z.array(objectReferenceSchema).default([]),
  })
  .strict();
export const selectionSchema = z
  .discriminatedUnion('version', [
    legacySelectionSchema,
    programSelectionSchema,
  ])
  .refine(
    (value) =>
      value.tables.length +
        value.views.length +
        (value.version === 3
          ? value.procedures.length + value.packages.length
          : 0) >
      0,
    'At least one object is required.',
  );
export type ObjectSelection = z.infer<typeof selectionSchema>;

export const diagnosticSchema = z
  .object({
    severity: z.enum(['error', 'warning', 'change']),
    code: z.string(),
    object: z.string(),
    message: z.string(),
  })
  .strict();
export type Diagnostic = z.infer<typeof diagnosticSchema>;

const columnDataTypeSchema = z
  .object({
    name: z.string(),
    owner: z.string().nullable(),
    byteLength: z.number().int().nonnegative(),
    characterLength: z.number().int().nonnegative(),
    lengthSemantics: z.enum(['BYTE', 'CHAR']).nullable(),
    precision: z.number().int().nullable(),
    scale: z.number().int().nullable(),
  })
  .strict();

export const columnSchema = z
  .object({
    name: identifierSchema,
    position: z.number().int().positive(),
    comment: z.string().nullable(),
    // Preserve Oracle's own type identity and parameters; do not map to JS types.
    dataType: columnDataTypeSchema,
    nullable: z.boolean(),
    defaultExpression: z.string().nullable(),
    defaultOnNull: z.boolean(),
    virtual: z.boolean(),
    invisible: z.boolean(),
    // Preserve raw identity metadata; the renderer validates supported options.
    identity: z
      .object({ generation: z.string(), options: z.string() })
      .strict()
      .nullable(),
    collation: z.string().nullable(),
  })
  .strict();
export type ColumnDefinition = z.infer<typeof columnSchema>;

const constraintStateSchema = z
  .object({
    enabled: z.boolean(),
    validated: z.boolean(),
    deferrable: z.boolean(),
    initiallyDeferred: z.boolean(),
    rely: z.boolean(),
  })
  .strict();

const constraintProperties = {
  name: identifierSchema,
  generatedName: z.boolean(),
  state: constraintStateSchema,
};

const foreignKeyColumnPairSchema = z
  .object({
    childColumn: identifierSchema,
    parentColumn: identifierSchema,
  })
  .strict();

export const constraintSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...constraintProperties,
      kind: z.literal('primary-key'),
      columns: z.array(identifierSchema).min(1),
      backingIndex: objectReferenceSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...constraintProperties,
      kind: z.literal('unique'),
      columns: z.array(identifierSchema).min(1),
      backingIndex: objectReferenceSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...constraintProperties,
      kind: z.literal('check'),
      expression: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...constraintProperties,
      kind: z.literal('not-null'),
      column: identifierSchema,
    })
    .strict(),
  z
    .object({
      ...constraintProperties,
      kind: z.literal('foreign-key'),
      parentTable: objectReferenceSchema,
      parentConstraint: objectReferenceSchema,
      columnPairs: z.array(foreignKeyColumnPairSchema).min(1),
      onDelete: z.enum(['NO ACTION', 'CASCADE', 'SET NULL']),
    })
    .strict(),
]);
export type ConstraintDefinition = z.infer<typeof constraintSchema>;
export type ForeignKeyDefinition = Extract<
  ConstraintDefinition,
  { kind: 'foreign-key' }
>;

const indexKeySchema = z
  .object({
    column: z.string().nullable(),
    expression: z.string().nullable(),
    direction: z.enum(['ASC', 'DESC']),
  })
  .strict();

export const viewDependencySchema = z
  .object({
    reference: objectReferenceSchema,
    type: z.string(),
    databaseLink: z.string().nullable(),
    oracleMaintained: z.boolean().optional(),
  })
  .strict();
export type ViewDependency = z.infer<typeof viewDependencySchema>;

export const indexSchema = z
  .object({
    reference: objectReferenceSchema,
    type: z.string(),
    unique: z.boolean(),
    visible: z.boolean(),
    status: z.string(),
    partitioned: z.boolean(),
    // Compression is a recorded source fact, explicitly omitted by target policy.
    compression: z.string(),
    keys: z.array(indexKeySchema).min(1),
    dependencies: z.array(viewDependencySchema),
  })
  .strict();
export type IndexDefinition = z.infer<typeof indexSchema>;

export const tableSchema = z
  .object({
    reference: objectReferenceSchema,
    role: z.enum([
      'target',
      'direct-parent',
      'view-dependency',
      'program-dependency',
    ]),
    comment: z.string().nullable(),
    // Features cannot be silently discarded. Nonempty entries block generation.
    unsupportedFeatures: z.array(z.string()),
    sourcePhysical: z
      .object({
        tablespace: z.string().nullable(),
        compression: z.string().nullable(),
      })
      .strict(),
    columns: z.array(columnSchema).min(1),
    constraints: z.array(constraintSchema),
    indexes: z.array(indexSchema),
  })
  .strict();
export type TableDefinition = z.infer<typeof tableSchema>;

export const viewSchema = z
  .object({
    reference: objectReferenceSchema,
    role: z.enum(['target', 'dependency']),
    columns: z.array(identifierSchema).min(1),
    // Full catalog TEXT including restrictions. Flags below never add SQL.
    query: z.string().min(1),
    readOnly: z.boolean(),
    checkOption: z.enum(['NONE', 'LOCAL', 'CASCADED']),
    bequeath: z.enum(['DEFINER', 'CURRENT_USER']),
    status: z.string(),
    collation: z.string().nullable(),
    editioning: z.boolean(),
    typed: z.boolean(),
    superview: z.boolean(),
    containerData: z.boolean(),
    dependencies: z.array(viewDependencySchema),
    unsupportedFeatures: z.array(z.string()),
  })
  .strict();
export type ViewDefinition = z.infer<typeof viewSchema>;

export const prerequisiteSchema = z
  .object({
    requiredBy: objectReferenceSchema,
    origin: z.enum(['TABLE', 'INDEX']).optional(),
    reference: objectReferenceSchema,
    type: z.string(),
    databaseLink: z.string().nullable(),
    oracleMaintained: z.boolean().optional(),
  })
  .strict();
export type Prerequisite = z.infer<typeof prerequisiteSchema>;

export const programSettingsSchema = z
  .object({
    plsqlOptimizeLevel: z.number().int().min(0).max(3),
    plsqlCodeType: z.enum(['INTERPRETED', 'NATIVE']),
    plsqlDebug: z.boolean(),
    plsqlWarnings: z.string(),
    nlsLengthSemantics: z.enum(['BYTE', 'CHAR']),
    plsqlCcflags: z.string().nullable(),
    plscopeSettings: z.string(),
  })
  .strict();
export const programUnitSchema = z
  .object({
    type: z.enum(['PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE BODY']),
    status: z.enum(['VALID', 'INVALID']),
    sourceLines: z
      .array(
        z
          .object({
            line: z.number().int().positive(),
            text: z.string(),
          })
          .strict(),
      )
      .min(1),
    dependencies: z.array(
      viewDependencySchema
        .extend({
          type: z.string().min(1),
          oracleMaintained: z.boolean(),
        })
        .strict(),
    ),
    settings: programSettingsSchema,
  })
  .strict();
export type ProgramUnit = z.infer<typeof programUnitSchema>;
export type ProgramSettings = z.infer<typeof programSettingsSchema>;
const programProperties = {
  reference: objectReferenceSchema,
  role: z.enum(['target', 'dependency']),
  authid: z.enum(['DEFINER', 'CURRENT_USER']),
  editionable: z.boolean(),
  sourceOwnerEditionsEnabled: z.boolean(),
  oracleMaintained: z.boolean(),
  unsupportedFeatures: z.array(z.string()),
  units: z.array(programUnitSchema).min(1),
};
export const programSchema = z.discriminatedUnion('kind', [
  z.object({ ...programProperties, kind: z.literal('procedure') }).strict(),
  z.object({ ...programProperties, kind: z.literal('function') }).strict(),
  z
    .object({
      ...programProperties,
      kind: z.literal('package'),
      publicProcedures: z.array(
        z
          .object({
            name: identifierSchema,
            overload: z.string().nullable(),
          })
          .strict(),
      ),
      bodyRequired: z.boolean(),
    })
    .strict(),
]);
export type ProgramDefinition = z.infer<typeof programSchema>;

const commonDocumentProperties = {
  formatVersion: z.literal(6, {
    errorMap: () => ({
      message:
        'Expected format v6; re-extract older artifacts with this version of the pipeline.',
    }),
  }),
  dialect: z.literal('oracle'),
  sourceVersion: z.string(),
  extractedAt: z.string().datetime(),
  selectionVersion: z.union([z.literal(2), z.literal(3)]),
  targetProcedures: z.array(procedureSelectionSchema),
  targetPackages: z.array(objectReferenceSchema),
  programs: z.array(programSchema),
  targetTables: z.array(objectReferenceSchema),
  targetViews: z.array(objectReferenceSchema),
  tables: z.array(tableSchema),
  views: z.array(viewSchema),
  prerequisites: z.array(prerequisiteSchema),
  diagnostics: z.array(diagnosticSchema),
};

export const sourceDocumentSchema = z
  .object({ ...commonDocumentProperties, kind: z.literal('source') })
  .strict();
export type SourceDocument = z.infer<typeof sourceDocumentSchema>;

const policyProperties = {
  createSchemas: z.boolean().default(true),
  defaultTablespace: identifierSchema.default('USERS'),
  maxStringSize: z.enum(['STANDARD', 'EXTENDED']).default('STANDARD'),
  externalPrerequisites: z
    .array(
      z
        .object({
          reference: objectReferenceSchema,
          type: z.string(),
        })
        .strict(),
    )
    .default([]),
};
export const plsqlObjectGrantSchema = z
  .object({
    reference: objectReferenceSchema,
    grantee: identifierSchema,
    privileges: z
      .array(z.enum(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES']))
      .min(1)
      .refine(
        (values) => new Set(values).size === values.length,
        'Duplicate privilege.',
      ),
  })
  .strict();
export type PlsqlObjectGrant = z.infer<typeof plsqlObjectGrantSchema>;
export const policySchema = z.preprocess(
  (value) => {
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      !('version' in value)
    )
      return { ...value, version: 1 };
    return value;
  },
  z.discriminatedUnion('version', [
    z.object({ version: z.literal(1), ...policyProperties }).strict(),
    z
      .object({
        version: z.literal(2),
        ...policyProperties,
        plsqlObjectGrants: z.array(plsqlObjectGrantSchema).default([]),
      })
      .strict(),
  ]),
);
export type TargetPolicy = z.infer<typeof policySchema>;

export const targetDocumentSchema = z
  .object({
    ...commonDocumentProperties,
    kind: z.literal('target'),
    targetVersion: z.literal('23'),
    policy: policySchema,
  })
  .strict();
export type TargetDocument = z.infer<typeof targetDocumentSchema>;

export function objectKey(reference: ObjectReference): string {
  return JSON.stringify([reference.owner, reference.name]);
}

export function quoteIdentifier(name: string): string {
  identifierSchema.parse(name);
  return `"${name.replaceAll('"', '""')}"`;
}

export function qualifiedName(reference: ObjectReference): string {
  return `${quoteIdentifier(reference.owner)}.${quoteIdentifier(reference.name)}`;
}

export function uniqueReferences(
  references: ObjectReference[],
): ObjectReference[] {
  // Keep the last reference for each key, then sort independently of locale.
  const referencesByKey = new Map(
    references.map((reference) => [objectKey(reference), reference]),
  );
  const sortedEntries = [...referencesByKey.entries()].sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  );
  return sortedEntries.map(([, reference]) => reference);
}
