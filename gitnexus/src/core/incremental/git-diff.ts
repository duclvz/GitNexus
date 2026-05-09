/**
 * Git-based change detection for incremental indexing.
 *
 * Combines `git diff --name-status <lastCommit> HEAD` (committed changes since
 * last index) with `git status --porcelain` (uncommitted/dirty tree changes)
 * to produce a precise per-file change set.
 *
 * Renames (R<sim> in diff output, R   in porcelain) are flattened into
 * delete(old) + add(new) — downstream consumers don't need to know about
 * renames specifically; they just need to know "this path's nodes are stale,
 * delete them" and "this path is new, parse it".
 *
 * Returns a typed result; throws `LastCommitMissingError` when `lastCommit`
 * no longer exists in the repository (rebase or shallow clone). Callers
 * should fall back to a full rebuild on this error.
 */

import { execFileSync } from 'child_process';

export interface ChangedFiles {
  /** Files whose content changed (re-parse needed). */
  modified: string[];
  /** Files newly introduced since lastCommit (re-parse needed). */
  added: string[];
  /** Files that existed at lastCommit but no longer do (delete-only, no parse). */
  deleted: string[];
}

export class LastCommitMissingError extends Error {
  constructor(commit: string) {
    super(`lastCommit ${commit} not found in repository — cannot compute incremental diff`);
    this.name = 'LastCommitMissingError';
  }
}

/**
 * Compute the set of files changed in `repoPath` since `lastCommit`.
 * Combines committed differences (`git diff` against HEAD) with the
 * current dirty working-tree state (`git status`).
 *
 * @throws LastCommitMissingError when `lastCommit` is not reachable.
 */
export function getChangedFilesSinceCommit(
  repoPath: string,
  lastCommit: string,
): ChangedFiles {
  if (!commitExists(repoPath, lastCommit)) {
    throw new LastCommitMissingError(lastCommit);
  }

  const modified = new Set<string>();
  const added = new Set<string>();
  const deleted = new Set<string>();

  // ── Committed differences: lastCommit..HEAD ────────────────────────────
  // Output (NUL-delimited via -z): STATUS\0path1\0[path2\0]
  // Status codes: M, A, D, T (type change → treat as modified),
  //               R<sim>, C<sim> (rename/copy with similarity %).
  const diffRaw = runGit(repoPath, [
    'diff',
    '--name-status',
    '-z',
    `${lastCommit}`,
    'HEAD',
  ]);

  for (const entry of parseNameStatusZ(diffRaw)) {
    classify(entry, modified, added, deleted);
  }

  // ── Working-tree differences: HEAD..disk ───────────────────────────────
  // Format (NUL-delimited): XY<space>path[\0orig-path]
  // X = staged, Y = unstaged. Either non-' ' counts as a change.
  const statusRaw = runGit(repoPath, ['status', '--porcelain', '-z']);
  for (const entry of parsePorcelainZ(statusRaw)) {
    classify(entry, modified, added, deleted);
  }

  // Resolve overlaps: a file added in the diff and modified in the status
  // is just "new on disk" → keep it in `added`. A file deleted in the diff
  // but present in status as added (re-introduced) → modified.
  for (const f of added) {
    modified.delete(f);
    deleted.delete(f);
  }
  for (const f of deleted) {
    modified.delete(f);
  }

  return {
    modified: [...modified].sort(),
    added: [...added].sort(),
    deleted: [...deleted].sort(),
  };
}

interface ParsedEntry {
  status: string;
  path: string;
  origPath?: string;
}

function classify(
  entry: ParsedEntry,
  modified: Set<string>,
  added: Set<string>,
  deleted: Set<string>,
): void {
  const code = entry.status[0];
  switch (code) {
    case 'M':
    case 'T': // type change (file → symlink, etc.)
      modified.add(entry.path);
      break;
    case 'A':
    case '?': // untracked (porcelain '??') treat as added
      added.add(entry.path);
      break;
    case 'D':
      deleted.add(entry.path);
      break;
    case 'R': // rename: flatten to delete(orig) + add(new)
    case 'C': // copy: original survives; new file is added
      if (entry.origPath && code === 'R') deleted.add(entry.origPath);
      added.add(entry.path);
      break;
    case 'U': // unmerged — surface as modified, caller's problem
      modified.add(entry.path);
      break;
    default:
      // Unknown status — be conservative, treat as modified.
      modified.add(entry.path);
  }
}

/**
 * Parse `git diff --name-status -z` output. NUL-delimited, status before each path:
 *   "M\0a.ts\0A\0b.ts\0R100\0old.ts\0new.ts\0"
 */
function parseNameStatusZ(raw: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  if (!raw) return entries;
  const tokens = raw.split('\0').filter((t) => t.length > 0);
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i++];
    const path = tokens[i++];
    if (path === undefined) break;
    if (status[0] === 'R' || status[0] === 'C') {
      const newPath = tokens[i++];
      if (newPath !== undefined) {
        entries.push({ status, path: newPath, origPath: path });
      }
    } else {
      entries.push({ status, path });
    }
  }
  return entries;
}

/**
 * Parse `git status --porcelain -z` output. NUL-delimited, two-char status
 * code + space + path; for renames the original path follows after another NUL:
 *   "M  a.ts\0?? b.ts\0R  new.ts\0old.ts\0"
 */
function parsePorcelainZ(raw: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  if (!raw) return entries;
  const tokens = raw.split('\0').filter((t) => t.length > 0);
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i++];
    // First two chars are the XY status, then a space, then the path.
    const xy = tok.slice(0, 2);
    const path = tok.slice(3);
    // Effective status: prefer staged (X) when not ' ', otherwise unstaged (Y).
    const code = xy[0] !== ' ' && xy[0] !== '?' ? xy[0] : xy[1];
    if (xy.startsWith('R') || xy[1] === 'R') {
      // Rename: next token is the original path.
      const orig = tokens[i++];
      entries.push({ status: 'R', path, origPath: orig });
    } else if (xy === '??') {
      entries.push({ status: '?', path });
    } else {
      entries.push({ status: code, path });
    }
  }
  return entries;
}

function commitExists(repoPath: string, commit: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], {
      cwd: repoPath,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function runGit(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    // Larger buffer for large repos with many changes.
    maxBuffer: 100 * 1024 * 1024,
  });
}
