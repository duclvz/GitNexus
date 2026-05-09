import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import {
  extractSurfaceSignature,
  surfaceChanged,
} from '../../src/core/incremental/surface.js';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';

function fn(
  id: string,
  filePath: string,
  name: string,
  extra: Record<string, unknown> = {},
): GraphNode {
  return {
    id,
    label: 'Function',
    properties: { name, filePath, ...extra },
  };
}

function method(
  id: string,
  filePath: string,
  name: string,
  extra: Record<string, unknown> = {},
): GraphNode {
  return {
    id,
    label: 'Method',
    properties: { name, filePath, ...extra },
  };
}

function cls(
  id: string,
  filePath: string,
  name: string,
  extra: Record<string, unknown> = {},
): GraphNode {
  return {
    id,
    label: 'Class',
    properties: { name, filePath, ...extra },
  };
}

function rel(
  id: string,
  type: GraphRelationship['type'],
  src: string,
  dst: string,
): GraphRelationship {
  return { id, type, sourceId: src, targetId: dst, confidence: 1, reason: 't' };
}

describe('extractSurfaceSignature', () => {
  it('returns a stable hash for an empty file', () => {
    const g = createKnowledgeGraph();
    const h1 = extractSurfaceSignature(g, 'a.ts');
    const h2 = extractSurfaceSignature(g, 'a.ts');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces the same hash for the same surface', () => {
    const g1 = createKnowledgeGraph();
    g1.addNode(fn('Function:a.ts:foo#0', 'a.ts', 'foo', { parameterCount: 0 }));
    const g2 = createKnowledgeGraph();
    g2.addNode(fn('Function:a.ts:foo#0', 'a.ts', 'foo', { parameterCount: 0 }));
    expect(extractSurfaceSignature(g1, 'a.ts')).toBe(
      extractSurfaceSignature(g2, 'a.ts'),
    );
  });

  it('is invariant under node insertion order', () => {
    const g1 = createKnowledgeGraph();
    g1.addNode(fn('Function:a.ts:foo#0', 'a.ts', 'foo', { parameterCount: 0 }));
    g1.addNode(fn('Function:a.ts:bar#1', 'a.ts', 'bar', { parameterCount: 1 }));
    const g2 = createKnowledgeGraph();
    g2.addNode(fn('Function:a.ts:bar#1', 'a.ts', 'bar', { parameterCount: 1 }));
    g2.addNode(fn('Function:a.ts:foo#0', 'a.ts', 'foo', { parameterCount: 0 }));
    expect(extractSurfaceSignature(g1, 'a.ts')).toBe(
      extractSurfaceSignature(g2, 'a.ts'),
    );
  });

  it('changes when a function is renamed', () => {
    const g1 = createKnowledgeGraph();
    g1.addNode(fn('Function:a.ts:foo#0', 'a.ts', 'foo'));
    const g2 = createKnowledgeGraph();
    g2.addNode(fn('Function:a.ts:bar#0', 'a.ts', 'bar'));
    expect(extractSurfaceSignature(g1, 'a.ts')).not.toBe(
      extractSurfaceSignature(g2, 'a.ts'),
    );
  });

  it('changes when a function signature changes', () => {
    const g1 = createKnowledgeGraph();
    g1.addNode(
      fn('Function:a.ts:foo#1', 'a.ts', 'foo', {
        parameterCount: 1,
        parameterTypes: ['number'],
        returnType: 'string',
      }),
    );
    const g2 = createKnowledgeGraph();
    g2.addNode(
      fn('Function:a.ts:foo#1', 'a.ts', 'foo', {
        parameterCount: 1,
        parameterTypes: ['string'],
        returnType: 'string',
      }),
    );
    expect(extractSurfaceSignature(g1, 'a.ts')).not.toBe(
      extractSurfaceSignature(g2, 'a.ts'),
    );
  });

  it('does NOT change for body-only edits (no surface mutation)', () => {
    // Body-only edits don't add/remove/rename surface nodes — same hash.
    const g = createKnowledgeGraph();
    g.addNode(fn('Function:a.ts:foo#0', 'a.ts', 'foo', { parameterCount: 0 }));
    const h1 = extractSurfaceSignature(g, 'a.ts');
    // Re-build with same surface (simulating a re-parse of a body-only edit).
    const g2 = createKnowledgeGraph();
    g2.addNode(fn('Function:a.ts:foo#0', 'a.ts', 'foo', { parameterCount: 0 }));
    const h2 = extractSurfaceSignature(g2, 'a.ts');
    expect(h1).toBe(h2);
  });

  it('only considers nodes whose filePath matches', () => {
    const g = createKnowledgeGraph();
    g.addNode(fn('Function:a.ts:foo#0', 'a.ts', 'foo'));
    g.addNode(fn('Function:b.ts:bar#0', 'b.ts', 'bar'));
    const ha = extractSurfaceSignature(g, 'a.ts');
    const hb = extractSurfaceSignature(g, 'b.ts');
    expect(ha).not.toBe(hb);
    // Adding a node in a OTHER file should not change a's signature.
    g.addNode(fn('Function:c.ts:baz#0', 'c.ts', 'baz'));
    expect(extractSurfaceSignature(g, 'a.ts')).toBe(ha);
  });

  it('changes when EXTENDS target changes', () => {
    const g1 = createKnowledgeGraph();
    g1.addNode(cls('Class:a.ts:Child#0', 'a.ts', 'Child'));
    g1.addNode(cls('Class:b.ts:ParentA#0', 'b.ts', 'ParentA'));
    g1.addRelationship(
      rel('r1', 'EXTENDS', 'Class:a.ts:Child#0', 'Class:b.ts:ParentA#0'),
    );

    const g2 = createKnowledgeGraph();
    g2.addNode(cls('Class:a.ts:Child#0', 'a.ts', 'Child'));
    g2.addNode(cls('Class:b.ts:ParentB#0', 'b.ts', 'ParentB'));
    g2.addRelationship(
      rel('r1', 'EXTENDS', 'Class:a.ts:Child#0', 'Class:b.ts:ParentB#0'),
    );

    expect(extractSurfaceSignature(g1, 'a.ts')).not.toBe(
      extractSurfaceSignature(g2, 'a.ts'),
    );
  });

  it('includes Method/Class/Interface in the surface', () => {
    const g = createKnowledgeGraph();
    g.addNode(cls('Class:a.ts:C#0', 'a.ts', 'C'));
    g.addNode(method('Method:a.ts:C.m#0', 'a.ts', 'm'));
    const h = extractSurfaceSignature(g, 'a.ts');
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('surfaceChanged', () => {
  it('returns true when prev is undefined (first index of file)', () => {
    expect(surfaceChanged(undefined, 'abc')).toBe(true);
  });

  it('returns false when prev equals current', () => {
    expect(surfaceChanged('abc', 'abc')).toBe(false);
  });

  it('returns true when prev differs from current', () => {
    expect(surfaceChanged('abc', 'def')).toBe(true);
  });
});
