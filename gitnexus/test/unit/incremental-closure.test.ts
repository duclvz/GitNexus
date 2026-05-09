import { describe, it, expect, vi } from 'vitest';
import { computeImporterClosure } from '../../src/core/incremental/closure.js';

/**
 * Mini test harness: a fixture import graph + per-file surface signatures.
 *
 * `imports[X] = [a, b]` means files `a` and `b` import file `X`. So when we
 * ask for "importers of X" the answer is `[a, b]`.
 */
interface Fixture {
  files: string[];
  /** target → list of importers */
  imports: Record<string, string[]>;
  /** previous surfaces */
  prevSurfaces: Record<string, string>;
  /** new surfaces (what parseFile + surfaceFor will produce) */
  newSurfaces: Record<string, string>;
}

function makeHarness(fx: Fixture) {
  const parseFile = vi.fn(async (f: string) => ({ filePath: f }));
  const surfaceFor = vi.fn((f: string) => fx.newSurfaces[f] ?? '');
  const queryImporters = vi.fn(async (f: string) => fx.imports[f] ?? []);
  return { parseFile, surfaceFor, queryImporters };
}

describe('computeImporterClosure', () => {
  it('empty input → empty closure', async () => {
    const { parseFile, surfaceFor, queryImporters } = makeHarness({
      files: [],
      imports: {},
      prevSurfaces: {},
      newSurfaces: {},
    });
    const r = await computeImporterClosure({
      initialChangedFiles: new Set(),
      prevSurfaces: {},
      parseFile,
      surfaceFor,
      queryImporters,
    });
    expect(r.closure.size).toBe(0);
    expect(parseFile).not.toHaveBeenCalled();
  });

  it('single file with unchanged surface → closure size 1, no expansion', async () => {
    const { parseFile, surfaceFor, queryImporters } = makeHarness({
      files: ['a.ts'],
      imports: { 'a.ts': ['b.ts', 'c.ts'] },
      prevSurfaces: { 'a.ts': 'sig-a-v1' },
      newSurfaces: { 'a.ts': 'sig-a-v1' }, // same
    });
    const r = await computeImporterClosure({
      initialChangedFiles: new Set(['a.ts']),
      prevSurfaces: { 'a.ts': 'sig-a-v1' },
      parseFile,
      surfaceFor,
      queryImporters,
    });
    expect([...r.closure].sort()).toEqual(['a.ts']);
    // queryImporters should not have been called: surface unchanged.
    expect(queryImporters).not.toHaveBeenCalled();
    expect(r.expandedFromImporters.size).toBe(0);
  });

  it('single file with changed surface → expands to direct importers', async () => {
    const { parseFile, surfaceFor, queryImporters } = makeHarness({
      files: ['a.ts', 'b.ts', 'c.ts'],
      imports: {
        'a.ts': ['b.ts', 'c.ts'],
        'b.ts': [],
        'c.ts': [],
      },
      prevSurfaces: { 'a.ts': 'sig-old', 'b.ts': 'sig-b', 'c.ts': 'sig-c' },
      newSurfaces: { 'a.ts': 'sig-new', 'b.ts': 'sig-b', 'c.ts': 'sig-c' },
    });
    const r = await computeImporterClosure({
      initialChangedFiles: new Set(['a.ts']),
      prevSurfaces: { 'a.ts': 'sig-old', 'b.ts': 'sig-b', 'c.ts': 'sig-c' },
      parseFile,
      surfaceFor,
      queryImporters,
    });
    expect([...r.closure].sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect([...r.expandedFromImporters].sort()).toEqual(['b.ts', 'c.ts']);
  });

  it('multi-hop cascade (A surface change → B in closure → B surface change → C in closure)', async () => {
    const { parseFile, surfaceFor, queryImporters } = makeHarness({
      files: ['a.ts', 'b.ts', 'c.ts'],
      imports: {
        'a.ts': ['b.ts'], // b imports a
        'b.ts': ['c.ts'], // c imports b
        'c.ts': [],
      },
      prevSurfaces: { 'a.ts': 'old', 'b.ts': 'b-old', 'c.ts': 'c-stable' },
      newSurfaces: { 'a.ts': 'new', 'b.ts': 'b-new', 'c.ts': 'c-stable' },
    });
    const r = await computeImporterClosure({
      initialChangedFiles: new Set(['a.ts']),
      prevSurfaces: { 'a.ts': 'old', 'b.ts': 'b-old', 'c.ts': 'c-stable' },
      parseFile,
      surfaceFor,
      queryImporters,
    });
    expect([...r.closure].sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('cascade halts when surface stops changing mid-chain', async () => {
    const { parseFile, surfaceFor, queryImporters } = makeHarness({
      files: ['a.ts', 'b.ts', 'c.ts'],
      imports: {
        'a.ts': ['b.ts'],
        'b.ts': ['c.ts'],
      },
      // a's surface changed, b is in closure but b's surface unchanged → c stays out
      prevSurfaces: { 'a.ts': 'old', 'b.ts': 'b-stable', 'c.ts': 'c-stable' },
      newSurfaces: { 'a.ts': 'new', 'b.ts': 'b-stable', 'c.ts': 'c-stable' },
    });
    const r = await computeImporterClosure({
      initialChangedFiles: new Set(['a.ts']),
      prevSurfaces: { 'a.ts': 'old', 'b.ts': 'b-stable', 'c.ts': 'c-stable' },
      parseFile,
      surfaceFor,
      queryImporters,
    });
    expect([...r.closure].sort()).toEqual(['a.ts', 'b.ts']);
    expect([...r.expandedFromImporters].sort()).toEqual(['b.ts']);
  });

  it('terminates on cycles in the import graph', async () => {
    // a ↔ b cycle. a's surface changes, b is added; b's surface also "changed"
    // (relative to undefined prev), so its importers are queried — which
    // includes a, already in closure. Loop terminates because closure
    // membership prevents re-add.
    const { parseFile, surfaceFor, queryImporters } = makeHarness({
      files: ['a.ts', 'b.ts'],
      imports: { 'a.ts': ['b.ts'], 'b.ts': ['a.ts'] },
      prevSurfaces: { 'a.ts': 'old', 'b.ts': 'b-old' },
      newSurfaces: { 'a.ts': 'new', 'b.ts': 'b-new' },
    });
    const r = await computeImporterClosure({
      initialChangedFiles: new Set(['a.ts']),
      prevSurfaces: { 'a.ts': 'old', 'b.ts': 'b-old' },
      parseFile,
      surfaceFor,
      queryImporters,
    });
    expect([...r.closure].sort()).toEqual(['a.ts', 'b.ts']);
    // Each file parsed exactly once even though they import each other.
    expect(parseFile).toHaveBeenCalledTimes(2);
  });

  it('newly-added file (no prev surface) triggers expansion', async () => {
    // For a brand-new file, prevSurfaces[f] is undefined → surfaceChanged
    // returns true → its importers are queried. (For a truly *new* file,
    // there should be no importers yet, so closure stays at {f}.)
    const { parseFile, surfaceFor, queryImporters } = makeHarness({
      files: ['new.ts'],
      imports: {},
      prevSurfaces: {},
      newSurfaces: { 'new.ts': 'sig-new' },
    });
    const r = await computeImporterClosure({
      initialChangedFiles: new Set(['new.ts']),
      prevSurfaces: {},
      parseFile,
      surfaceFor,
      queryImporters,
    });
    expect([...r.closure]).toEqual(['new.ts']);
    expect(queryImporters).toHaveBeenCalledOnce();
  });

  it('parses each file exactly once and caches the result', async () => {
    const { parseFile, surfaceFor, queryImporters } = makeHarness({
      files: ['a.ts', 'b.ts'],
      imports: { 'a.ts': ['b.ts'] },
      prevSurfaces: { 'a.ts': 'old', 'b.ts': 'b' },
      newSurfaces: { 'a.ts': 'new', 'b.ts': 'b' },
    });
    const r = await computeImporterClosure({
      initialChangedFiles: new Set(['a.ts']),
      prevSurfaces: { 'a.ts': 'old', 'b.ts': 'b' },
      parseFile,
      surfaceFor,
      queryImporters,
    });
    expect(parseFile).toHaveBeenCalledTimes(2);
    expect(r.parseCache.size).toBe(2);
    expect(r.parseCache.has('a.ts')).toBe(true);
    expect(r.parseCache.has('b.ts')).toBe(true);
  });

  it('records new surfaces for every parsed file', async () => {
    const { parseFile, surfaceFor, queryImporters } = makeHarness({
      files: ['a.ts', 'b.ts'],
      imports: { 'a.ts': ['b.ts'] },
      prevSurfaces: { 'a.ts': 'old', 'b.ts': 'b-old' },
      newSurfaces: { 'a.ts': 'new', 'b.ts': 'b-new' },
    });
    const r = await computeImporterClosure({
      initialChangedFiles: new Set(['a.ts']),
      prevSurfaces: { 'a.ts': 'old', 'b.ts': 'b-old' },
      parseFile,
      surfaceFor,
      queryImporters,
    });
    expect(r.newSurfaces.get('a.ts')).toBe('new');
    expect(r.newSurfaces.get('b.ts')).toBe('b-new');
  });
});
