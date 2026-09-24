import { z } from 'zod';

// One definition supplies both compile-time types and runtime JSON validation.
// Strict objects make misspelled properties fail instead of being ignored.
export const identifierSchema = z.string().min(1).refine(value =>
  Buffer.byteLength(value, 'utf8') <= 128 && !/[\x00-\x1f]/u.test(value), 'Invalid Oracle identifier');
export const objectReferenceSchema = z.object({ owner: identifierSchema, name: identifierSchema }).strict();
export type ObjectReference = z.infer<typeof objectReferenceSchema>;
export const selectionSchema = z.object({ version: z.literal(2), tables: z.array(objectReferenceSchema).default([]),
  views: z.array(objectReferenceSchema).default([]) }).strict()
  .refine(value => value.tables.length + value.views.length > 0, 'At least one table or view is required.');
export type ObjectSelection = z.infer<typeof selectionSchema>;

export const diagnosticSchema = z.object({
  severity: z.enum(['error', 'warning', 'change']), code: z.string(), object: z.string(), message: z.string(),
}).strict();
export type Diagnostic = z.infer<typeof diagnosticSchema>;

export const columnSchema = z.object({
  name: identifierSchema,
  position: z.number().int().positive(),
  // Preserve Oracle's own type identity and parameters; do not map to JS types.
  dataType: z.object({
    name: z.string(), owner: z.string().nullable(), byteLength: z.number().int().nonnegative(),
    characterLength: z.number().int().nonnegative(), lengthSemantics: z.enum(['BYTE', 'CHAR']).nullable(),
    precision: z.number().int().nullable(), scale: z.number().int().nullable(),
  }).strict(),
  nullable: z.boolean(),
  defaultExpression: z.string().nullable(),
  defaultOnNull: z.boolean(),
  virtual: z.boolean(),
  invisible: z.boolean(),
  // Identity metadata is retained even when the current generator cannot emit it.
  identity: z.object({ generation: z.string(), options: z.string() }).strict().nullable(),
  collation: z.string().nullable(),
}).strict();
export type ColumnDefinition = z.infer<typeof columnSchema>;

const constraintStateSchema = z.object({
  enabled: z.boolean(), validated: z.boolean(), deferrable: z.boolean(), initiallyDeferred: z.boolean(), rely: z.boolean(),
}).strict();
const constraintProperties = {
  name: identifierSchema, generatedName: z.boolean(), state: constraintStateSchema,
};
export const constraintSchema = z.discriminatedUnion('kind', [
  z.object({ ...constraintProperties, kind: z.literal('primary-key'), columns: z.array(identifierSchema).min(1), backingIndex: objectReferenceSchema.nullable() }).strict(),
  z.object({ ...constraintProperties, kind: z.literal('unique'), columns: z.array(identifierSchema).min(1), backingIndex: objectReferenceSchema.nullable() }).strict(),
  z.object({ ...constraintProperties, kind: z.literal('check'), expression: z.string().min(1) }).strict(),
  z.object({ ...constraintProperties, kind: z.literal('not-null'), column: identifierSchema }).strict(),
  z.object({ ...constraintProperties, kind: z.literal('foreign-key'),
    parentTable: objectReferenceSchema, parentConstraint: objectReferenceSchema,
    columnPairs: z.array(z.object({ childColumn: identifierSchema, parentColumn: identifierSchema }).strict()).min(1),
    onDelete: z.enum(['NO ACTION', 'CASCADE', 'SET NULL']),
  }).strict(),
]);
export type ConstraintDefinition = z.infer<typeof constraintSchema>;
export type ForeignKeyDefinition = Extract<ConstraintDefinition, { kind: 'foreign-key' }>;

export const indexSchema = z.object({
  reference: objectReferenceSchema,
  type: z.string(), unique: z.boolean(), visible: z.boolean(), status: z.string(), partitioned: z.boolean(),
  // Compression is a recorded source fact, explicitly omitted by target policy.
  compression: z.string(),
  keys: z.array(z.object({
    column: z.string().nullable(), expression: z.string().nullable(), direction: z.enum(['ASC', 'DESC']),
  }).strict()).min(1),
}).strict();
export type IndexDefinition = z.infer<typeof indexSchema>;

export const tableSchema = z.object({
  reference: objectReferenceSchema,
  role: z.enum(['target', 'direct-parent', 'view-dependency']),
  // Features cannot be silently discarded. Nonempty entries block generation.
  unsupportedFeatures: z.array(z.string()),
  sourcePhysical: z.object({ tablespace: z.string().nullable(), compression: z.string().nullable() }).strict(),
  columns: z.array(columnSchema).min(1),
  constraints: z.array(constraintSchema),
  indexes: z.array(indexSchema),
}).strict();
export type TableDefinition = z.infer<typeof tableSchema>;
export const viewDependencySchema = z.object({ reference: objectReferenceSchema,
  type: z.string(), databaseLink: z.string().nullable() }).strict();
export type ViewDependency = z.infer<typeof viewDependencySchema>;
export const viewSchema = z.object({
  reference: objectReferenceSchema, role: z.enum(['target', 'dependency']), columns: z.array(identifierSchema).min(1),
  query: z.string().min(1), readOnly: z.boolean(), checkOption: z.enum(['NONE', 'LOCAL', 'CASCADED']),
  bequeath: z.enum(['DEFINER', 'CURRENT_USER']), status: z.string(), collation: z.string().nullable(),
  editioning: z.boolean(), typed: z.boolean(), superview: z.boolean(), containerData: z.boolean(),
  dependencies: z.array(viewDependencySchema), unsupportedFeatures: z.array(z.string()),
}).strict();
export type ViewDefinition = z.infer<typeof viewSchema>;

export const prerequisiteSchema = z.object({
  requiredBy: objectReferenceSchema, reference: objectReferenceSchema, type: z.string(), databaseLink: z.string().nullable(),
}).strict();
export type Prerequisite = z.infer<typeof prerequisiteSchema>;
const commonDocumentProperties = {
  formatVersion: z.literal(2), dialect: z.literal("oracle"), sourceVersion: z.string(), extractedAt: z.string().datetime(),
  targetTables: z.array(objectReferenceSchema), targetViews: z.array(objectReferenceSchema),
  tables: z.array(tableSchema), views: z.array(viewSchema), prerequisites: z.array(prerequisiteSchema), diagnostics: z.array(diagnosticSchema),
};
export const sourceDocumentSchema = z.object({ ...commonDocumentProperties, kind: z.literal("source") }).strict();
export type SourceDocument = z.infer<typeof sourceDocumentSchema>;

export const policySchema = z.object({
  version: z.literal(1).default(1),
  createSchemas: z.boolean().default(true),
  defaultTablespace: identifierSchema.default('USERS'),
  maxStringSize: z.enum(['STANDARD', 'EXTENDED']).default('STANDARD'),
  // These are explicit declarations that prerequisite objects/grants already exist.
  externalPrerequisites: z.array(z.object({ reference: objectReferenceSchema, type: z.string() }).strict()).default([]),
}).strict();
export type TargetPolicy = z.infer<typeof policySchema>;
export const targetDocumentSchema = z.object({ ...commonDocumentProperties, kind: z.literal("target"),
  targetVersion: z.literal("23"), policy: policySchema }).strict();
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
export function uniqueReferences(references: ObjectReference[]): ObjectReference[] {
  return [...new Map(references.map(reference => [objectKey(reference), reference])).entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, reference]) => reference);
}
