import type { Connection } from 'oracledb';
import { tableConnection } from './catalog-connection.js';

export interface Workload {
  tables: number;
  constraints: number;
  indexes: number;
  viewDepth: number;
  latencyMs: number;
}

/** Synthetic catalog transport; no Oracle connection or application data. */
export function benchmarkConnection(workload: Workload) {
  let queries = 0;
  let peakRssBytes = process.memoryUsage().rss;
  const sample = () => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  };
  const connection = {
    async execute(sql: string, binds: Record<string, string>) {
      queries++;
      sample();
      if (workload.latencyMs)
        await new Promise((resolve) => setTimeout(resolve, workload.latencyMs));
      const owner = binds.owner ?? 'Owner "A';
      const name = binds.tableName ?? 'T0';
      const base = tableConnection((query, rows) => {
        if (query.includes('product_component_version'))
          return [{ VERSION: '23.0.0.0.0' }];
        if (query.includes('FROM dba_views'))
          return [
            {
              TEXT: 'SELECT VALUE FROM T0',
              READ_ONLY: 'N',
              BEQUEATH: 'DEFINER',
              EDITIONING_VIEW: 'N',
              CONTAINER_DATA: 'N',
              DEFAULT_COLLATION: null,
              TYPE_TEXT: null,
              SUPERVIEW_NAME: null,
              STATUS: 'VALID',
              ORACLE_MAINTAINED: 'N',
            },
          ];
        if (query.includes('FROM dba_tab_columns'))
          return [{ COLUMN_NAME: 'VALUE', POSITION: 1 }];
        if (
          query.includes('FROM dba_constraints') &&
          !query.includes('FROM dba_constraints c')
        )
          return [];
        if (query.includes("type='VIEW'")) {
          const level = Number(binds.viewName.slice(1));
          return [
            {
              REFERENCED_OWNER: owner,
              REFERENCED_NAME:
                level + 1 < workload.viewDepth ? `V${level + 1}` : 'T0',
              REFERENCED_TYPE:
                level + 1 < workload.viewDepth ? 'VIEW' : 'TABLE',
              REFERENCED_LINK_NAME: null,
            },
          ];
        }
        if (query.includes('FROM dba_dependencies')) return [];
        if (query.includes('FROM dba_constraints c'))
          return Array.from({ length: workload.constraints }, (_, i) => ({
            ...rows[0],
            OWNER: owner,
            CONSTRAINT_NAME: `${name}_C${i}`,
            CONSTRAINT_TYPE: 'U',
            SEARCH_CONDITION: null,
          }));
        if (query.includes('FROM dba_indexes'))
          return Array.from({ length: workload.indexes }, (_, i) => ({
            ...rows[0],
            OWNER: owner,
            INDEX_NAME: `${name}_I${i}`,
          }));
        if (query.includes('FROM dba_cons_columns')) {
          if (binds.constraintName)
            return [{ COLUMN_NAME: 'VALUE', POSITION: 1 }];
          return Object.keys(binds)
            .filter((key) => key.startsWith('name'))
            .map((key) => ({
              MEMBER_OWNER: binds[`owner${key.slice(4)}`],
              MEMBER_NAME: binds[key],
              COLUMN_NAME: 'VALUE',
              POSITION: 1,
            }));
        }
        if (
          query.includes('FROM dba_ind_columns') ||
          query.includes('FROM dba_ind_expressions')
        ) {
          if (binds.indexName) return rows;
          return Object.keys(binds)
            .filter((key) => key.startsWith('name'))
            .map((key) => ({
              ...rows[0],
              MEMBER_OWNER: binds[`owner${key.slice(4)}`],
              MEMBER_NAME: binds[key],
            }));
        }
        return rows;
      });
      return base.execute(sql, binds);
    },
  } as unknown as Connection;
  return {
    connection,
    stats: () => {
      sample();
      return { queries, peakRssBytes };
    },
  };
}
