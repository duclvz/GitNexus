/**
 * Subgraph extraction for incremental DB writeback.
 *
 * Given the FULL ctx.graph produced by the pipeline (all files parsed,
 * all phases run) and the set of file paths whose DB rows must be
 * replaced, produce a smaller KnowledgeGraph that contains:
 *
 *   - Every node whose `properties.filePath` is in `toWriteSet`.
 *   - Every graph-wide node (Community, Process) — these are regenerated
 *     each run by the communities/processes phases and must be fully
 *     rewritten.
 *   - Every relationship where AT LEAST ONE endpoint is in the writable
 *     set above. Relationships entirely between unchanged-file nodes
 *     are skipped — their rows are still in the DB and re-inserting
 *     them would PK-conflict at COPY time.
 *
 * The resulting subgraph is what gets passed to `loadGraphToLbug` after
 * the orchestrator has deleted the corresponding DB rows. Hydrated
 * unchanged-file rows are never touched in the DB.
 */

import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../graph/graph.js';
import type { KnowledgeGraph } from '../graph/types.js';

const isGraphWide = (label: string): boolean => label === 'Community' || label === 'Process';

export const extractChangedSubgraph = (
  fullGraph: KnowledgeGraph,
  toWriteSet: ReadonlySet<string>,
): KnowledgeGraph => {
  const sub = createKnowledgeGraph();
  const writableNodeIds = new Set<string>();

  fullGraph.forEachNode((n: GraphNode) => {
    const filePath = n.properties?.filePath as string | undefined;
    const include = (filePath && toWriteSet.has(filePath)) || isGraphWide(n.label);
    if (include) {
      sub.addNode(n);
      writableNodeIds.add(n.id);
    }
  });

  fullGraph.forEachRelationship((r: GraphRelationship) => {
    if (writableNodeIds.has(r.sourceId) || writableNodeIds.has(r.targetId)) {
      sub.addRelationship(r);
    }
  });

  return sub;
};
