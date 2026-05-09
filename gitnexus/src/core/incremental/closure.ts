/**
 * Iterative importer-closure computation for incremental indexing.
 *
 * Given a set of changed files, walks the IMPORTS graph (queried from the
 * existing DB) to determine which other files must also be re-parsed for the
 * incremental run to be byte-equivalent to a full rebuild.
 *
 * Algorithm:
 *   1. Start with `closure = changedFiles`.
 *   2. For each file `f` newly added to closure: parse it, extract surface.
 *   3. If surface differs from `prevSurfaces[f]`, add all importers of `f`
 *      to closure.
 *   4. Repeat until no new files added.
 *
 * Termination: each iteration either adds files or stops. The universe of
 * files is finite (bounded by the repo size), so the loop terminates.
 *
 * Correctness invariant: a file is added to the closure iff its CALLS or
 * IMPORTS edges might resolve differently than they did at `lastCommit`. The
 * surface check is the crisp condition: surface unchanged → no resolver
 * change → file's edges don't need re-emission.
 */

export interface ClosureInput<TParseResult> {
  /** Initial set of files (from git diff: modified ∪ added). */
  initialChangedFiles: Set<string>;
  /** Previously stored surface signatures (filePath → hash). */
  prevSurfaces: Record<string, string>;
  /**
   * Parse one file and return the parser result. The closure logic only
   * cares about producing a stable surface signature, so callers may use
   * the same parse worker the main pipeline uses.
   */
  parseFile: (filePath: string) => Promise<TParseResult>;
  /**
   * Compute the surface signature for `filePath` given the parse result.
   * Returned signature is hashed and compared against `prevSurfaces`.
   */
  surfaceFor: (filePath: string, parsed: TParseResult) => string;
  /**
   * Query the existing DB for files that import `filePath`. Returns
   * repo-relative paths. A missing file (e.g. importer of a brand-new file)
   * legitimately returns `[]`.
   */
  queryImporters: (filePath: string) => Promise<string[]>;
}

export interface ClosureResult<TParseResult> {
  /** Final set of files that must be re-parsed. */
  closure: Set<string>;
  /**
   * Cache of parsed results, keyed by file path. The orchestrator hands
   * this to the pipeline so the parse phase doesn't re-parse closure files.
   */
  parseCache: Map<string, TParseResult>;
  /** Newly computed surface signatures, keyed by file path. */
  newSurfaces: Map<string, string>;
  /**
   * Files added to closure ONLY because an importer chain pulled them in
   * (not in the initial changed set). Useful for logging.
   */
  expandedFromImporters: Set<string>;
}

/**
 * Compute the transitive importer closure of the initial changed files,
 * pruned by the surface-change optimization.
 *
 * The function is generic over `TParseResult` — the orchestrator is free
 * to use the existing parse-worker result type, but the closure module
 * itself is decoupled from any specific parse representation.
 */
export async function computeImporterClosure<TParseResult>(
  input: ClosureInput<TParseResult>,
): Promise<ClosureResult<TParseResult>> {
  const { initialChangedFiles, prevSurfaces, parseFile, surfaceFor, queryImporters } = input;

  const closure = new Set<string>(initialChangedFiles);
  const queue: string[] = [...initialChangedFiles];
  const parseCache = new Map<string, TParseResult>();
  const newSurfaces = new Map<string, string>();
  const expandedFromImporters = new Set<string>();

  while (queue.length > 0) {
    const f = queue.shift()!;

    // Parse this file (if we haven't already in this run).
    let parsed = parseCache.get(f);
    if (parsed === undefined) {
      parsed = await parseFile(f);
      parseCache.set(f, parsed);
    }

    // Compute the new surface signature.
    const newSurface = surfaceFor(f, parsed);
    newSurfaces.set(f, newSurface);

    // If the surface changed, every file importing `f` may have stale
    // resolver output and must be re-parsed.
    const prev = prevSurfaces[f];
    const changed = prev === undefined || prev !== newSurface;
    if (changed) {
      const importers = await queryImporters(f);
      for (const i of importers) {
        if (!closure.has(i)) {
          closure.add(i);
          queue.push(i);
          expandedFromImporters.add(i);
        }
      }
    }
  }

  return { closure, parseCache, newSurfaces, expandedFromImporters };
}
