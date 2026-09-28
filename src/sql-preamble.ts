/** Exact format contract shared by generation and immutable-bundle replay. */
export const sqlPreamble = [
  '-- Generated from oracle-schema-pipeline format 6. Reconstructed from catalog metadata and captured source text.',
  'WHENEVER SQLERROR EXIT SQL.SQLCODE ROLLBACK',
  'WHENEVER OSERROR EXIT FAILURE ROLLBACK',
  'SET DEFINE OFF',
  'SET SQLBLANKLINES ON',
  'SET ECHO ON',
] as const;
