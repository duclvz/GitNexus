/**
 * Phase: hydrate
 *
 * In incremental-indexing mode, populates `ctx.graph` with all nodes and
 * relationships belonging to files OUTSIDE the current closure (i.e., files
 * that didn't change). This way the parse phase only needs to re-emit nodes
 * and edges for the closure files, while downstream phases (mro, communities,
 * processes) see a fully-populated graph and produce results equivalent to a
 * full rebuild.
 *
 * No-op in full-rebuild mode: when `ctx.options.filesToParse` is unset,
 * the pipeline starts with an empty graph and parses every file (existing
 * behavior).
 *
 * @deps    structure
 * @reads   allPaths (from structure)
 * @writes  graph (every node/edge belonging to unchanged files)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { StructureOutput } from './structure.js';
import { loadGraphFromLbug } from '../../lbug/lbug-adapter.js';
import { isDev } from '../utils/env.js';
import { logger } from '../../logger.js';

export interface HydrateOutput {
  /** True when this run actually loaded prior state (incremental). */
  readonly hydrated: boolean;
  /** Number of nodes loaded from DB (0 in full-rebuild mode). */
  readonly nodesLoaded: number;
  /** Number of relationships loaded from DB (0 in full-rebuild mode). */
  readonly edgesLoaded: number;
}

export const hydratePhase: PipelinePhase<HydrateOutput> = {
  name: 'hydrate',
  deps: ['structure'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<HydrateOutput> {
    const filesToParse = ctx.options?.filesToParse;

    // Full-rebuild mode: nothing to hydrate.
    if (!filesToParse) {
      return { hydrated: false, nodesLoaded: 0, edgesLoaded: 0 };
    }

    const { allPaths, totalFiles } = getPhaseOutput<StructureOutput>(deps, 'structure');

    // Compute the unchanged complement: every scanned path NOT in the closure.
    const unchanged = new Set<string>();
    for (const p of allPaths) {
      if (!filesToParse.has(p)) unchanged.add(p);
    }

    ctx.onProgress({
      phase: 'hydrate',
      percent: 22,
      message: `Hydrating ${unchanged.size} unchanged files from index...`,
      stats: { filesProcessed: 0, totalFiles, nodesCreated: ctx.graph.nodeCount },
    });

    const result = await loadGraphFromLbug(ctx.graph, unchanged);

    if (isDev) {
      logger.info(
        `💧 Hydrate: ${result.nodesLoaded} nodes, ${result.edgesLoaded} edges loaded for ${unchanged.size} unchanged files (closure: ${filesToParse.size})`,
      );
    }

    ctx.onProgress({
      phase: 'hydrate',
      percent: 25,
      message: `Hydrated ${result.nodesLoaded} nodes from previous index`,
      stats: {
        filesProcessed: unchanged.size,
        totalFiles,
        nodesCreated: ctx.graph.nodeCount,
      },
    });

    return {
      hydrated: true,
      nodesLoaded: result.nodesLoaded,
      edgesLoaded: result.edgesLoaded,
    };
  },
};
