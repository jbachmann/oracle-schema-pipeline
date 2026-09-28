import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  policySchema,
  type ProgramDefinition,
  type SourceDocument,
} from '../src/model.js';
import { sourceFixture, ordinaryTable } from './fixtures.js';
import { transformSource } from '../src/transform.js';
import { validateTarget } from '../src/validate.js';
import { generateSql } from '../src/generate.js';
import { extractSource, type SourceCatalog } from '../src/extract.js';

export function procedure(name = 'P'): ProgramDefinition {
  return {
    reference: { owner: 'APP', name },
    kind: 'procedure',
    role: 'target',
    authid: 'DEFINER',
    editionable: true,
    sourceOwnerEditionsEnabled: false,
    oracleMaintained: false,
    unsupportedFeatures: [],
    units: [
      {
        type: 'PROCEDURE',
        status: 'VALID',
        sourceLines: [
          { line: 1, text: `PROCEDURE ${name} AS BEGIN NULL; END;\n` },
        ],
        dependencies: [],
        settings: {
          plsqlOptimizeLevel: 2,
          plsqlCodeType: 'INTERPRETED',
          plsqlDebug: false,
          plsqlWarnings: 'DISABLE:ALL',
          nlsLengthSemantics: 'BYTE',
          plsqlCcflags: null,
          plscopeSettings: 'IDENTIFIERS:NONE',
        },
      },
    ],
  };
}
function source(): SourceDocument {
  return {
    ...sourceFixture(),
    selectionVersion: 3,
    tables: [],
    targetTables: [],
    targetProcedures: [{ owner: 'APP', name: 'P' }],
    programs: [procedure()],
  };
}
const target = () => transformSource(source(), policySchema.parse({}));
test('program-only target validates, creates its owner and generates ordinary CREATE', () => {
  const document = target();
  assert.deepEqual(
    validateTarget(document).filter((item) => item.severity === 'error'),
    [],
  );
  const sql = generateSql(document);
  assert.match(sql, /CREATE USER "APP"/u);
  assert.match(sql, /CREATE EDITIONABLE PROCEDURE "APP"\."P"/u);
  assert.equal(
    validateTarget(document).filter(
      (item) => item.code === 'PLSQL_RUNTIME_DEPENDENCIES',
    ).length,
    1,
  );
});
test('independent validation rejects altered units, roots, roles and source facts', () => {
  for (const [mutate, code] of [
    [
      (doc: ReturnType<typeof target>) => {
        doc.programs[0].units[0].status = 'INVALID';
      },
      'INVALID_PLSQL',
    ],
    [
      (doc: ReturnType<typeof target>) => {
        doc.targetProcedures = [];
      },
      'EXTRA_PROGRAM',
    ],
    [
      (doc: ReturnType<typeof target>) => {
        doc.programs[0].oracleMaintained = true;
      },
      'UNSUPPORTED_PLSQL',
    ],
    [
      (doc: ReturnType<typeof target>) => {
        doc.programs[0].units[0].sourceLines[0].line = 2;
      },
      'PLSQL_SOURCE_MISMATCH',
    ],
    [
      (doc: ReturnType<typeof target>) => {
        doc.policy.externalPrerequisites = [
          { reference: { owner: 'APP', name: 'P' }, type: 'PROCEDURE' },
        ];
      },
      'INTERNAL_PREREQUISITE_CONFLICT',
    ],
  ] as const) {
    const document = target();
    mutate(document);
    assert.ok(validateTarget(document).some((item) => item.code === code));
    assert.throws(() => generateSql(document));
  }
});
test('self recursion is allowed and separate compilation cycles fail', () => {
  const document = target();
  document.programs[0].units[0].dependencies.push({
    reference: { owner: 'APP', name: 'P' },
    type: 'PROCEDURE',
    databaseLink: null,
    oracleMaintained: false,
  });
  assert.doesNotThrow(() => generateSql(document));
  const other = procedure('Q');
  other.role = 'dependency';
  document.programs.push(other);
  document.programs[0].units[0].dependencies.push({
    reference: other.reference,
    type: 'PROCEDURE',
    databaseLink: null,
    oracleMaintained: false,
  });
  other.units[0].dependencies.push({
    reference: document.programs[0].reference,
    type: 'PROCEDURE',
    databaseLink: null,
    oracleMaintained: false,
  });
  assert.ok(
    validateTarget(document).some(
      (item) => item.code === 'PLSQL_DEPENDENCY_CYCLE',
    ),
  );
});
test('program closure includes a table once without following its outgoing FKs', async () => {
  const definition = procedure();
  const table = ordinaryTable('APP', 'T');
  definition.units[0].dependencies.push({
    reference: table.reference,
    type: 'TABLE',
    databaseLink: null,
    oracleMaintained: false,
  });
  let tableReads = 0;
  const catalog: SourceCatalog = {
    databaseVersion: async () => '23',
    foreignKeys: async () => {
      throw new Error('Program dependencies must not expand FKs');
    },
    table: async () => {
      tableReads++;
      return structuredClone(table);
    },
    prerequisites: async () => [],
    program: async () => structuredClone(definition),
    oracleMaintained: async () => false,
  };
  const captured = await extractSource(catalog, {
    version: 3,
    tables: [],
    views: [],
    procedures: [definition.reference, definition.reference],
    packages: [],
  });
  assert.equal(tableReads, 1);
  assert.equal(captured.targetProcedures.length, 1);
  assert.equal(captured.tables[0].role, 'program-dependency');
  assert.doesNotThrow(() =>
    generateSql(transformSource(captured, policySchema.parse({}))),
  );
});

test('index-only program dependencies follow tables, while a shared table-expression dependency retains its cycle', () => {
  const captured = source();
  const table = ordinaryTable('APP', 'T');
  table.role = 'program-dependency';
  const fn: ProgramDefinition = {
    ...procedure('F'),
    kind: 'function',
    role: 'dependency',
    units: [
      {
        ...procedure().units[0],
        type: 'FUNCTION',
        sourceLines: [
          {
            line: 1,
            text: 'FUNCTION F(v NUMBER) RETURN NUMBER DETERMINISTIC AS BEGIN RETURN v; END;',
          },
        ],
        dependencies: [
          {
            reference: table.reference,
            type: 'TABLE',
            databaseLink: null,
            oracleMaintained: false,
          },
        ],
      },
    ],
  };
  const edge = {
    reference: fn.reference,
    type: 'FUNCTION',
    databaseLink: null,
    oracleMaintained: false,
  };
  table.indexes.push({
    ...table.indexes[0],
    reference: { owner: 'APP', name: 'FUNC_IX' },
    unique: false,
    type: 'FUNCTION-BASED NORMAL',
    keys: [{ column: null, expression: '"APP"."F"("ID")', direction: 'ASC' }],
    dependencies: [edge],
  });
  captured.programs[0].units[0].dependencies.push({
    reference: table.reference,
    type: 'TABLE',
    databaseLink: null,
    oracleMaintained: false,
  });
  captured.programs.push(fn);
  captured.tables.push(table);
  captured.prerequisites.push({
    ...edge,
    requiredBy: table.reference,
    origin: 'INDEX',
  });
  const document = transformSource(captured, policySchema.parse({}));
  const sql = generateSql(document);
  assert.ok(
    sql.indexOf('CREATE TABLE "APP"."T"') <
      sql.indexOf('CREATE EDITIONABLE FUNCTION'),
  );
  assert.ok(
    sql.indexOf('CREATE EDITIONABLE FUNCTION') <
      sql.indexOf('CREATE INDEX "APP"."FUNC_IX"'),
  );
  document.prerequisites.push({
    ...edge,
    requiredBy: table.reference,
    origin: 'TABLE',
  });
  assert.ok(
    validateTarget(document).some(
      (item) => item.code === 'PLSQL_DEPENDENCY_CYCLE',
    ),
  );
});

test('cross-owner table access requires explicit grants and rejects unrelated grants', () => {
  const captured = source();
  const table = ordinaryTable('DATA', 'T');
  table.role = 'program-dependency';
  captured.tables.push(table);
  captured.programs[0].units[0].dependencies.push({
    reference: table.reference,
    type: 'TABLE',
    databaseLink: null,
    oracleMaintained: false,
  });
  assert.ok(
    validateTarget(transformSource(captured, policySchema.parse({}))).some(
      (item) => item.code === 'PLSQL_REQUIRED_GRANT',
    ),
  );
  const document = transformSource(
    captured,
    policySchema.parse({
      version: 2,
      plsqlObjectGrants: [
        {
          reference: table.reference,
          grantee: 'APP',
          privileges: ['SELECT', 'UPDATE'],
        },
      ],
    }),
  );
  const sql = generateSql(document);
  assert.match(sql, /GRANT UPDATE ON "DATA"\."T" TO "APP";/u);
  assert.ok(
    sql.indexOf('GRANT UPDATE') < sql.indexOf('CREATE EDITIONABLE PROCEDURE'),
  );
  assert.ok(
    validateTarget(document).some(
      (item) => item.code === 'PLSQL_PRIVILEGE_REVIEW',
    ),
  );
  if (document.policy.version === 2)
    document.policy.plsqlObjectGrants[0].grantee = 'UNRELATED';
  assert.throws(() => generateSql(document));
});

test('a package root cannot disguise a conflicting standalone procedure request', async () => {
  const captured = source();
  captured.programs = [
    {
      ...procedure(),
      kind: 'package',
      publicProcedures: [],
      bodyRequired: false,
      units: [
        {
          ...procedure().units[0],
          type: 'PACKAGE',
          sourceLines: [{ line: 1, text: 'PACKAGE P AS n NUMBER; END;' }],
        },
      ],
    },
  ];
  captured.targetPackages = [{ owner: 'APP', name: 'P' }];
  const document = transformSource(captured, policySchema.parse({}));
  assert.ok(
    validateTarget(document).some(
      (item) => item.code === 'PLSQL_SOURCE_MISMATCH',
    ),
  );
  const catalog: SourceCatalog = {
    databaseVersion: async () => '23',
    foreignKeys: async () => [],
    table: async () => {
      throw new Error('Unexpected table');
    },
    prerequisites: async () => [],
    program: async () => structuredClone(captured.programs[0]),
    oracleMaintained: async () => false,
  };
  await assert.rejects(
    extractSource(catalog, {
      version: 3,
      tables: [],
      views: [],
      procedures: captured.targetProcedures,
      packages: captured.targetPackages,
    }),
    /PLSQL_SOURCE_MISMATCH/u,
  );
});

test('an index waits for executable package bodies reached through a function and view', () => {
  const captured = source();
  const table = ordinaryTable('APP', 'T');
  table.role = 'program-dependency';
  const reference = { owner: 'APP', name: 'ZZ' };
  const edge = (name: string, type: string) => ({
    reference: { owner: 'APP', name },
    type,
    databaseLink: null,
    oracleMaintained: false,
  });
  const fn: ProgramDefinition = {
    ...procedure('F'),
    kind: 'function',
    role: 'dependency',
    units: [
      {
        ...procedure().units[0],
        type: 'FUNCTION',
        sourceLines: [
          {
            line: 1,
            text: 'FUNCTION F(v NUMBER) RETURN NUMBER DETERMINISTIC AS n NUMBER; BEGIN SELECT ID INTO n FROM APP.V; RETURN n; END;',
          },
        ],
        dependencies: [edge('V', 'VIEW')],
      },
    ],
  };
  const pkg: ProgramDefinition = {
    ...procedure('ZZ'),
    kind: 'package',
    role: 'dependency',
    bodyRequired: true,
    publicProcedures: [],
    reference,
    units: [
      {
        ...procedure().units[0],
        type: 'PACKAGE',
        sourceLines: [
          {
            line: 1,
            text: 'PACKAGE ZZ AS FUNCTION VALUE_OF RETURN NUMBER; END;',
          },
        ],
      },
      {
        ...procedure().units[0],
        type: 'PACKAGE BODY',
        sourceLines: [
          {
            line: 1,
            text: 'PACKAGE BODY ZZ AS FUNCTION VALUE_OF RETURN NUMBER IS BEGIN APP.Q0; RETURN 7; END; END;',
          },
        ],
        dependencies: [edge('Q0', 'PROCEDURE')],
      },
    ],
  };
  const chain = Array.from({ length: 5 }, (_, index) => {
    const program = procedure(`Q${index}`);
    program.role = 'dependency';
    if (index < 4)
      program.units[0].dependencies.push(edge(`Q${index + 1}`, 'PROCEDURE'));
    return program;
  });
  table.indexes.push({
    ...table.indexes[0],
    reference: { owner: 'APP', name: 'FUNC_IX' },
    unique: false,
    type: 'FUNCTION-BASED NORMAL',
    keys: [{ column: null, expression: '"APP"."F"("ID")', direction: 'ASC' }],
    dependencies: [edge('F', 'FUNCTION')],
  });
  captured.tables.push(table);
  captured.views.push({
    reference: { owner: 'APP', name: 'V' },
    role: 'dependency',
    columns: ['ID'],
    query: 'SELECT APP.ZZ.VALUE_OF AS ID FROM DUAL',
    readOnly: false,
    checkOption: 'NONE',
    bequeath: 'DEFINER',
    status: 'VALID',
    collation: null,
    editioning: false,
    typed: false,
    superview: false,
    containerData: false,
    dependencies: [edge('ZZ', 'PACKAGE')],
    unsupportedFeatures: [],
  });
  captured.programs[0].units[0].dependencies.push(edge('T', 'TABLE'));
  captured.programs.push(fn, pkg, ...chain);
  captured.prerequisites.push({
    ...edge('F', 'FUNCTION'),
    requiredBy: table.reference,
    origin: 'INDEX',
  });
  const sql = generateSql(transformSource(captured, policySchema.parse({})));
  assert.ok(
    sql.indexOf('CREATE EDITIONABLE PACKAGE BODY "APP"."ZZ"') <
      sql.indexOf('CREATE INDEX "APP"."FUNC_IX"'),
  );
});

test('program context expands an already-read table once and leaves unrelated legacy prerequisites external', async () => {
  const a = ordinaryTable('APP', 'A');
  const b = ordinaryTable('APP', 'B');
  const dependencies = (name: string) => [
    { reference: { owner: 'APP', name }, type: 'FUNCTION', databaseLink: null },
  ];
  for (const [table, name] of [
    [a, 'EXTERNAL_FN'],
    [b, 'F'],
  ] as const)
    table.indexes.push({
      ...table.indexes[0],
      reference: { owner: 'APP', name: `IX_${table.reference.name}` },
      type: 'FUNCTION-BASED NORMAL',
      unique: false,
      keys: [{ column: null, expression: `APP.${name}(ID)`, direction: 'ASC' }],
      dependencies: dependencies(name),
    });
  const p = procedure();
  p.units[0].dependencies.push({
    reference: b.reference,
    type: 'TABLE',
    databaseLink: null,
    oracleMaintained: false,
  });
  const f: ProgramDefinition = {
    ...procedure('F'),
    kind: 'function',
    role: 'dependency',
    units: [
      {
        ...procedure().units[0],
        type: 'FUNCTION',
        sourceLines: [
          {
            line: 1,
            text: 'FUNCTION F(v NUMBER) RETURN NUMBER DETERMINISTIC AS BEGIN RETURN v; END;',
          },
        ],
      },
    ],
  };
  const reads = new Map<string, number>();
  const catalog: SourceCatalog = {
    databaseVersion: async () => '23',
    foreignKeys: async () => [],
    table: async (reference) => {
      reads.set(reference.name, (reads.get(reference.name) ?? 0) + 1);
      return structuredClone(reference.name === 'A' ? a : b);
    },
    prerequisites: async (reference) =>
      dependencies(reference.name === 'A' ? 'EXTERNAL_FN' : 'F').map(
        (edge) => ({ ...edge, requiredBy: reference, origin: 'INDEX' }),
      ),
    oracleMaintained: async () => false,
    program: async (reference) => {
      assert.notEqual(reference.name, 'EXTERNAL_FN');
      return structuredClone(reference.name === 'P' ? p : f);
    },
  };
  const captured = await extractSource(catalog, {
    version: 3,
    tables: [a.reference, b.reference],
    views: [],
    procedures: [p.reference],
    packages: [],
  });
  assert.deepEqual(
    [...reads.entries()],
    [
      ['A', 1],
      ['B', 1],
    ],
  );
  assert.deepEqual(
    captured.programs.map((program) => program.reference.name),
    ['F', 'P'],
  );
  const document = transformSource(
    captured,
    policySchema.parse({
      createSchemas: false,
      externalPrerequisites: [
        { reference: { owner: 'APP', name: 'EXTERNAL_FN' }, type: 'FUNCTION' },
      ],
    }),
  );
  assert.doesNotThrow(() => generateSql(document));
});

for (const shape of ['deep', 'wide', 'diamond'] as const) {
  test(`recursive ${shape} program closure deduplicates work and terminates`, async () => {
    const count = shape === 'deep' ? 130 : 66;
    const definitions = Array.from({ length: count }, (_, index) =>
      procedure(`P${index}`),
    );
    for (const [index, program] of definitions.entries()) {
      program.role = index === 0 ? 'target' : 'dependency';
      const children =
        shape === 'deep'
          ? index + 1 < count
            ? [index + 1]
            : []
          : index === 0
            ? Array.from({ length: count - 1 }, (_, i) => i + 1)
            : shape === 'diamond' && index < count - 1
              ? [count - 1]
              : [];
      program.units[0].dependencies = children.map((child) => ({
        reference: definitions[child].reference,
        type: 'PROCEDURE',
        databaseLink: null,
        oracleMaintained: false,
      }));
    }
    const reads = new Map<string, number>();
    const catalog: SourceCatalog = {
      databaseVersion: async () => '23',
      foreignKeys: async () => [],
      table: async () => {
        throw new Error('Unexpected table');
      },
      prerequisites: async () => [],
      oracleMaintained: async () => false,
      program: async (reference) => {
        reads.set(reference.name, (reads.get(reference.name) ?? 0) + 1);
        return structuredClone(
          definitions.find(
            (program) => program.reference.name === reference.name,
          )!,
        );
      },
    };
    const captured = await extractSource(catalog, {
      version: 3,
      tables: [],
      views: [],
      procedures: [definitions[0].reference],
      packages: [],
    });
    assert.equal(captured.programs.length, count);
    assert.ok([...reads.values()].every((value) => value === 1));
    const document = transformSource(captured, policySchema.parse({}));
    const sql = generateSql(document);
    document.programs.reverse();
    for (const program of document.programs)
      program.units[0].dependencies.reverse();
    assert.equal(generateSql(document), sql);
  });
}

test('automatic program grants never target PUBLIC', async () => {
  const { programRequirements } = await import('../src/program-grants.js');
  const document = target();
  const called = procedure('CALLED');
  document.programs.push(called);
  document.programs[0].reference.owner = 'PUBLIC';
  document.programs[0].units[0].dependencies.push({
    reference: called.reference,
    type: 'PROCEDURE',
    databaseLink: null,
    oracleMaintained: false,
  });
  const requirements = programRequirements(document);
  assert.equal(requirements.grants.length, 0);
  assert.ok(
    requirements.diagnostics.some(
      (item) =>
        item.severity === 'error' && item.code === 'PLSQL_REQUIRED_GRANT',
    ),
  );
});
