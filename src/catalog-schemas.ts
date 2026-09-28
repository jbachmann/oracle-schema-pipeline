/**
 * Defines the runtime schemas for rows returned by Oracle catalog queries.
 * Catalog decoding uses these schemas to validate driver values before readers
 * assemble domain objects. Uppercase fields match Oracle's result-column names;
 * enums and nullability describe the metadata each query expects. The versioned
 * document contract lives in model.ts, and cross-row consistency checks belong
 * to the readers and catalog-decoding helpers.
 */
import { z } from 'zod';

const text = z.string().min(1);
const nullableText = z.string().nullable();
const yn = z.enum(['Y', 'N']);
const yesNo = z.enum(['YES', 'NO']);
const integer = z.number().int().nonnegative();

export const tableRowSchema = z.object({
  TABLESPACE_NAME: nullableText,
  COMPRESSION: z.enum(['ENABLED', 'DISABLED']).nullable(),
  IOT_TYPE: z.enum(['IOT', 'IOT_OVERFLOW', 'IOT_MAPPING']).nullable(),
  CLUSTER_NAME: nullableText,
  NESTED: yesNo,
  SECONDARY: yn,
  TEMPORARY: yn,
  PARTITIONED: yesNo,
  ORACLE_MAINTAINED: yn,
  SPECIAL_COUNT: integer,
});

export const columnRowSchema = z.object({
  COLUMN_NAME: text,
  COLUMN_ID: integer.positive().nullable(),
  INTERNAL_COLUMN_ID: integer.positive(),
  DATA_TYPE: text,
  DATA_TYPE_OWNER: nullableText,
  DATA_LENGTH: integer,
  CHAR_LENGTH: integer,
  CHAR_USED: z.enum(['C', 'B']).nullable(),
  DATA_PRECISION: z.number().int().nullable(),
  DATA_SCALE: z.number().int().nullable(),
  NULLABLE: yn,
  DATA_DEFAULT: nullableText,
  IDENTITY_COLUMN: yesNo,
  DEFAULT_ON_NULL: yesNo,
  VIRTUAL_COLUMN: yesNo,
  HIDDEN_COLUMN: yesNo,
  COLLATION: nullableText,
});

export const commentRowSchema = z.object({ COMMENTS: nullableText });

export const columnCommentRowSchema = commentRowSchema.extend({
  COLUMN_NAME: text,
});

export const constraintRowSchema = z.object({
  OWNER: text,
  CONSTRAINT_NAME: text,
  CONSTRAINT_TYPE: z.enum(['C', 'P', 'U', 'R', 'V', 'O', 'H', 'F', 'S']),
  GENERATED: z.enum(['USER NAME', 'GENERATED NAME']),
  STATUS: z.enum(['ENABLED', 'DISABLED']),
  VALIDATED: z.enum(['VALIDATED', 'NOT VALIDATED']),
  DEFERRABLE: z.enum(['DEFERRABLE', 'NOT DEFERRABLE']),
  DEFERRED: z.enum(['DEFERRED', 'IMMEDIATE']),
  RELY: z.literal('RELY').nullable(),
  SEARCH_CONDITION: nullableText,
  INDEX_OWNER: nullableText,
  INDEX_NAME: nullableText,
  R_OWNER: nullableText,
  R_CONSTRAINT_NAME: nullableText,
  DELETE_RULE: z.enum(['NO ACTION', 'CASCADE', 'SET NULL']).nullable(),
  PARENT_TABLE_NAME: nullableText,
});
export type ConstraintRow = z.infer<typeof constraintRowSchema>;

export const indexRowSchema = z.object({
  OWNER: text,
  INDEX_NAME: text,
  INDEX_TYPE: text,
  UNIQUENESS: z.enum(['UNIQUE', 'NONUNIQUE']),
  VISIBILITY: z.enum(['VISIBLE', 'INVISIBLE']),
  STATUS: z.enum(['VALID', 'UNUSABLE', 'N/A']),
  PARTITIONED: yesNo,
  COMPRESSION: z.enum(['ENABLED', 'DISABLED', 'ADVANCED LOW', 'ADVANCED HIGH']),
});

export const viewRowSchema = z.object({
  TEXT: text,
  READ_ONLY: yn,
  BEQUEATH: z.enum(['DEFINER', 'CURRENT_USER']),
  EDITIONING_VIEW: yn,
  CONTAINER_DATA: yn,
  DEFAULT_COLLATION: nullableText,
  TYPE_TEXT: nullableText,
  SUPERVIEW_NAME: nullableText,
  STATUS: z.enum(['VALID', 'INVALID']),
  ORACLE_MAINTAINED: yn,
});

export const dependencyRowSchema = z.object({
  REFERENCED_OWNER: nullableText,
  REFERENCED_NAME: text,
  REFERENCED_TYPE: text,
  REFERENCED_LINK_NAME: nullableText,
});
export const prerequisiteRowSchema = dependencyRowSchema.extend({
  DEPENDENCY_ORIGIN: z.enum(['TABLE', 'INDEX']),
});

export const databaseVersionRowSchema = z.object({ VERSION: text });

export const orderedColumnRowSchema = z.object({
  COLUMN_NAME: text,
  POSITION: integer.positive(),
});

export const identityRowSchema = z.object({
  COLUMN_NAME: text,
  GENERATION_TYPE: z.enum(['ALWAYS', 'BY DEFAULT', 'BY DEFAULT ON NULL']),
  IDENTITY_OPTIONS: text,
});

export const indexExpressionRowSchema = z.object({
  COLUMN_POSITION: integer.positive(),
  COLUMN_EXPRESSION: text,
});

export const indexColumnRowSchema = z.object({
  COLUMN_NAME: text,
  COLUMN_POSITION: integer.positive(),
  DESCEND: z.enum(['ASC', 'DESC']),
});

export const viewRestrictionRowSchema = z.object({
  CONSTRAINT_NAME: text,
  CONSTRAINT_TYPE: z.enum(['V', 'O']),
  STATUS: z.literal('ENABLED'),
});

export const memberRowSchema = z.object({
  MEMBER_OWNER: text,
  MEMBER_NAME: text,
});
