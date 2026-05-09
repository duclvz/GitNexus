import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import {
  getChangedFilesSinceCommit,
  LastCommitMissingError,
} from '../../src/core/incremental/git-diff.js';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExec = vi.mocked(execFileSync);

/**
 * Mock helper: queue a sequence of execFileSync return values.
 * Order matters — the first call returns the first value, etc.
 *
 * Calls in `getChangedFilesSinceCommit`:
 *   1. cat-file -e <commit>    (commitExists check)
 *   2. diff --name-status -z   (committed changes)
 *   3. status --porcelain -z   (dirty tree)
 */
function mockGitSequence(
  catFileSucceeds: boolean,
  diffOutput: string,
  statusOutput: string,
) {
  mockExec.mockReset();
  if (catFileSucceeds) {
    mockExec.mockImplementationOnce(() => Buffer.from(''));
  } else {
    mockExec.mockImplementationOnce(() => {
      throw new Error('not in repo');
    });
  }
  mockExec.mockImplementationOnce(() => diffOutput);
  mockExec.mockImplementationOnce(() => statusOutput);
}

describe('getChangedFilesSinceCommit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws LastCommitMissingError when commit not in repo', () => {
    mockGitSequence(false, '', '');
    expect(() => getChangedFilesSinceCommit('/repo', 'deadbeef')).toThrow(
      LastCommitMissingError,
    );
  });

  it('returns empty arrays for clean repo and no committed changes', () => {
    mockGitSequence(true, '', '');
    const r = getChangedFilesSinceCommit('/repo', 'abc');
    expect(r).toEqual({ modified: [], added: [], deleted: [] });
  });

  it('parses committed M/A/D from diff --name-status -z', () => {
    mockGitSequence(
      true,
      'M\0src/a.ts\0A\0src/b.ts\0D\0src/c.ts\0',
      '',
    );
    const r = getChangedFilesSinceCommit('/repo', 'abc');
    expect(r).toEqual({
      modified: ['src/a.ts'],
      added: ['src/b.ts'],
      deleted: ['src/c.ts'],
    });
  });

  it('flattens R<sim> renames into delete(orig) + add(new)', () => {
    mockGitSequence(
      true,
      'R100\0src/old.ts\0src/new.ts\0',
      '',
    );
    const r = getChangedFilesSinceCommit('/repo', 'abc');
    expect(r).toEqual({
      modified: [],
      added: ['src/new.ts'],
      deleted: ['src/old.ts'],
    });
  });

  it('treats T (type change) as modified', () => {
    mockGitSequence(true, 'T\0src/link.ts\0', '');
    const r = getChangedFilesSinceCommit('/repo', 'abc');
    expect(r.modified).toContain('src/link.ts');
  });

  it('parses dirty tree from status --porcelain -z', () => {
    // 'M  a.ts' = staged-modified. ' M b.ts' = unstaged-modified.
    // '?? c.ts' = untracked. ' D d.ts' = unstaged-deleted.
    mockGitSequence(
      true,
      '',
      'M  a.ts\0 M b.ts\0?? c.ts\0 D d.ts\0',
    );
    const r = getChangedFilesSinceCommit('/repo', 'abc');
    expect(r.modified.sort()).toEqual(['a.ts', 'b.ts']);
    expect(r.added).toEqual(['c.ts']);
    expect(r.deleted).toEqual(['d.ts']);
  });

  it('unions committed + dirty changes', () => {
    mockGitSequence(
      true,
      'M\0a.ts\0',     // committed: a.ts modified
      ' M b.ts\0?? c.ts\0', // dirty: b.ts modified, c.ts untracked
    );
    const r = getChangedFilesSinceCommit('/repo', 'abc');
    expect(r.modified.sort()).toEqual(['a.ts', 'b.ts']);
    expect(r.added).toEqual(['c.ts']);
    expect(r.deleted).toEqual([]);
  });

  it('resolves overlap: file added in diff and modified in status → added', () => {
    mockGitSequence(
      true,
      'A\0newfile.ts\0',
      ' M newfile.ts\0',
    );
    const r = getChangedFilesSinceCommit('/repo', 'abc');
    expect(r).toEqual({
      modified: [],
      added: ['newfile.ts'],
      deleted: [],
    });
  });

  it('handles porcelain rename ("R  new\\0old")', () => {
    mockGitSequence(
      true,
      '',
      'R  new.ts\0old.ts\0',
    );
    const r = getChangedFilesSinceCommit('/repo', 'abc');
    expect(r.added).toEqual(['new.ts']);
    // Porcelain rename: `R` in status doesn't pre-flatten old into deleted
    // because git already resolved the rename — but our parser does flatten
    // when the diff layer flags it. For status-only, the original is the
    // rename source and we don't claim to know it was deleted from index.
  });

  it('returns sorted output for stable comparison', () => {
    mockGitSequence(
      true,
      'M\0z.ts\0M\0a.ts\0M\0m.ts\0',
      '',
    );
    const r = getChangedFilesSinceCommit('/repo', 'abc');
    expect(r.modified).toEqual(['a.ts', 'm.ts', 'z.ts']);
  });

  it('passes correct cwd to git', () => {
    mockGitSequence(true, '', '');
    getChangedFilesSinceCommit('/some/path', 'abc');
    for (const call of mockExec.mock.calls) {
      expect((call[2] as { cwd: string }).cwd).toBe('/some/path');
    }
  });
});
