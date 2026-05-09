/**
 * File-content hashing — v1 "surface signature" for incremental indexing.
 *
 * v1 trade-off: we use SHA-256 of file content as the surface signature.
 * This is conservative — a body-only edit (which doesn't actually change
 * any other file's resolution) still triggers 1-hop closure expansion
 * because the content hash differs.
 *
 * v2 will switch to a real surface-only signature (extracted from the
 * post-parse graph via `extractSurfaceSignature` in `surface.ts`) so that
 * body-only edits stay at closure size 1. The plumbing for that is in
 * place — `surface.ts` and the closure module are signature-agnostic —
 * but reusing the parse-worker output for one-off surface extraction
 * requires more pipeline integration than is needed for v1.
 */

import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

/**
 * Compute SHA-256 hex digest of a single file. Returns null when the
 * file can't be read (deleted between scan and hash, permission error,
 * etc.) — caller should treat null as "no signature available, assume
 * changed".
 */
export async function computeFileHash(absPath: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(absPath);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Compute SHA-256 hashes for a list of files in `repoPath` (paths are
 * repo-relative). Parallel batched I/O bounded at 100 concurrent reads
 * to avoid fd exhaustion on huge repos.
 *
 * Returns a Map<relPath, hash>. Files that fail to read are omitted
 * from the result (caller treats them as "no signature").
 */
export async function computeFileHashes(
  repoPath: string,
  relPaths: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const BATCH = 100;
  for (let i = 0; i < relPaths.length; i += BATCH) {
    const batch = relPaths.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (rel) => {
        const hash = await computeFileHash(path.join(repoPath, rel));
        return hash ? ([rel, hash] as const) : null;
      }),
    );
    for (const r of results) if (r) out.set(r[0], r[1]);
  }
  return out;
}
