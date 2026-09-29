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

export const routineReferenceSchema = z.union([
  objectReferenceSchema,
  z
    .object({
      owner: identifierSchema,
      package: identifierSchema,
      name: identifierSchema,
    })
    .strict(),
]);
export type RoutineReference = z.infer<typeof routineReferenceSchema>;
const relationalSelection = {
  tables: z.array(objectReferenceSchema).default([]),
  views: z.array(objectReferenceSchema).default([]),
};
const explicitSelection = {
  procedures: z.array(routineReferenceSchema).default([]),
  functions: z.array(routineReferenceSchema).default([]),
  packages: z.array(objectReferenceSchema).default([]),
  sequences: z.array(objectReferenceSchema).default([]),
  synonyms: z.array(objectReferenceSchema).default([]),
};
export const selectionSchema = z
  .union([
    z
      .object({ version: z.literal(2), ...relationalSelection })
      .strict()
      .transform((value) => ({
        ...value,
        version: 3 as const,
        procedures: [] as RoutineReference[],
        functions: [] as RoutineReference[],
        packages: [] as ObjectReference[],
        sequences: [] as ObjectReference[],
        synonyms: [] as ObjectReference[],
      })),
    z
      .object({
        version: z.literal(3),
        ...relationalSelection,
        ...explicitSelection,
      })
      .strict(),
  ])
  .refine(
    (value) =>
      value.tables.length +
        value.views.length +
        value.procedures.length +
        value.functions.length +
        value.packages.length +
        value.sequences.length +
        value.synonyms.length >
      0,
    'At least one selected object is required.',
  );
// The public extraction boundary also accepts legacy selections from custom catalogs.
export type ObjectSelection = z.input<typeof selectionSchema>;
export type NormalizedSelection = z.infer<typeof selectionSchema>;

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
    dependencies: z.array(viewDependencySchema),
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

export const decimalIntegerSchema = z.string().regex(/^(?:0|-?[1-9][0-9]*)$/u);
export const routinePropertiesSchema = z
  .object({
    deterministic: z.boolean(),
    resultCache: z.boolean(),
    pipelined: z.boolean(),
    parallelEnabled: z.boolean(),
    aggregate: z.boolean(),
    sqlMacro: z.enum(['NONE', 'SCALAR', 'TABLE']),
  })
  .strict();
export const programUnitSchema = z
  .object({
    reference: objectReferenceSchema,
    type: z.enum(['PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE BODY']),
    sourceLines: z
      .array(
        z
          .object({ line: z.number().int().positive(), text: z.string() })
          .strict(),
      )
      .min(1),
    status: z.enum(['VALID', 'INVALID']),
    editionable: z.boolean(),
    editionName: z.string().nullable(),
    authid: z.enum(['DEFINER', 'CURRENT_USER']).nullable(),
    packageBodyPresent: z.boolean().nullable(),
    routineProperties: routinePropertiesSchema.nullable(),
    members: z.array(
      z
        .object({
          name: identifierSchema,
          subprogramId: z.number().int().positive(),
          overload: z.string().nullable(),
          kind: z.enum(['procedure', 'function']),
          routineProperties: routinePropertiesSchema,
        })
        .strict(),
    ),
    dependencies: z.array(
      viewDependencySchema.extend({ oracleMaintained: z.boolean() }).strict(),
    ),
    compilerSettings: z
      .object({
        plsqlOptimizeLevel: z.number().int().min(0).max(3),
        plsqlCodeType: z.enum(['INTERPRETED', 'NATIVE']),
        plsqlDebug: z.boolean(),
        plsqlWarnings: z.string(),
        nlsLengthSemantics: z.enum(['BYTE', 'CHAR']),
        plsqlCcflags: z.string().nullable(),
        plscopeSettings: z.string(),
        plsqlImplicitConversionBool: z.boolean().nullable(),
      })
      .strict(),
    unsupportedFeatures: z.array(z.string()),
  })
  .strict();
export type ProgramUnit = z.infer<typeof programUnitSchema>;
export const sequenceSchema = z
  .object({
    reference: objectReferenceSchema,
    minValue: decimalIntegerSchema,
    maxValue: decimalIntegerSchema,
    incrementBy: decimalIntegerSchema,
    cacheSize: decimalIntegerSchema,
    lastNumber: decimalIntegerSchema,
    cycle: z.boolean(),
    order: z.boolean(),
    scale: z.boolean(),
    extend: z.boolean(),
    sharded: z.boolean(),
    session: z.boolean(),
    keep: z.boolean(),
    sharing: z.enum(['NONE', 'METADATA LINK', 'DATA LINK']),
    identityBacking: z.boolean(),
    unsupportedFeatures: z.array(z.string()),
  })
  .strict();
export type SequenceDefinition = z.infer<typeof sequenceSchema>;
export const synonymSchema = z
  .object({
    reference: objectReferenceSchema,
    target: objectReferenceSchema,
    databaseLink: z.string().nullable(),
    targetType: z.string(),
    editionable: z.boolean(),
    editionName: z.string().nullable(),
    sharing: z.string(),
    unsupportedFeatures: z.array(z.string()),
  })
  .strict();
export type SynonymDefinition = z.infer<typeof synonymSchema>;
export const synonymResolutionSchema = z
  .object({
    links: z
      .array(
        z
          .object({
            reference: objectReferenceSchema,
            target: objectReferenceSchema,
            databaseLink: z.string().nullable(),
          })
          .strict(),
      )
      .min(1),
    terminal: z
      .object({ reference: objectReferenceSchema, type: z.string() })
      .strict(),
  })
  .strict();

export const prerequisiteSchema = z
  .object({
    requiredBy: objectReferenceSchema,
    synonymResolution: synonymResolutionSchema.nullable(),
    reference: objectReferenceSchema,
    type: z.string(),
    databaseLink: z.string().nullable(),
  })
  .strict();
export type Prerequisite = z.infer<typeof prerequisiteSchema>;

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
  targetProcedures: z.array(routineReferenceSchema),
  targetFunctions: z.array(routineReferenceSchema),
  targetPackages: z.array(objectReferenceSchema),
  targetSequences: z.array(objectReferenceSchema),
  targetSynonyms: z.array(objectReferenceSchema),
  programUnits: z.array(programUnitSchema),
  sequences: z.array(sequenceSchema),
  synonyms: z.array(synonymSchema),
  tables: z.array(tableSchema),
  views: z.array(viewSchema),
  prerequisites: z.array(prerequisiteSchema),
  diagnostics: z.array(diagnosticSchema),
};

export const sourceDocumentSchema = z
  .object({ ...commonDocumentProperties, kind: z.literal('source') })
  .strict();
export type SourceDocument = z.infer<typeof sourceDocumentSchema>;

export const objectGrantSchema = z
  .object({
    reference: objectReferenceSchema,
    type: z.enum([
      'TABLE',
      'VIEW',
      'PROCEDURE',
      'PACKAGE',
      'FUNCTION',
      'SEQUENCE',
      'TYPE',
    ]),
    grantee: identifierSchema,
    privileges: z
      .array(z.enum(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'EXECUTE']))
      .min(1),
  })
  .strict();
export type ObjectGrant = z.infer<typeof objectGrantSchema>;
const policyProperties = {
  createSchemas: z.boolean().default(true),
  defaultTablespace: identifierSchema.default('USERS'),
  maxStringSize: z.enum(['STANDARD', 'EXTENDED']).default('STANDARD'),
  externalPrerequisites: z
    .array(
      z.object({ reference: objectReferenceSchema, type: z.string() }).strict(),
    )
    .default([]),
};
export const currentPolicySchema = z
  .object({
    version: z.literal(2),
    ...policyProperties,
    objectGrants: z.array(objectGrantSchema).default([]),
    sequenceStarts: z
      .array(
        z
          .object({
            reference: objectReferenceSchema,
            startWith: decimalIntegerSchema,
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export const policySchema = z.union([
  z
    .object({ version: z.literal(1).default(1), ...policyProperties })
    .strict()
    .transform((value) => ({
      ...value,
      version: 2 as const,
      objectGrants: [],
      sequenceStarts: [],
    })),
  currentPolicySchema,
]);
export type TargetPolicy = z.infer<typeof currentPolicySchema>;

export const targetDocumentSchema = z
  .object({
    ...commonDocumentProperties,
    kind: z.literal('target'),
    targetVersion: z.literal('23'),
    policy: currentPolicySchema,
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
