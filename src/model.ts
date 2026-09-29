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

export const selectionSchema = z
  .object({
    version: z.literal(2),
    tables: z.array(objectReferenceSchema).default([]),
    views: z.array(objectReferenceSchema).default([]),
    packages: z.array(objectReferenceSchema).default([]),
    procedures: z.array(objectReferenceSchema).default([]),
    functions: z.array(objectReferenceSchema).default([]),
    sequences: z.array(objectReferenceSchema).default([]),
  })
  .strict()
  .refine(
    (value) =>
      [
        value.tables,
        value.views,
        value.packages,
        value.procedures,
        value.functions,
        value.sequences,
      ].some((items) => items.length > 0),
    'At least one object is required.',
  )
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const kind of [
      'tables',
      'views',
      'packages',
      'procedures',
      'functions',
      'sequences',
    ] as const) {
      for (const reference of uniqueReferences(value[kind])) {
        const key = objectKey(reference);
        if (seen.has(key))
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [kind],
            message:
              'OBJECT_NAME_COLLISION: Selected kinds share a schema namespace.',
          });
        seen.add(key);
      }
    }
  });
export type ObjectSelection = z.input<typeof selectionSchema>;

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
    role: z.enum(['target', 'direct-parent', 'view-dependency']),
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
    // Catalog provenance distinguishes table expressions from deferred indexes.
    origin: z.enum(['TABLE', 'INDEX']).optional(),
    reference: objectReferenceSchema,
    type: z.string(),
    databaseLink: z.string().nullable(),
  })
  .strict();
export type Prerequisite = z.infer<typeof prerequisiteSchema>;

export const programKindSchema = z.enum(['PACKAGE', 'PROCEDURE', 'FUNCTION']);
export type ProgramKind = z.infer<typeof programKindSchema>;
export const programUnitSchema = z
  .object({
    type: z.enum(['PACKAGE_SPEC', 'PACKAGE_BODY', 'PROCEDURE', 'FUNCTION']),
    ddl: z.string().min(1),
    status: z.enum(['VALID', 'INVALID']),
    dependencies: z.array(
      viewDependencySchema.extend({ oracleMaintained: z.boolean() }).strict(),
    ),
  })
  .strict();
export type ProgramUnit = z.infer<typeof programUnitSchema>;
export const programSchema = z
  .object({
    reference: objectReferenceSchema,
    kind: programKindSchema,
    units: z.array(programUnitSchema).min(1),
    unsupportedFeatures: z.array(z.string()),
  })
  .strict();
export type ProgramDefinition = z.infer<typeof programSchema>;
const decimalIntegerSchema = z.string().regex(/^(0|-?[1-9][0-9]*)$/);
export const sequenceSchema = z
  .object({
    reference: objectReferenceSchema,
    minValue: decimalIntegerSchema,
    maxValue: decimalIntegerSchema,
    incrementBy: decimalIntegerSchema,
    cacheSize: decimalIntegerSchema,
    cycle: z.boolean(),
    order: z.boolean(),
    scale: z.boolean(),
    extend: z.boolean(),
    sharded: z.boolean(),
    session: z.boolean(),
    keep: z.boolean(),
    unsupportedFeatures: z.array(z.string()),
  })
  .strict();
export type SequenceDefinition = z.infer<typeof sequenceSchema>;

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
  targetTables: z.array(objectReferenceSchema),
  targetViews: z.array(objectReferenceSchema),
  targetPackages: z.array(objectReferenceSchema),
  targetProcedures: z.array(objectReferenceSchema),
  targetFunctions: z.array(objectReferenceSchema),
  targetSequences: z.array(objectReferenceSchema),
  programs: z.array(programSchema),
  sequences: z.array(sequenceSchema),
  tables: z.array(tableSchema),
  views: z.array(viewSchema),
  prerequisites: z.array(prerequisiteSchema),
  diagnostics: z.array(diagnosticSchema),
};

export const sourceDocumentSchema = z
  .object({ ...commonDocumentProperties, kind: z.literal('source') })
  .strict();
export type SourceDocument = z.infer<typeof sourceDocumentSchema>;

export const policySchema = z
  .object({
    version: z.literal(1).default(1),
    createSchemas: z.boolean().default(true),
    defaultTablespace: identifierSchema.default('USERS'),
    maxStringSize: z.enum(['STANDARD', 'EXTENDED']).default('STANDARD'),
    // Declare provisioned external objects and their existing prerequisite setup.
    // Required index-owner EXECUTE grants are derived and emitted separately.
    externalPrerequisites: z
      .array(
        z
          .object({ reference: objectReferenceSchema, type: z.string() })
          .strict(),
      )
      .default([]),
  })
  .strict();
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
