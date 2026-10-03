import assert from 'node:assert/strict';
import oracle from 'oracledb';

/** Expectations come from seed DDL, never from an extracted document. */
export async function assertIndependentFacts(
  connectString: string,
  password: string,
) {
  const connection = await oracle.getConnection({
    user: 'SYSTEM',
    password,
    connectString,
  });
  const rows = async (sql: string) =>
    (
      await connection.execute(
        sql,
        {},
        {
          outFormat: oracle.OUT_FORMAT_ARRAY,
        },
      )
    ).rows;
  try {
    assert.deepEqual(
      await rows(`SELECT index_name, table_owner, table_name FROM dba_indexes
      WHERE owner='INDEX_SCHEMA' ORDER BY index_name`),
      [
        ['PERMISSION_KEY_IX', 'IAM', 'PERMISSIONS'],
        ['PERMISSION_LOOKUP_IX', 'IAM', 'PERMISSIONS'],
        ['PERMISSION_LOWER_IX', 'IAM', 'PERMISSIONS'],
      ],
    );
    assert.deepEqual(
      await rows(`SELECT index_owner, index_name FROM dba_constraints
      WHERE owner='IAM' AND constraint_name='CROSS_PERMISSION_UQ'`),
      [['INDEX_SCHEMA', 'PERMISSION_KEY_IX']],
    );
    assert.deepEqual(
      await rows(`SELECT column_name, column_position FROM dba_ind_columns
        WHERE index_owner='INDEX_SCHEMA' AND index_name='PERMISSION_KEY_IX'
        ORDER BY column_position`),
      [
        ['PERMISSION_ID', 1],
        ['PERMISSION_KEY', 2],
      ],
    );
    assert.deepEqual(
      await rows(
        `SELECT privilege FROM dba_tab_privs WHERE grantee='INDEX_SCHEMA'`,
      ),
      [],
    );

    assert.deepEqual(
      await rows(`SELECT column_name, data_type, data_precision, data_scale,
      char_length, char_used FROM dba_tab_columns
      WHERE owner='IAM' AND table_name='PERMISSIONS'
      AND column_name IN ('ROUNDED_PROBE','BYTE_PROBE','CHAR_PROBE') ORDER BY column_name`),
      [
        ['BYTE_PROBE', 'VARCHAR2', null, null, 17, 'B'],
        ['CHAR_PROBE', 'VARCHAR2', null, null, 17, 'C'],
        ['ROUNDED_PROBE', 'NUMBER', 8, -2, 0, null],
      ],
    );
    const defaults = await rows(`SELECT data_default FROM dba_tab_columns
      WHERE owner='IAM' AND table_name='PERMISSIONS' AND column_name='LITERAL_PROBE'`);
    assert.equal((defaults![0] as string[])[0].trim(), "'it''s  (exact)'");
    assert.deepEqual(
      await rows(`SELECT cc.column_name, cc.position FROM dba_cons_columns cc
      JOIN dba_constraints c ON c.owner=cc.owner AND c.constraint_name=cc.constraint_name
      WHERE c.owner='CATALOG' AND c.table_name='STOCK_LEVELS' AND c.constraint_type='P'
      ORDER BY cc.position`),
      [
        ['WAREHOUSE_ID', 1],
        ['ITEM_ID', 2],
      ],
    );
    assert.deepEqual(
      await rows(`SELECT comments FROM dba_tab_comments
      WHERE owner='IAM' AND table_name='PRINCIPALS'`),
      [["Users' directory & lifecycle — exact text"]],
    );
    assert.deepEqual(
      await rows(`SELECT comments FROM dba_col_comments
      WHERE owner='IAM' AND table_name='PRINCIPALS' AND column_name='EMAIL'`),
      [["Primary address\nUnicode Ω & apostrophe's test"]],
    );
    assert.deepEqual(
      await rows(`SELECT comments FROM dba_col_comments
      WHERE owner='CATALOG' AND table_name='PRODUCTS' AND column_name='PRODUCT_NAME'`),
      [['L'.repeat(3900)]],
    );
    assert.deepEqual(
      await rows(`SELECT owner, view_name, read_only FROM dba_views
      WHERE owner IN ('IAM','CATALOG','COMMERCE','FINANCE') ORDER BY owner, view_name`),
      [
        ['CATALOG', 'ACTIVE_PRODUCTS', 'N'],
        ['CATALOG', 'Product Availability', 'Y'],
        ['COMMERCE', 'OPEN_ORDERS', 'N'],
        ['COMMERCE', 'ORDER_PRODUCT_ROLLUP', 'Y'],
        ['FINANCE', 'OPEN_ORDER_FINANCE', 'Y'],
      ],
    );
    assert.deepEqual(
      await rows(`SELECT owner, table_name, constraint_type FROM dba_constraints
      WHERE owner IN ('IAM','CATALOG','COMMERCE','FINANCE') AND constraint_type IN ('O','V')
      ORDER BY owner, table_name`),
      [
        ['CATALOG', 'ACTIVE_PRODUCTS', 'V'],
        ['CATALOG', 'Product Availability', 'O'],
        ['COMMERCE', 'OPEN_ORDERS', 'V'],
        ['COMMERCE', 'ORDER_PRODUCT_ROLLUP', 'O'],
        ['FINANCE', 'OPEN_ORDER_FINANCE', 'O'],
      ],
    );
    assert.deepEqual(
      await rows(`SELECT owner, object_name FROM dba_objects
      WHERE owner IN ('IAM','CATALOG','COMMERCE','FINANCE') AND status <> 'VALID'`),
      [],
    );
    assert.deepEqual(
      await rows(`SELECT table_name, privilege FROM dba_tab_privs
      WHERE owner='COMMERCE' AND grantee='FINANCE'
      AND table_name IN ('OPEN_ORDERS','ORDER_PRODUCT_ROLLUP') ORDER BY table_name, privilege`),
      [
        ['OPEN_ORDERS', 'SELECT'],
        ['ORDER_PRODUCT_ROLLUP', 'SELECT'],
      ],
    );
  } finally {
    await connection.close();
  }
}

/** DML is limited to the disposable destination and rolled back. */
export async function assertDestinationBehavior(
  connectString: string,
  password: string,
) {
  const connection = await oracle.getConnection({
    user: 'SYSTEM',
    password,
    connectString,
  });
  try {
    await connection.execute(
      `INSERT INTO IAM.permissions (permission_key, resource_type, action_name)
      VALUES ('verification-probe', 'verification', 'read')`,
    );
    const result = await connection.execute(
      `SELECT literal_probe, rounded_probe FROM IAM.permissions
      WHERE permission_key='verification-probe'`,
      {},
      { outFormat: oracle.OUT_FORMAT_ARRAY },
    );
    assert.deepEqual(result.rows, [["it's  (exact)", 12300]]);
    await connection.execute(`INSERT INTO IAM.organizations (org_code, legal_name)
      VALUES ('verification-probe', 'Verification fixture')`);
    await connection.execute(`INSERT INTO CATALOG.products
      (organization_id, sku, product_name, lifecycle_status)
      SELECT organization_id, 'verification-probe', 'Verification fixture', 'ACTIVE'
      FROM IAM.organizations WHERE org_code='verification-probe'`);
    await assert.rejects(
      connection.execute(`UPDATE CATALOG.active_products SET lifecycle_status='RETIRED'
      WHERE sku='verification-probe'`),
      /ORA-01402/,
    );
    await assert.rejects(
      connection.execute(
        `UPDATE COMMERCE.order_product_rollup SET order_number='changed'`,
      ),
      // Oracle rejects this aggregate view as non-updatable first. The separate
      // simple-view probe isolates READ ONLY and requires ORA-42399 there.
      /ORA-01732/,
    );
  } finally {
    await connection.rollback();
    await connection.close();
  }
}

/** Seed-based partial-selection oracle, independent of exporter output. */
export async function assertExplicitSelectionFacts(
  connectString: string,
  password: string,
  count: number,
) {
  const connection = await oracle.getConnection({
    user: 'SYSTEM',
    password,
    connectString,
  });
  const rows = async (sql: string) =>
    (await connection.execute(sql, {}, { outFormat: oracle.OUT_FORMAT_ARRAY }))
      .rows;
  try {
    const names = ['USER_PROFILES', 'PRINCIPALS', 'ORGANIZATIONS']
      .slice(0, count)
      .sort();
    assert.deepEqual(
      await rows(
        "SELECT table_name FROM dba_tables WHERE owner='IAM' ORDER BY table_name",
      ),
      names.map((name) => [name]),
    );
    const expected =
      count === 1
        ? []
        : [
            [
              'USER_PROFILES',
              'PRINCIPAL_ID',
              1,
              'PRINCIPALS',
              'PRINCIPAL_ID',
              'CASCADE',
            ],
          ];
    if (count === 3)
      expected.unshift(
        [
          'ORGANIZATIONS',
          'PARENT_ORGANIZATION_ID',
          1,
          'ORGANIZATIONS',
          'ORGANIZATION_ID',
          'NO ACTION',
        ],
        [
          'PRINCIPALS',
          'ORGANIZATION_ID',
          1,
          'ORGANIZATIONS',
          'ORGANIZATION_ID',
          'NO ACTION',
        ],
      );
    assert.deepEqual(
      await rows(`SELECT c.table_name, cc.column_name, cc.position,
      p.table_name, pc.column_name, c.delete_rule
      FROM dba_constraints c
      JOIN dba_cons_columns cc ON cc.owner=c.owner AND cc.constraint_name=c.constraint_name
      JOIN dba_constraints p ON p.owner=c.r_owner AND p.constraint_name=c.r_constraint_name
      JOIN dba_cons_columns pc ON pc.owner=p.owner AND pc.constraint_name=p.constraint_name AND pc.position=cc.position
      WHERE c.owner='IAM' AND c.constraint_type='R'
      ORDER BY c.table_name, cc.position`),
      expected,
    );
  } finally {
    await connection.close();
  }
}

/** Partial cross-owner composite FK expectations come directly from seed DDL. */
export async function assertPartialCompositeFacts(
  connectString: string,
  password: string,
) {
  const connection = await oracle.getConnection({
    user: 'SYSTEM',
    password,
    connectString,
  });
  const rows = async (sql: string) =>
    (await connection.execute(sql, {}, { outFormat: oracle.OUT_FORMAT_ARRAY }))
      .rows;
  try {
    assert.deepEqual(
      await rows(`SELECT owner, table_name FROM dba_tables
      WHERE owner IN ('IAM','CATALOG','COMMERCE','FINANCE','INDEX_SCHEMA')
      ORDER BY owner, table_name`),
      [
        ['COMMERCE', 'ORDER_LINES'],
        ['FINANCE', 'INVOICE_LINES'],
      ],
    );
    assert.deepEqual(
      await rows(`SELECT owner, table_name, constraint_name, r_owner
      FROM dba_constraints WHERE owner IN ('COMMERCE','FINANCE') AND constraint_type='R'`),
      [['FINANCE', 'INVOICE_LINES', 'FIN_INV_LINE_ORDER_FK', 'COMMERCE']],
    );
    assert.deepEqual(
      await rows(`SELECT cc.column_name, pc.column_name, pc.position
      FROM dba_constraints c
      JOIN dba_cons_columns cc ON cc.owner=c.owner AND cc.constraint_name=c.constraint_name
      JOIN dba_constraints p ON p.owner=c.r_owner AND p.constraint_name=c.r_constraint_name
      JOIN dba_cons_columns pc ON pc.owner=p.owner AND pc.constraint_name=p.constraint_name AND pc.position=cc.position
      WHERE c.owner='FINANCE' AND c.constraint_name='FIN_INV_LINE_ORDER_FK' ORDER BY cc.position`),
      [
        ['ORDER_ID', 'ORDER_ID', 1],
        ['ORDER_LINE_NO', 'LINE_NO', 2],
      ],
    );
    assert.deepEqual(
      await rows(`SELECT owner, table_name, grantee, privilege FROM dba_tab_privs
      WHERE owner IN ('COMMERCE','FINANCE') AND privilege='REFERENCES' ORDER BY owner, table_name, grantee`),
      [['COMMERCE', 'ORDER_LINES', 'FINANCE', 'REFERENCES']],
    );
  } finally {
    await connection.close();
  }
}
