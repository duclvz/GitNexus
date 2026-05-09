/**
 * Shared Analysis Orchestrator
 *
 * Extracts the core analysis pipeline from the CLI analyze command into a
 * reusable function that can be called from both the CLI and a server-side
 * worker process.
 *
 * IMPORTANT: This module must NEVER call process.exit(). The caller (CLI
 * wrapper or server worker) is responsible for process lifecycle.
 */

import path from 'path';
import fs from 'fs/promises';
import { execFileSync } from 'child_process';
import { runPipelineFromRepo } from './ingestion/pipeline.js';
import {
  initLbug,
  loadGraphToLbug,
  getLbugStats,
  executeQuery,
  executeWithReusedStatement,
  closeLbug,
  loadCachedEmbeddings,
  deleteNodesForFile,
  deleteAllCommunitiesAndProcesses,
} from './lbug/lbug-adapter.js';
import { createSearchFTSIndexes } from './search/fts-indexes.js';
import {
  getStoragePaths,
  saveMeta,
  loadMeta,
  ensureGitNexusIgnored,
  registerRepo,
  cleanupOldKuzuFiles,
  INCREMENTAL_SCHEMA_VERSION,
} from '../storage/repo-manager.js';
import {
  getCurrentCommit,
  getRemoteUrl,
  hasGitDir,
  getInferredRepoName,
  resolveRepoIdentityRoot,
} from '../storage/git.js';
import type { CachedEmbedding } from './embeddings/types.js';
import { generateAIContextFiles } from '../cli/ai-context.js';
import { EMBEDDING_TABLE_NAME } from './lbug/schema.js';
import { STALE_HASH_SENTINEL } from './lbug/schema.js';
import {
  isIncrementalEligible,
  computeIncrementalClosure,
  commitIncrementalProgress,
  extractIncrementalSubgraph,
  mergeSurfaceSignatures,
  computeAllFileSignatures,
} from './incremental/orchestrator.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AnalyzeCallbacks {
  onProgress: (phase: string, percent: number, message: string) => void;
  onLog?: (message: string) => void;
}

export interface AnalyzeOptions {
  /**
   * Force a full re-index of the pipeline. Callers may OR this with
   * other flags that imply re-analysis (e.g. `--skills`), so the value
   * here is the PIPELINE-force signal, NOT the registry-collision
   * bypass. See `allowDuplicateName` below.
   */
  force?: boolean;
  embeddings?: boolean;
  /**
   * Override the auto-skip node-count cap for embedding generation.
   * `undefined` (default) keeps the built-in 50,000-node safety limit;
   * `0` disables the cap entirely; any positive integer sets a custom cap.
   * Mapped from the CLI's `--embeddings [limit]` argument.
   */
  embeddingsNodeLimit?: number;
  /**
   * Explicitly drop any embeddings present in the existing index instead of
   * preserving them. Only meaningful when `embeddings` is false/undefined:
   * the default behavior in that case is to load the previously generated
   * embeddings and re-insert them after the rebuild so a routine
   * re-analyze does not silently wipe a long embedding pass (#issue: analyze
   * silently wipes existing embeddings when run without --embeddings).
   */
  dropEmbeddings?: boolean;
  skipGit?: boolean;
  /** Skip AGENTS.md and CLAUDE.md gitnexus block updates. */
  skipAgentsMd?: boolean;
  /** Omit volatile symbol/relationship counts from AGENTS.md and CLAUDE.md. */
  noStats?: boolean;
  /**
   * User-provided alias for the registry `name` (#829). When set,
   * forwarded to `registerRepo` so the indexed repo is stored under
   * this alias instead of the path-derived basename.
   */
  registryName?: string;
  /**
   * Bypass the `RegistryNameCollisionError` guard and allow two paths
   * to register under the same `name` (#829). Controlled by the
   * dedicated `--allow-duplicate-name` CLI flag, intentionally
   * independent from `--force` — users who hit the collision guard
   * should be able to accept the duplicate without paying the cost
   * of a pipeline re-index.
   */
  allowDuplicateName?: boolean;
}

export interface AnalyzeResult {
  repoName: string;
  repoPath: string;
  stats: {
    files?: number;
    nodes?: number;
    edges?: number;
    communities?: number;
    processes?: number;
    embeddings?: number;
  };
  alreadyUpToDate?: boolean;
  /** The raw pipeline result — only populated when needed by callers (e.g. skill generation). */
  pipelineResult?: any;
}

// Re-export the pure flag-derivation helper so external callers (and tests)
// keep importing from this module's stable surface.
export { deriveEmbeddingMode, DEFAULT_EMBEDDING_NODE_LIMIT } from './embedding-mode.js';
export type { EmbeddingMode } from './embedding-mode.js';
import {
  deriveEmbeddingMode as _deriveEmbeddingMode,
  deriveEmbeddingCap,
  DEFAULT_EMBEDDING_NODE_LIMIT,
} from './embedding-mode.js';

export const PHASE_LABELS: Record<string, string> = {
  extracting: 'Scanning files',
  structure: 'Building structure',
  parsing: 'Parsing code',
  imports: 'Resolving imports',
  calls: 'Tracing calls',
  heritage: 'Extracting inheritance',
  communities: 'Detecting communities',
  processes: 'Detecting processes',
  complete: 'Pipeline complete',
  lbug: 'Loading into LadybugDB',
  fts: 'Creating search indexes',
  embeddings: 'Generating embeddings',
  done: 'Done',
};

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full GitNexus analysis pipeline.
 *
 * This is the shared core extracted from the CLI `analyze` command. It
 * handles: pipeline execution, LadybugDB loading, FTS indexing, embedding
 * generation, metadata persistence, and AI context file generation.
 *
 * The function communicates progress and log messages exclusively through
 * the {@link AnalyzeCallbacks} interface — it never writes to stdout/stderr
 * directly and never calls `process.exit()`.
 */
export async function runFullAnalysis(
  repoPath: string,
  options: AnalyzeOptions,
  callbacks: AnalyzeCallbacks,
): Promise<AnalyzeResult> {
  const log = (msg: string) => callbacks.onLog?.(msg);
  const progress = (phase: string, percent: number, message: string) =>
    callbacks.onProgress(phase, percent, message);

  const { storagePath, lbugPath } = getStoragePaths(repoPath);

  // Clean up stale KuzuDB files from before the LadybugDB migration.
  const kuzuResult = await cleanupOldKuzuFiles(storagePath);
  if (kuzuResult.found && kuzuResult.needsReindex) {
    log('Migrating from KuzuDB to LadybugDB — rebuilding index...');
  }

  const repoHasGit = hasGitDir(repoPath);
  const currentCommit = repoHasGit ? getCurrentCommit(repoPath) : '';
  const existingMeta = await loadMeta(storagePath);

  // ── Early-return: already up to date ──────────────────────────────
  if (existingMeta && !options.force && existingMeta.lastCommit === currentCommit) {
    // Non-git folders have currentCommit = '' — always rebuild since we can't detect changes
    if (currentCommit !== '') {
      // For git repos, even if HEAD matches lastCommit, the working tree
      // may have uncommitted changes. Only short-circuit when the working
      // tree is also clean.
      const dirty = hasDirtyTree(repoPath);
      if (!dirty) {
        await ensureGitNexusIgnored(repoPath);
        return {
          // `resolveRepoIdentityRoot` collapses worktree roots to the
          // canonical repo basename (#1259) but leaves arbitrary subdirs
          // and `--skip-git` paths unchanged (#1232/#1233 intent preserved).
          repoName:
            options.registryName ??
            getInferredRepoName(repoPath) ??
            path.basename(resolveRepoIdentityRoot(repoPath)),
          repoPath,
          stats: existingMeta.stats ?? {},
          alreadyUpToDate: true,
        };
      }
    }
  }

  // ── Incremental branch ─────────────────────────────────────────────
  // Try the incremental path first. Falls through to full rebuild on:
  //   - --force
  //   - missing/old meta.json
  //   - lastCommit gone (rebased)
  //   - schemaVersion mismatch
  //   - non-git repo
  //   - any error during incremental setup
  const eligibility = isIncrementalEligible(repoPath, existingMeta, options.force);
  if (eligibility.eligible && existingMeta) {
    try {
      const result = await runIncrementalBranch(
        repoPath,
        storagePath,
        lbugPath,
        existingMeta,
        currentCommit,
        options,
        callbacks,
      );
      if (result) return result;
      // result === null → falls through to full rebuild (e.g. setup failed)
    } catch (err) {
      log(
        `Incremental run failed (${(err as Error).message}); ` +
          `next run will full-rebuild via dirty-flag.`,
      );
      // Re-throw — the dirty flag is set; next run forces full rebuild.
      try {
        await closeLbug();
      } catch {
        /* swallow */
      }
      throw err;
    }
  } else if (existingMeta) {
    log(`Incremental skipped: ${eligibility.reason ?? 'unknown reason'}`);
  }

  // ── Cache embeddings from existing index before rebuild ────────────
  // Four modes:
  //   --embeddings              -> load cache, restore, then generate any new ones
  //   --force (with existing
  //    embeddings)              -> auto-imply --embeddings: load cache, restore,
  //                                regenerate embeddings for new/changed nodes
  //                                (a forced re-index of an embedded repo
  //                                shouldn't quietly downgrade to "preserve only")
  //   (default)                 -> if existing index has embeddings, preserve them
  //                                (load + restore, but do not generate); otherwise no-op
  //   --drop-embeddings         -> skip cache load entirely; rebuild wipes embeddings
  //
  // The default-preserve branch is what makes a routine `analyze` (e.g. a
  // post-commit hook) safe: a multi-minute embedding pass is no longer
  // silently dropped just because the caller omitted `--embeddings`.
  let cachedEmbeddingNodeIds = new Set<string>();
  let cachedEmbeddings: CachedEmbedding[] = [];

  const existingEmbeddingCount = existingMeta?.stats?.embeddings ?? 0;
  const {
    forceRegenerateEmbeddings,
    preserveExistingEmbeddings,
    shouldGenerateEmbeddings,
    shouldLoadCache,
  } = _deriveEmbeddingMode(options, existingEmbeddingCount);

  if (options.dropEmbeddings && existingEmbeddingCount > 0) {
    log(
      `Dropping ${existingEmbeddingCount} existing embeddings (--drop-embeddings). ` +
        `Re-run with --embeddings to regenerate.`,
    );
  } else if (forceRegenerateEmbeddings) {
    log(
      `--force on a repo with ${existingEmbeddingCount} existing embeddings: ` +
        `regenerating embeddings for new/changed nodes. ` +
        `Pass --drop-embeddings to wipe them instead.`,
    );
  } else if (preserveExistingEmbeddings) {
    log(
      `Preserving ${existingEmbeddingCount} existing embeddings. ` +
        `Pass --embeddings to also generate embeddings for new/changed nodes, ` +
        `or --drop-embeddings to wipe them.`,
    );
  }

  if (shouldLoadCache && existingMeta) {
    try {
      progress('embeddings', 0, 'Caching embeddings...');
      await initLbug(lbugPath);
      const cached = await loadCachedEmbeddings();
      cachedEmbeddingNodeIds = cached.embeddingNodeIds;
      cachedEmbeddings = cached.embeddings;
      await closeLbug();
    } catch (err: any) {
      // Surface cache-load failures explicitly: silently swallowing here would
      // re-introduce the original silent-data-loss symptom (embeddings end up
      // at 0 in meta.json with no diagnostic) through a different door.
      log(
        `Warning: could not load cached embeddings ` +
          `(${err?.message ?? String(err)}). ` +
          `Embeddings will not be preserved on this run.`,
      );
      cachedEmbeddingNodeIds = new Set<string>();
      cachedEmbeddings = [];
      try {
        await closeLbug();
      } catch {
        /* swallow */
      }
    }
  }

  // ── Phase 1: Full Pipeline (0–60%) ────────────────────────────────
  const pipelineResult = await runPipelineFromRepo(repoPath, (p) => {
    const phaseLabel = PHASE_LABELS[p.phase] || p.phase;
    const scaled = Math.round(p.percent * 0.6);
    const message = p.detail ? `${p.message || phaseLabel} (${p.detail})` : p.message || phaseLabel;
    progress(p.phase, scaled, message);
  });

  // ── Phase 2: LadybugDB (60–85%) ──────────────────────────────────
  progress('lbug', 60, 'Loading into LadybugDB...');

  await closeLbug();
  const lbugFiles = [lbugPath, `${lbugPath}.wal`, `${lbugPath}.lock`];
  for (const f of lbugFiles) {
    try {
      await fs.rm(f, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  }

  await initLbug(lbugPath);
  try {
    // All work after initLbug is wrapped in try/finally to ensure closeLbug()
    // is called even if an error occurs — the module-level singleton DB handle
    // must be released to avoid blocking subsequent invocations.

    let lbugMsgCount = 0;
    await loadGraphToLbug(pipelineResult.graph, pipelineResult.repoPath, storagePath, (msg) => {
      lbugMsgCount++;
      const pct = Math.min(84, 60 + Math.round((lbugMsgCount / (lbugMsgCount + 10)) * 24));
      progress('lbug', pct, msg);
    });

    // ── Phase 3: FTS (85–90%) ─────────────────────────────────────────
    progress('fts', 85, 'Creating search indexes...');
    await createSearchFTSIndexes();
    progress('fts', 90, 'Search indexes ready');

    // ── Phase 3.5: Re-insert cached embeddings ────────────────────────
    if (cachedEmbeddings.length > 0) {
      const cachedDims = cachedEmbeddings[0].embedding.length;
      const { EMBEDDING_DIMS } = await import('./lbug/schema.js');
      if (cachedDims !== EMBEDDING_DIMS) {
        // Dimensions changed (e.g. switched embedding model) — discard cache and re-embed all
        log(
          `Embedding dimensions changed (${cachedDims}d -> ${EMBEDDING_DIMS}d), discarding cache`,
        );
        cachedEmbeddings = [];
        cachedEmbeddingNodeIds = new Set();
      } else {
        progress('embeddings', 88, `Restoring ${cachedEmbeddings.length} cached embeddings...`);
        const { batchInsertEmbeddings: batchInsert } =
          await import('./embeddings/embedding-pipeline.js');
        const EMBED_BATCH = 200;
        for (let i = 0; i < cachedEmbeddings.length; i += EMBED_BATCH) {
          const batch = cachedEmbeddings.slice(i, i + EMBED_BATCH);

          try {
            await batchInsert(executeWithReusedStatement, batch);
          } catch {
            /* some may fail if node was removed, that's fine */
          }
        }
      }
    }

    // ── Phase 4: Embeddings (90–98%) ──────────────────────────────────
    const stats = await getLbugStats();
    let embeddingSkipped = true;
    let semanticMode: 'vector-index' | 'exact-scan' | undefined;

    if (shouldGenerateEmbeddings) {
      const { skipForCap, capDisabled, nodeLimit } = deriveEmbeddingCap(
        stats.nodes,
        options.embeddingsNodeLimit,
      );
      if (!skipForCap) {
        embeddingSkipped = false;
        if (capDisabled && stats.nodes > DEFAULT_EMBEDDING_NODE_LIMIT) {
          log(
            `Embedding node-count cap disabled — generating embeddings for ` +
              `${stats.nodes.toLocaleString()} nodes. Ensure sufficient memory; ` +
              `the default ${DEFAULT_EMBEDDING_NODE_LIMIT.toLocaleString()}-node ` +
              `cap exists to prevent OOM.`,
          );
        }
      } else {
        log(
          `Embeddings skipped: ${stats.nodes.toLocaleString()} nodes exceeds ` +
            `the ${nodeLimit.toLocaleString()}-node safety cap. ` +
            `Override with \`--embeddings 0\` to disable the cap, or ` +
            `\`--embeddings <n>\` to set a custom cap.`,
        );
      }
    }

    if (!embeddingSkipped) {
      const { isHttpMode } = await import('./embeddings/http-client.js');
      const httpMode = isHttpMode();
      progress(
        'embeddings',
        90,
        httpMode ? 'Connecting to embedding endpoint...' : 'Loading embedding model...',
      );
      const { runEmbeddingPipeline } = await import('./embeddings/embedding-pipeline.js');
      // Build a Map<nodeId, contentHash> from cached embeddings for incremental mode
      let existingEmbeddings: Map<string, string> | undefined;
      if (cachedEmbeddingNodeIds.size > 0) {
        existingEmbeddings = new Map<string, string>();
        for (const e of cachedEmbeddings) {
          existingEmbeddings.set(e.nodeId, e.contentHash ?? STALE_HASH_SENTINEL);
        }
      }

      const { readServerMapping } = await import('./embeddings/server-mapping.js');
      // Mirror the registry's name-resolution chain so the server-mapping
      // lookup key stays aligned with the final registry name (#1259):
      //   --name → remote-derived → canonical-root basename
      // (preserved-alias is intentionally NOT consulted here — server
      // mappings are addressed by the operationally-meaningful name the
      // user configures, not by a sticky registry-only alias they may not
      // know about. The previous canonical-only logic ignored both --name
      // and remote-derived names, silently breaking server-mapping for
      // anyone with a `--name` alias or remote-named repo.)
      const projectName =
        options.registryName ??
        getInferredRepoName(repoPath) ??
        path.basename(resolveRepoIdentityRoot(repoPath));
      const serverName = await readServerMapping(projectName);
      const embeddingResult = await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        (p) => {
          const scaled = 90 + Math.round((p.percent / 100) * 8);
          const label =
            p.phase === 'loading-model'
              ? httpMode
                ? 'Connecting to embedding endpoint...'
                : 'Loading embedding model...'
              : `Embedding ${p.nodesProcessed || 0}/${p.totalNodes || '?'}`;
          progress('embeddings', scaled, label);
        },
        {},
        cachedEmbeddingNodeIds.size > 0 ? cachedEmbeddingNodeIds : undefined,
        { repoName: projectName, serverName },
        existingEmbeddings,
      );
      if (embeddingResult.semanticMode === 'exact-scan') {
        semanticMode = 'exact-scan';
        log(
          'Semantic embeddings were generated without a VECTOR index; ' +
            'queries will use exact-scan fallback within the configured limit.',
        );
      } else {
        semanticMode = 'vector-index';
      }
    }

    // ── Phase 5: Finalize (98–100%) ───────────────────────────────────
    progress('done', 98, 'Saving metadata...');

    // Count embeddings in the index (cached + newly generated)
    let embeddingCount = 0;
    try {
      const embResult = await executeQuery(
        `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN count(e) AS cnt`,
      );
      const row = embResult?.[0];
      embeddingCount = Number(row?.cnt ?? row?.[0] ?? 0);
    } catch {
      /* table may not exist if embeddings never ran */
    }

    if (!embeddingSkipped && stats.nodes > 0 && embeddingCount === 0) {
      throw new Error(
        'Embedding generation completed without persisted embeddings. ' +
          'The index was not registered to avoid silently reporting embeddings: 0.',
      );
    }

    const { getRuntimeCapabilities } = await import('./platform/capabilities.js');
    const runtimeCapabilities = getRuntimeCapabilities();
    const effectiveSemanticMode =
      semanticMode ??
      (runtimeCapabilities.semanticMode === 'vector-index' ? 'vector-index' : 'exact-scan');

    // Compute per-file surface signatures so the next run can be incremental.
    // v1 uses content-hash (cheap, conservative). v2 will switch to a
    // surface-only signature so body-only edits don't expand the closure.
    let surfaceSignatures: Record<string, string> | undefined;
    if (hasGitDir(repoPath)) {
      try {
        const allFilePaths: string[] = [];
        pipelineResult.graph.forEachNode((n) => {
          const fp = n.properties?.filePath as string | undefined;
          if (fp && (n.label === 'File' || n.label === 'Folder')) {
            // File nodes carry their own path; we want every distinct repo-relative
            // file path that participated in indexing. Use File nodes as the
            // authoritative source.
            if (n.label === 'File') allFilePaths.push(fp);
          }
        });
        if (allFilePaths.length > 0) {
          surfaceSignatures = await computeAllFileSignatures(repoPath, allFilePaths);
        }
      } catch {
        /* surface signatures are best-effort; their absence just means the
         * next run will fall back to full rebuild. */
      }
    }

    const meta = {
      repoPath,
      lastCommit: currentCommit,
      indexedAt: new Date().toISOString(),
      // Captured here (not at registration) so it travels with the
      // on-disk meta.json — sibling-clone fingerprinting works for
      // out-of-tree consumers (group-status, future tooling) without
      // a second git shellout. `undefined` when the repo has no
      // origin remote, which is fine: paths-only repos behave as
      // before.
      remoteUrl: hasGitDir(repoPath) ? getRemoteUrl(repoPath) : undefined,
      // Incremental-indexing fields — populated for git repos only. The
      // next analyze run reads these to decide whether to take the
      // incremental path. See the Incremental branch above.
      schemaVersion: surfaceSignatures ? INCREMENTAL_SCHEMA_VERSION : undefined,
      surfaceSignatures,
      incrementalInProgress: undefined as
        | { closure: string[]; startedAt: number }
        | undefined,
      stats: {
        files: pipelineResult.totalFileCount,
        nodes: stats.nodes,
        edges: stats.edges,
        communities: pipelineResult.communityResult?.stats.totalCommunities,
        processes: pipelineResult.processResult?.stats.totalProcesses,
        embeddings: embeddingCount,
      },
      capabilities: {
        graph: { provider: 'ladybugdb', status: runtimeCapabilities.graph },
        fts: { provider: 'ladybugdb-fts', status: runtimeCapabilities.fts },
        vectorSearch: {
          provider: effectiveSemanticMode === 'vector-index' ? 'ladybugdb-vector' : 'exact-scan',
          status: embeddingCount > 0 ? effectiveSemanticMode : 'unavailable',
          exactScanLimit: runtimeCapabilities.exactScanLimit,
          reason: runtimeCapabilities.reason,
        },
      },
    };
    await saveMeta(storagePath, meta);
    // Forward the --name alias and the registry-collision bypass bit.
    // `allowDuplicateName` is its own concern — independent from the
    // pipeline `force` above. The CLI maps it from
    // `--allow-duplicate-name` only; `--force` and `--skills` both
    // trigger pipeline re-run but never bypass the registry guard.
    // The returned name is the one actually written to the registry
    // (after applying the precedence chain in registerRepo) — reuse it
    // so AGENTS.md / skill files reference the same name MCP clients
    // will look up (#979).
    const projectName = await registerRepo(repoPath, meta, {
      name: options.registryName,
      allowDuplicateName: options.allowDuplicateName,
    });

    // Keep generated .gitnexus contents ignored without editing the user's root .gitignore.
    await ensureGitNexusIgnored(repoPath);

    // ── Generate AI context files (best-effort) ───────────────────────
    let aggregatedClusterCount = 0;
    if (pipelineResult.communityResult?.communities) {
      const groups = new Map<string, number>();
      for (const c of pipelineResult.communityResult.communities) {
        const label = c.heuristicLabel || c.label || 'Unknown';
        groups.set(label, (groups.get(label) || 0) + c.symbolCount);
      }
      aggregatedClusterCount = Array.from(groups.values()).filter((count) => count >= 5).length;
    }

    try {
      await generateAIContextFiles(
        repoPath,
        storagePath,
        projectName,
        {
          files: pipelineResult.totalFileCount,
          nodes: stats.nodes,
          edges: stats.edges,
          communities: pipelineResult.communityResult?.stats.totalCommunities,
          clusters: aggregatedClusterCount,
          processes: pipelineResult.processResult?.stats.totalProcesses,
        },
        undefined,
        { skipAgentsMd: options.skipAgentsMd, noStats: options.noStats },
      );
    } catch {
      // Best-effort — don't fail the entire analysis for context file issues
    }

    // ── Close LadybugDB ──────────────────────────────────────────────
    await closeLbug();

    progress('done', 100, 'Done');

    return {
      repoName: projectName,
      repoPath,
      stats: meta.stats,
      pipelineResult,
    };
  } catch (err) {
    // Ensure LadybugDB is closed even on error
    try {
      await closeLbug();
    } catch {
      /* swallow */
    }
    throw err;
  }
}

// ===========================================================================
// Incremental analysis branch — invoked from runFullAnalysis when eligible.
// See docs/superpowers/specs/2026-05-10-incremental-indexing-design.md.
// ===========================================================================

/**
 * Cheap check: does the working tree have uncommitted changes? Used to
 * decide whether the "lastCommit == HEAD" early-exit is safe to take.
 */
function hasDirtyTree(repoPath: string): boolean {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return out.trim().length > 0;
  } catch {
    // If git status fails for any reason, conservatively assume dirty so
    // we don't accidentally short-circuit a real change.
    return true;
  }
}

/**
 * Execute the incremental branch of `runFullAnalysis`. Returns null when
 * setup determines a full rebuild is needed instead (caller falls through).
 *
 * Throws if the run fails after the dirty flag is set — caller is
 * responsible for surfacing the error; the next run will detect the dirty
 * flag and force a full rebuild.
 */
async function runIncrementalBranch(
  repoPath: string,
  storagePath: string,
  lbugPath: string,
  existingMeta: import('../storage/repo-manager.js').RepoMeta,
  currentCommit: string,
  options: AnalyzeOptions,
  callbacks: AnalyzeCallbacks,
): Promise<AnalyzeResult | null> {
  const log = (msg: string) => callbacks.onLog?.(msg);
  const progress = (phase: string, percent: number, message: string) =>
    callbacks.onProgress(phase, percent, message);

  log(
    `Incremental: probing for changes since ${existingMeta.lastCommit.slice(0, 7)}...`,
  );

  // 1. Compute closure (parses each file's content hash, walks DB importers).
  let setup: Awaited<ReturnType<typeof computeIncrementalClosure>>;
  try {
    // Open the existing DB so closure expansion can query the IMPORTS edges.
    await initLbug(lbugPath);
    setup = await computeIncrementalClosure(
      repoPath,
      existingMeta.lastCommit,
      existingMeta.surfaceSignatures ?? {},
    );
  } catch (e) {
    try {
      await closeLbug();
    } catch {
      /* swallow */
    }
    log(
      `Incremental setup failed: ${(e as Error).message}. Falling back to full rebuild.`,
    );
    return null;
  }

  // 2. No changes? Update lastCommit and return early.
  if (setup.closure.size === 0 && setup.deletedFiles.length === 0) {
    log('Incremental: no file changes detected — refreshing meta only.');
    try {
      await closeLbug();
    } catch {
      /* swallow */
    }
    const meta: import('../storage/repo-manager.js').RepoMeta = {
      ...existingMeta,
      lastCommit: currentCommit,
      indexedAt: new Date().toISOString(),
    };
    await saveMeta(storagePath, meta);
    await ensureGitNexusIgnored(repoPath);
    return {
      repoName:
        options.registryName ??
        getInferredRepoName(repoPath) ??
        path.basename(resolveRepoIdentityRoot(repoPath)),
      repoPath,
      stats: existingMeta.stats ?? {},
      alreadyUpToDate: true,
    };
  }

  log(
    `Incremental: closure=${setup.closure.size} (changed=${setup.changes.modified.length} ` +
      `+ added=${setup.changes.added.length} + importers=${setup.closure.size - setup.changes.modified.length - setup.changes.added.length}), ` +
      `deleted=${setup.deletedFiles.length}`,
  );

  // 3. Mark dirty BEFORE any DB mutation. Closes lbug temporarily to
  //    release the connection while saveMeta writes.
  await commitIncrementalProgress(storagePath, existingMeta, setup.closure);

  // 4. Delete stale rows from the DB.
  progress('lbug', 5, 'Removing stale rows for changed files...');
  for (const file of setup.closure) {
    try {
      await deleteNodesForFile(file);
    } catch {
      /* file may not have been indexed yet — fine */
    }
  }
  for (const file of setup.deletedFiles) {
    try {
      await deleteNodesForFile(file);
    } catch {
      /* fine */
    }
  }
  // Always wipe Community / Process — they're regenerated by downstream
  // pipeline phases and must come from the merged graph for correctness
  // (Leiden runs on the FULL hydrated + parsed graph).
  await deleteAllCommunitiesAndProcesses();

  // 5. Run the pipeline with filesToParse set so:
  //    - hydrate phase fills ctx.graph with unchanged-file nodes from DB
  //    - parse phase only parses closure files
  //    - downstream phases (mro, communities, processes) see the full graph
  const pipelineResult = await runPipelineFromRepo(
    repoPath,
    (p) => {
      const phaseLabel = PHASE_LABELS[p.phase] || p.phase;
      const scaled = 10 + Math.round(p.percent * 0.55); // 10–65%
      const message = p.detail ? `${p.message || phaseLabel} (${p.detail})` : p.message || phaseLabel;
      progress(p.phase, scaled, message);
    },
    { filesToParse: setup.closure },
  );

  // 6. Extract the subgraph that needs to be written: closure-file nodes
  //    + graph-wide nodes + edges incident to them. Hydrated unchanged-file
  //    nodes are NOT in this subgraph — their rows are still in DB.
  progress('lbug', 70, 'Writing incremental updates to LadybugDB...');
  const subgraph = extractIncrementalSubgraph(pipelineResult.graph, setup.closure);
  await loadGraphToLbug(subgraph, repoPath, storagePath, (msg) => {
    progress('lbug', 80, msg);
  });

  // 7. Recreate FTS indexes (cheap; full rebuild over the merged DB state).
  progress('fts', 90, 'Refreshing search indexes...');
  try {
    await createSearchFTSIndexes();
  } catch {
    /* FTS is best-effort; log only */
  }

  // 8. Compute final stats from the live DB state.
  const stats = await getLbugStats();

  // 9. Compute new meta (merge surface signatures, clear dirty flag).
  const mergedSurfaces = mergeSurfaceSignatures(
    existingMeta.surfaceSignatures ?? {},
    setup.newFileHashes,
    setup.deletedFiles,
  );

  const newMeta: import('../storage/repo-manager.js').RepoMeta = {
    ...existingMeta,
    lastCommit: currentCommit,
    indexedAt: new Date().toISOString(),
    remoteUrl: getRemoteUrl(repoPath) ?? existingMeta.remoteUrl,
    schemaVersion: INCREMENTAL_SCHEMA_VERSION,
    surfaceSignatures: mergedSurfaces,
    incrementalInProgress: undefined, // explicit clear
    stats: {
      ...(existingMeta.stats ?? {}),
      files: pipelineResult.totalFileCount,
      nodes: stats.nodes,
      edges: stats.edges,
      communities: pipelineResult.communityResult?.stats.totalCommunities,
      processes: pipelineResult.processResult?.stats.totalProcesses,
    },
  };

  // 10. Persist meta + register repo.
  await saveMeta(storagePath, newMeta);
  const projectName = await registerRepo(repoPath, newMeta, {
    name: options.registryName,
    allowDuplicateName: options.allowDuplicateName,
  });

  // 11. Best-effort AI-context regeneration so AGENTS.md/CLAUDE.md stay
  //     in sync with the post-incremental graph state.
  let aggregatedClusterCount = 0;
  if (pipelineResult.communityResult?.communities) {
    const groups = new Map<string, number>();
    for (const c of pipelineResult.communityResult.communities) {
      const label = c.heuristicLabel || c.label || 'Unknown';
      groups.set(label, (groups.get(label) || 0) + c.symbolCount);
    }
    aggregatedClusterCount = Array.from(groups.values()).filter((cnt) => cnt >= 5).length;
  }
  try {
    await generateAIContextFiles(
      repoPath,
      storagePath,
      projectName,
      {
        files: pipelineResult.totalFileCount,
        nodes: stats.nodes,
        edges: stats.edges,
        communities: pipelineResult.communityResult?.stats.totalCommunities,
        clusters: aggregatedClusterCount,
        processes: pipelineResult.processResult?.stats.totalProcesses,
      },
      undefined,
      { skipAgentsMd: options.skipAgentsMd, noStats: options.noStats },
    );
  } catch {
    /* best-effort */
  }

  await ensureGitNexusIgnored(repoPath);
  await closeLbug();

  progress('done', 100, 'Incremental complete');

  return {
    repoName: projectName,
    repoPath,
    stats: newMeta.stats ?? {},
    pipelineResult,
  };
}
