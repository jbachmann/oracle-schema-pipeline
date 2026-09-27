import assert from 'node:assert/strict';
import test from 'node:test';
import { renderIdentity } from '../src/identity.js';
import { numberColumn } from './fixtures.js';

function identityColumn(overrides: Record<string, string | null> = {}) {
  const column = numberColumn('ID', 1);
  const options = {
    'START WITH': '1',
    'INCREMENT BY': '1',
    MIN_VALUE: '1',
    MAX_VALUE: '100',
    CACHE_SIZE: '20',
    CYCLE_FLAG: 'N',
    ORDER_FLAG: 'N',
    ...overrides,
  };
  column.identity = {
    generation: 'ALWAYS',
    options: Object.entries(options)
      .filter(([, value]) => value !== null)
      .map(([name, value]) => `${name}: ${value}`)
      .join(', '),
  };
  return column;
}

test('columns without identity metadata render an empty string', () => {
  assert.equal(renderIdentity(numberColumn('ID', 1)), '');
});

test('generation modes preserve exact SQL with cache and flag alternatives', () => {
  for (const generation of ['ALWAYS', 'BY DEFAULT']) {
    for (const defaultOnNull of [false, true]) {
      if (generation === 'ALWAYS' && defaultOnNull) continue;
      for (const enabled of [false, true]) {
        const column = identityColumn({
          CACHE_SIZE: enabled ? '2' : '0',
          CYCLE_FLAG: enabled ? 'Y' : 'N',
          ORDER_FLAG: enabled ? 'Y' : 'N',
        });
        column.identity!.generation = generation;
        column.defaultOnNull = defaultOnNull;
        const mode = defaultOnNull ? 'BY DEFAULT ON NULL' : generation;
        const flags = enabled
          ? 'CACHE 2 CYCLE ORDER'
          : 'NOCACHE NOCYCLE NOORDER';
        assert.equal(
          renderIdentity(column),
          `GENERATED ${mode} AS IDENTITY (START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 100 ${flags})`,
        );
      }
    }
  }
});

test('large integers and accepted numeric spelling survive rendering', () => {
  const column = identityColumn({
    'START WITH': '0002',
    'INCREMENT BY': '-01',
    MIN_VALUE: '-0003',
    MAX_VALUE: '9999999999999999999999999999',
    CACHE_SIZE: '002',
  });
  assert.equal(
    renderIdentity(column),
    'GENERATED ALWAYS AS IDENTITY (START WITH 0002 INCREMENT BY -01 MINVALUE -0003 MAXVALUE 9999999999999999999999999999 CACHE 002 NOCYCLE NOORDER)',
  );
  assert.match(
    renderIdentity(identityColumn({ CACHE_SIZE: '-0' })),
    / NOCACHE /,
  );
});

test('sequence bounds include both endpoints and allow descending increments', () => {
  for (const start of ['1', '100']) {
    assert.match(
      renderIdentity(
        identityColumn({ 'START WITH': start, 'INCREMENT BY': '-1' }),
      ),
      new RegExp(`START WITH ${start} INCREMENT BY -1`),
    );
  }
});

test('inconsistent sequence bounds and increments are rejected', () => {
  const cases: Record<string, string>[] = [
    { 'START WITH': '0' },
    { 'START WITH': '101' },
    { MIN_VALUE: '100' },
    { MIN_VALUE: '101' },
    { 'INCREMENT BY': '0' },
  ];
  for (const options of cases) {
    assert.throws(() => renderIdentity(identityColumn(options)), {
      message: 'Inconsistent identity sequence bounds or increment.',
    });
  }
});

test('cache must be zero or at least two', () => {
  for (const cache of ['-1', '1']) {
    assert.throws(() => renderIdentity(identityColumn({ CACHE_SIZE: cache })), {
      message: 'Identity cache must be zero or at least two.',
    });
  }
});

test('integer options are required and reject non-integer syntax', () => {
  for (const name of [
    'START WITH',
    'INCREMENT BY',
    'MIN_VALUE',
    'MAX_VALUE',
    'CACHE_SIZE',
  ]) {
    for (const value of [null, ' ', '1.5', '+1', '1e2', 'NaN']) {
      assert.throws(() => renderIdentity(identityColumn({ [name]: value })), {
        message: `Missing or invalid integer identity option: ${name}`,
      });
    }
  }
});

test('cycle and order flags require uppercase Y or N', () => {
  for (const name of ['CYCLE_FLAG', 'ORDER_FLAG']) {
    for (const value of [null, ' ', 'y', 'YES', '0']) {
      assert.throws(() => renderIdentity(identityColumn({ [name]: value })), {
        message: `Missing or invalid identity flag: ${name}`,
      });
    }
  }
});

test('optional unsupported features must be disabled when present', () => {
  const expected = renderIdentity(identityColumn());
  for (const name of [
    'SCALE_FLAG',
    'EXTEND_FLAG',
    'SESSION_FLAG',
    'KEEP_VALUE',
    'SHARD_FLAG',
  ]) {
    assert.equal(renderIdentity(identityColumn({ [name]: 'N' })), expected);
    for (const value of ['Y', 'n', ' ', '0']) {
      assert.throws(() => renderIdentity(identityColumn({ [name]: value })), {
        message: `Identity feature requires a dedicated renderer: ${name}=${value.trim()}`,
      });
    }
  }
});

test('metadata parsing rejects malformed entries, duplicates, and unknown options', () => {
  for (const entry of [
    '',
    'START WITH 1',
    'START WITH: 1: 2',
    'start with: 1',
  ]) {
    const column = identityColumn();
    column.identity!.options = entry;
    assert.throws(() => renderIdentity(column), {
      message: `Unrecognized or duplicate identity option: ${entry}`,
    });
  }
  const column = identityColumn();
  column.identity!.options += ',  START WITH : 2';
  assert.throws(() => renderIdentity(column), {
    message: 'Unrecognized or duplicate identity option:   START WITH : 2',
  });
  assert.throws(() => renderIdentity(identityColumn({ UNKNOWN: '1' })), {
    message: 'Unknown identity option: UNKNOWN',
  });
});

test('metadata whitespace and entry order do not change SQL', () => {
  const column = identityColumn();
  const expected = renderIdentity(column);
  column.identity!.options = column
    .identity!.options.split(',')
    .reverse()
    .map((entry) => `  ${entry.replace(':', ' : ')}  `)
    .join(',');
  assert.equal(renderIdentity(column), expected);
});

test('invalid generation modes and ALWAYS ON NULL are rejected before parsing', () => {
  const column = identityColumn();
  column.identity!.options = 'malformed';
  column.identity!.generation = 'SOMETIMES';
  assert.throws(() => renderIdentity(column), {
    message: 'Unknown identity generation: SOMETIMES',
  });
  column.identity!.generation = 'ALWAYS';
  column.defaultOnNull = true;
  assert.throws(() => renderIdentity(column), {
    message: 'ALWAYS identity cannot also be BY DEFAULT ON NULL.',
  });
});

test('validation preserves the first diagnostic when several options are invalid', () => {
  const column = identityColumn();
  const cases = [
    ['UNKNOWN: 1,broken', 'Unrecognized or duplicate identity option: broken'],
    [
      'UNKNOWN: 1,UNKNOWN: 2',
      'Unrecognized or duplicate identity option: UNKNOWN: 2',
    ],
    ['UNKNOWN: 1,SCALE_FLAG: Y', 'Unknown identity option: UNKNOWN'],
    [
      'SCALE_FLAG: Y,UNKNOWN: 1',
      'Identity feature requires a dedicated renderer: SCALE_FLAG=Y',
    ],
    [
      'START WITH: invalid',
      'Missing or invalid integer identity option: START WITH',
    ],
  ];
  for (const [raw, message] of cases) {
    column.identity!.options = raw;
    assert.throws(() => renderIdentity(column), { message });
  }
  assert.throws(
    () =>
      renderIdentity(
        identityColumn({ 'INCREMENT BY': '0', CACHE_SIZE: 'invalid' }),
      ),
    {
      message: 'Missing or invalid integer identity option: CACHE_SIZE',
    },
  );
  assert.throws(
    () =>
      renderIdentity(identityColumn({ 'INCREMENT BY': '0', CACHE_SIZE: '1' })),
    {
      message: 'Inconsistent identity sequence bounds or increment.',
    },
  );
  assert.throws(
    () =>
      renderIdentity(
        identityColumn({ CACHE_SIZE: '1', CYCLE_FLAG: 'invalid' }),
      ),
    {
      message: 'Identity cache must be zero or at least two.',
    },
  );
});
