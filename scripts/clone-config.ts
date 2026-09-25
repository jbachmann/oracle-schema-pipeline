import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import oracle from 'oracledb';
import { policySchema, selectionSchema } from '../src/model.js';
import { resolveConnectionOptions } from '../src/connection.js';
import { CloneError } from './process.js';

const secret = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('REPLACE_'));
const nonempty = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);
export const cloneConfigSchema = z
  .object({
    version: z.literal(1),
    source: z
      .object({
        user: nonempty.refine((value) => !value.startsWith('REPLACE_')),
        password: secret,
        dsn: nonempty
          .refine(
            (value) => !value.includes('@') && !/password\s*=/i.test(value),
          )
          .optional(),
        tnsnames: nonempty.optional(),
        tnsAlias: nonempty.optional(),
        catalogScope: z.enum(['all', 'dba']).default('all'),
      })
      .strict()
      .refine((source) =>
        source.dsn
          ? !source.tnsnames && !source.tnsAlias
          : !!source.tnsnames && !!source.tnsAlias,
      ),
    objects: nonempty.default('objects.json'),
    policy: nonempty.default('policy.json'),
    prerequisiteSql: nonempty.optional(),
    destination: z
      .object({
        password: secret,
        port: z.number().int().min(1).max(65535).default(1522),
        startupTimeoutSeconds: z.number().int().positive().default(1200),
      })
      .strict(),
  })
  .strict()
  .refine((config) => config.source.password !== config.destination.password);

export async function loadCloneConfig(path: string) {
  try {
    const config = cloneConfigSchema.parse(
      JSON.parse(await readFile(path, 'utf8')),
    );
    const directory = dirname(path);
    if (config.source.tnsnames)
      config.source.tnsnames = resolve(directory, config.source.tnsnames);
    await resolveConnectionOptions(config.source, async (dir) =>
      oracle.getNetworkServiceNames(dir),
    );
    const objects = selectionSchema.parse(
      JSON.parse(await readFile(resolve(directory, config.objects), 'utf8')),
    );
    const policy = policySchema.parse(
      JSON.parse(await readFile(resolve(directory, config.policy), 'utf8')),
    );
    const prerequisite = config.prerequisiteSql
      ? await readFile(resolve(directory, config.prerequisiteSql))
      : undefined;
    if (
      (!policy.createSchemas ||
        policy.externalPrerequisites.length ||
        policy.defaultTablespace !== 'USERS' ||
        policy.maxStringSize === 'EXTENDED') &&
      !prerequisite
    )
      throw new CloneError('CLONE_PREREQUISITE_REQUIRED');
    if (prerequisite) {
      const sql = new TextDecoder('utf-8', { fatal: true }).decode(
        prerequisite,
      );
      // Guard common accidental SQL*Plus directives. Trusted SQL is not sandboxed.
      if (
        /^\s*(?:connect\b|conn\b|host\b|ho\b|!|@|start(?!\s+with\b)\b|exit(?!\s*(?:when\b|;))\b|quit\b|whenever\b|set\s+(?:define|echo|verify|feedback|heading|termout|serveroutput|sqlblanklines|autocommit)\b|spool\b)/im.test(
          sql,
        ) ||
        /alter\s+session\s+set\s+container\b/i.test(sql)
      )
        throw new CloneError('CLONE_CONFIG_INVALID');
    }
    return { config, objects, policy, prerequisite };
  } catch (error) {
    if (error instanceof CloneError) throw error;
    // Zod/JSON/driver errors can contain credentials; never forward their messages.
    throw new CloneError('CLONE_CONFIG_INVALID');
  }
}
export type LoadedConfig = Awaited<ReturnType<typeof loadCloneConfig>>;
