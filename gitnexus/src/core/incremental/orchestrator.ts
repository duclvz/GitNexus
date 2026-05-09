/**
 * Incremental-indexing orchestrator helpers.
 *
 * High-level helpers used by `run-analyze.ts` to keep the incremental path
 * out of the main full-rebuild orchestrator function. Each helper has one
 * responsibility:
 *
 *   isIncrementalEligible(...)       — should this run go incremental?
 *   computeIncrementalClosure(...)   — git diff → content-hash → closure
 *   extractIncrementalSubgraph(...)  — ctx.graph → "nodes/edges to write"
 *   commitIncrementalProgress(...)   — set the dirty flag in meta.json
 *
 * See docs/superpowers/specs/2026-05-10-incremental-indexing-design.md.
 */

import { execFileSync } from 'child_process';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../graph/graph.js';
import type { KnowledgeGraph } from '../graph/types.js';
import {
  type RepoMeta,
  INCREMENTAL_SCHEMA_VERSION,
  saveMeta,
} from '../../storage/repo-manager.js';
import { hasGitDir } from '../../storage/git.js';
import {
  getChangedFilesSinceCommit,
  type ChangedFiles,
} from './git-diff.js';
import { computeImporterClosure } from './closure.js';
import { computeFileHashes } from './file-hash.js';
import { queryImporters } from '../lbug/lbug-adapter.js';

/** Decision returned by isIncrementalEligible. */
export interface IncrementalEligibility {
  /** True iff this run should attempt the incremental path. */
  eligible: boolean;
  /** When `eligible === false`, a short reason for logging. */
  reason?: string;
  /** The previous lastCommit, when eligible. */
  lastCommit?: string;
}

/**
 * Decide whether a run is eligible for the incremental path.
 *
 * All conditions must hold:
 *   - --force not passed
 *   - existing meta.json present and previously a full rebuild has populated
 *     surfaceSignatures + schemaVersion (matching CURRENT)
 *   - repo has .git (non-git repos always do full rebuild)
 *   - meta.lastCommit still resolvable (not rebased away)
 *   - no incrementalInProgress flag (would force full rebuild for safety)
 */
export function isIncrementalEligible(
  repoPath: string,
  existingMeta: RepoMeta | null | undefined,
  optionsForce: boolean | undefined,
): IncrementalEligibility {
  if (optionsForce) {
    return { eligible: false, reason: '--force passed' };
  }
  if (!existingMeta) {
    return { eligible: false, reason: 'no existing index' };
  }
  if (existingMeta.incrementalInProgress) {
    return {
      eligible: false,
      reason: 'previous incremental run did not complete cleanly',
    };
  }
  if (
    existingMeta.schemaVersion === undefined ||
    existingMeta.schemaVersion !== INCREMENTAL_SCHEMA_VERSION
  ) {
    return {
      eligible: false,
      reason: `schemaVersion mismatch (have ${existingMeta.schemaVersion}, want ${INCREMENTAL_SCHEMA_VERSION})`,
    };
  }
  if (!existingMeta.surfaceSignatures || Object.keys(existingMeta.surfaceSignatures).length === 0) {
    return {
      eligible: false,
      reason: 'no prior surfaceSignatures in meta.json',
    };
  }
  if (!hasGitDir(repoPath)) {
    return { eligible: false, reason: 'non-git repo' };
  }
  if (!existingMeta.lastCommit) {
    return { eligible: false, reason: 'no lastCommit recorded' };
  }
  if (!commitExists(repoPath, existingMeta.lastCommit)) {
    return {
      eligible: false,
      reason: `lastCommit ${existingMeta.lastCommit.slice(0, 7)} not in repo`,
    };
  }
  return { eligible: true, lastCommit: existingMeta.lastCommit };
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

export interface IncrementalSetupResult {
  /** Files that must be re-parsed in this run. */
  closure: Set<string>;
  /** Files deleted on disk since lastCommit (rows must be removed from DB). */
  deletedFiles: string[];
  /** Per-file content hashes computed during closure expansion. */
  newFileHashes: Map<string, string>;
  /** ChangedFiles result for diagnostics. */
  changes: ChangedFiles;
}

/**
 * Compute the closure of files to re-parse for an incremental run.
 *
 * Algorithm:
 *   1. git diff lastCommit HEAD ∪ git status → ChangedFiles
 *   2. closure ← modified ∪ added
 *   3. For each f in closure: hash(f); if hash differs from previous, query
 *      DB importers and add them to closure. Iterate to fixpoint.
 *
 * Throws if `lastCommit` is gone (caller should fall back to full rebuild).
 */
export async function computeIncrementalClosure(
  repoPath: string,
  lastCommit: string,
  prevSurfaces: Record<string, string>,
): Promise<IncrementalSetupResult> {
  const changes = getChangedFilesSinceCommit(repoPath, lastCommit);

  const initialChangedFiles = new Set<string>([...changes.modified, ...changes.added]);

  // Closure module wants generic parseFile + surfaceFor. v1 uses
  // file-content hashes (cheap, conservative). The "ParseResult" type
  // is just the content hash itself.
  const { closure, newSurfaces } = await computeImporterClosure<string>({
    initialChangedFiles,
    prevSurfaces,
    parseFile: async (filePath) => {
      const hashes = await computeFileHashes(repoPath, [filePath]);
      // Missing files (race with delete) → empty hash; counts as "changed".
      return hashes.get(filePath) ?? '';
    },
    surfaceFor: (_filePath, parsed) => parsed,
    queryImporters: async (filePath) => queryImporters(filePath),
  });

  return {
    closure,
    deletedFiles: changes.deleted,
    newFileHashes: newSurfaces,
    changes,
  };
}

/**
 * Persist the `incrementalInProgress` dirty flag to meta.json BEFORE any
 * destructive DB mutation. The flag is cleared on success by overwriting
 * meta.json with the final state. If the run crashes between, the next
 * run sees the flag and forces a full rebuild.
 */
export async function commitIncrementalProgress(
  storagePath: string,
  existingMeta: RepoMeta,
  closure: Set<string>,
): Promise<void> {
  const meta: RepoMeta = {
    ...existingMeta,
    incrementalInProgress: {
      closure: [...closure],
      startedAt: Date.now(),
    },
  };
  await saveMeta(storagePath, meta);
}

/**
 * Build a subgraph of `ctx.graph` containing ONLY the nodes/edges that
 * need to be written to LadybugDB in incremental mode:
 *
 *   - All nodes whose filePath is in `closure` (newly parsed in this run).
 *   - All graph-wide nodes (Community, Process) — they're regenerated by
 *     the communities/processes phases on every run.
 *   - All edges where AT LEAST ONE endpoint is in this set. Edges entirely
 *     between hydrated unchanged-file nodes are NOT included — they're
 *     already in the DB and re-inserting them would PK-conflict.
 *
 * This lets us call the existing `loadGraphToLbug` against the filtered
 * subgraph: the COPY semantics will write only what's missing, while the
 * unchanged-unchanged DB rows we never deleted stay intact.
 */
export function extractIncrementalSubgraph(
  fullGraph: KnowledgeGraph,
  closure: ReadonlySet<string>,
): KnowledgeGraph {
  const sub = createKnowledgeGraph();

  const isGraphWide = (label: string): boolean => label === 'Community' || label === 'Process';

  // Phase 1: nodes
  const writableNodeIds = new Set<string>();
  fullGraph.forEachNode((n: GraphNode) => {
    const filePath = n.properties?.filePath as string | undefined;
    const inClosure = filePath ? closure.has(filePath) : false;
    if (inClosure || isGraphWide(n.label)) {
      sub.addNode(n);
      writableNodeIds.add(n.id);
    }
  });

  // Phase 2: edges where AT LEAST ONE endpoint is in the writable set.
  // Edges entirely between hydrated nodes are skipped (already in DB).
  fullGraph.forEachRelationship((r: GraphRelationship) => {
    if (writableNodeIds.has(r.sourceId) || writableNodeIds.has(r.targetId)) {
      sub.addRelationship(r);
    }
  });

  return sub;
}

/**
 * Compute the surface signatures for every file in the repo from a graph.
 * In v1 this is just the per-file content hash (cheap, conservative). v2
 * will switch to true surface-only signatures derived via `surface.ts`.
 *
 * Used after a full rebuild to populate `meta.json.surfaceSignatures` so
 * the next run can run incrementally.
 */
export async function computeAllFileSignatures(
  repoPath: string,
  filePaths: readonly string[],
): Promise<Record<string, string>> {
  const map = await computeFileHashes(repoPath, filePaths);
  const out: Record<string, string> = {};
  for (const [k, v] of map) out[k] = v;
  return out;
}

/**
 * Merge an updated set of file hashes into a previous snapshot. Used after
 * an incremental run: `prevSurfaces` is the set in meta.json, `newSurfaces`
 * is what we computed for closure files this run, and `deletedFiles` are
 * files that no longer exist on disk.
 */
export function mergeSurfaceSignatures(
  prevSurfaces: Record<string, string>,
  newSurfaces: Map<string, string>,
  deletedFiles: readonly string[],
): Record<string, string> {
  const merged: Record<string, string> = { ...prevSurfaces };
  for (const f of deletedFiles) delete merged[f];
  for (const [f, h] of newSurfaces) merged[f] = h;
  return merged;
}
