/**
 * Public-surface signature extraction for incremental indexing.
 *
 * The surface signature of a file is a stable hash of everything that could
 * affect callers in *other* files: the names, signatures, and heritage of
 * its publicly-visible symbols (functions, classes, methods, interfaces).
 *
 * If a file's surface hash is unchanged between runs, no other file's
 * resolution depends on the changed content — we only need to re-parse the
 * file itself, not its importers. This is the closure-scoping optimization
 * driven by `closure.ts`.
 *
 * The hash is content-only and excludes formatting, comments, and ordering
 * (we sort the symbol list before hashing). It does NOT include implementation
 * bodies — that's the whole point: a body-only edit produces the same surface.
 */

import { createHash } from 'crypto';
import type { GraphNode } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../graph/types.js';

/** Node labels whose presence in a file contributes to its public surface. */
const SURFACE_LABELS = new Set<string>([
  'Function',
  'Class',
  'Method',
  'Constructor',
  'Interface',
  'TypeAlias',
  'Enum',
  'Struct',
  'Trait',
  'Namespace',
  'Module',
  'Const',
  'Static',
  'Property',
  'Record',
  'Delegate',
  'Annotation',
  'Template',
  'Union',
  'Macro',
  'Typedef',
]);

/**
 * Extract the surface signature of `filePath` from `graph`.
 * Returns a stable hex hash; identical-surface inputs → identical output.
 */
export function extractSurfaceSignature(
  graph: KnowledgeGraph,
  filePath: string,
): string {
  const lines: string[] = [];

  // Gather surface-relevant nodes for this file.
  const surfaceNodes: GraphNode[] = [];
  graph.forEachNode((node) => {
    if (
      node.properties?.filePath === filePath &&
      SURFACE_LABELS.has(node.label)
    ) {
      surfaceNodes.push(node);
    }
  });

  // Sort deterministically by id so reorder doesn't affect the hash.
  surfaceNodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const n of surfaceNodes) {
    lines.push(serializeNode(n));
  }

  // Heritage: edges that fan OUT of this file affect downstream resolution.
  // (EXTENDS / IMPLEMENTS targets — if the parent class changes, dependents
  // may resolve methods differently.) These edges are co-located with the
  // child symbol whose `filePath` matches; we walk them off the source side.
  const edgeKeys: string[] = [];
  graph.forEachRelationship((rel) => {
    if (rel.type !== 'EXTENDS' && rel.type !== 'IMPLEMENTS') return;
    const src = graph.getNode(rel.sourceId);
    if (!src) return;
    if (src.properties?.filePath !== filePath) return;
    edgeKeys.push(`H ${rel.type} ${rel.sourceId} -> ${rel.targetId}`);
  });
  edgeKeys.sort();
  for (const k of edgeKeys) lines.push(k);

  const h = createHash('sha256');
  for (const line of lines) {
    h.update(line);
    h.update('\n');
  }
  return h.digest('hex');
}

/** True iff `current` differs from `prev` (or `prev` is undefined). */
export function surfaceChanged(
  prev: string | undefined,
  current: string,
): boolean {
  return prev === undefined || prev !== current;
}

/**
 * Serialize a single surface node to a stable string. We include label,
 * name, parameter count + types, return type, and visibility-style flags
 * — anything that could affect how a caller resolves against this node.
 *
 * We DO NOT include line numbers, file offsets, or any other position
 * data: surface should be invariant under whitespace/formatting changes.
 */
function serializeNode(node: GraphNode): string {
  const p = (node.properties ?? {}) as Record<string, unknown>;
  const parts: string[] = [
    `N`,
    node.label,
    String(p.name ?? ''),
    `id=${node.id}`,
  ];
  if (p.parameterCount !== undefined) parts.push(`pc=${String(p.parameterCount)}`);
  if (Array.isArray(p.parameterTypes)) {
    parts.push(`pt=${(p.parameterTypes as string[]).join(',')}`);
  }
  if (p.returnType !== undefined) parts.push(`rt=${String(p.returnType)}`);
  if (p.visibility !== undefined) parts.push(`v=${String(p.visibility)}`);
  if (p.isStatic) parts.push('static');
  if (p.isAbstract) parts.push('abstract');
  if (p.isReadonly) parts.push('readonly');
  if (p.isAsync) parts.push('async');
  // `level` (inheritance depth marker for methods) affects MRO
  if (p.level !== undefined) parts.push(`lvl=${String(p.level)}`);
  return parts.join('|');
}
