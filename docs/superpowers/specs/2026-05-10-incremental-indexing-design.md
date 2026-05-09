# Incremental Indexing Design

**Date:** 2026-05-10
**Status:** Approved (sections 1-5 reviewed inline by maintainer 2026-05-10)
**Owner:** abhigyanpatwari + Claude Code
**Prior art:** PR #592 (zenprocess), PR #533 (davidbeesley), PR #1146 (azeemshaik025)

## Why

`gitnexus analyze` currently has only a coarse-grained early-exit: if `meta.json.lastCommit == HEAD` and the working tree is clean, it no-ops; otherwise it does a full re-index. On a 60K+ symbol TypeScript repo a full re-index can take ~30s. After a one-line edit, that's wasted work.

Three open community PRs (#592, #533, #1146) attempt incremental re-indexing but each has problems:

- **#592** (zenprocess) targets a now-defunct version of `pipeline.ts` (the codebase has since refactored to a phase-based pipeline). Beyond the merge conflict, its design has a real correctness bug: it only feeds changed files into `parse`, leaving `ctx.graph` populated with just the changed-file subgraph. Community detection (Leiden) then runs on that subgraph and produces drift, since modularity is a global metric and Leiden's results depend on graph-wide topology.
- **#1146** (azeemshaik025) is a stacked review-fix PR for #592 — inherits the same design bug.
- **#533** (davidbeesley) caches per-file parse and embedding results content-addressed but explicitly leaves "incremental LadybugDB load" out of scope. It's a parse/embedding speedup, not real incremental indexing.

We reject the partial-graph-Leiden approach. The correctness invariant is **incremental output ≡ full-rebuild output**.

## Correctness contract

A run of `analyze` (default, incremental) on a repo that previously had `analyze --force` run against state S1 and is now at state S2 must produce a LadybugDB whose contents (nodes, edges, graph-wide phase outputs) are equivalent to running `analyze --force` directly against S2 from a fresh state. "Equivalent" means: identical node IDs, identical edge sets, identical Community membership (with seeded Leiden RNG), identical Process detection.

This is verified by an equivalence test (§ Testing) that snapshots the DB after both paths and asserts equality.

## Decisions (locked in by maintainer)

1. **Re-parse scope:** transitive importer closure of changed files. When a changed file's *public surface* (exported symbol names + signatures + heritage) is unchanged, do not expand to its importers. This is the v1 surface-change optimization.
2. **Change detection:** `git diff lastCommit HEAD` (committed) ∪ `git status --porcelain` (dirty). Non-git repos always do a full rebuild (the existing behavior for them — they have no change-detection mechanism and never did).
3. **Rollout:** new default for `analyze`. `--force` opts out and always does a full rebuild.
4. **Embeddings:** out of scope for v1. Existing semantics preserved (unchanged-file embeddings survive; closure-file embeddings are dropped along with their nodes; no regeneration without `--embeddings`).
5. **Leiden RNG:** seeded for reproducibility (small foundational change to `community-processor.ts`, independent of incremental but required for the equivalence test).

## Architecture

The pipeline already uses a phase-based DAG (12 phases, `runPipeline` in `pipeline-phases/runner.ts`). We add **one new phase** (`hydrate`) and **one new DB primitive** (`loadGraphFromLbug`). The orchestrator (`run-analyze.ts`) gains the closure-computation logic. Existing phases (`parse`, `mro`, `communities`, `processes`) are untouched or get tiny surgical changes.

```
                              ┌──────────────────────────────────────┐
                              │  run-analyze.ts (orchestrator)       │
                              │  • git diff vs lastCommit            │
                              │  • iterative closure expansion       │
                              │    (parse + surface check)           │
                              │  • set ctx.options.filesToParse      │
                              │  • set incrementalInProgress flag    │
                              └──────────────────────┬───────────────┘
                                                     ▼
   ┌─────────────────────────────── pipeline ─────────────────────────────────┐
   │  scan → structure → [hydrate] → [markdown,cobol] → parse → routes/tools/ │
   │                       (NEW)                       (filtered)             │
   │   orm → crossFile → scopeResolution → mro → communities → processes      │
   │                                              (run on FULL hydrated graph)│
   └─────────────────────────┬────────────────────────────────────────────────┘
                             ▼
                   ┌──────────────────────────┐
                   │  lbug-adapter.ts         │
                   │  • loadGraphFromLbug    │  ← NEW (DB → KnowledgeGraph)
                   │  • deleteNodesForFiles   │  ← already exists, batch wrap
                   │  • loadGraphToLbug       │  ← already exists
                   └──────────────────────────┘
```

### Why a new phase (Approach A) and not orchestrator-only

The codebase invests heavily in the phase architecture: typed dep graph, dedicated runner, single shared `KnowledgeGraph` accumulator, documented "how to add a phase" contract in `ARCHITECTURE.md`. Approach A (new phase) matches that pattern exactly — `mro`, `communities`, `processes` need *zero* code changes because they just see a fully-populated `ctx.graph`. Approach B (orchestrator-driven merge, pipeline untouched) would require either calling phase implementations directly from outside the runner or duplicating phase wiring; both fight the architecture. Approach C (two parallel orchestrators) duplicates registry/AGENTS-update/error-handling and drifts over time.

## Components

### `core/incremental/git-diff.ts` (new)

```ts
export interface ChangedFiles {
  modified: string[];
  added: string[];
  deleted: string[];
}

export function getChangedFilesSinceCommit(
  repoPath: string,
  lastCommit: string,
): ChangedFiles;
```

Implementation: `git diff --name-status <lastCommit> HEAD` for committed changes plus `git status --porcelain` for dirty tree. Renames are flattened (R100 file_old → file_new becomes delete(file_old) + add(file_new)). Returns `null` (or throws a sentinel error) when `lastCommit` no longer exists in the repo (rebased away) — the orchestrator falls back to full rebuild.

### `core/incremental/surface.ts` (new)

```ts
export function extractSurfaceSignature(
  graph: KnowledgeGraph,
  filePath: string,
): string;  // stable hash

export function surfaceChanged(prev: string | undefined, current: string): boolean;
```

Walks `graph` for nodes with the given `filePath`, filters to publicly-visible (functions, classes, methods, interfaces, types — using existing `LanguageProvider.exportChecker` per node's language), extracts each's `name + parameter types + return type + heritage`, sorts deterministically, hashes. Stored per-file in `meta.json.surfaceSignatures`.

A *body-only* change to a file produces the same surface hash. A *signature* change produces a different hash → closure expands to importers.

### `core/incremental/closure.ts` (new)

```ts
export interface ClosureResult {
  closure: Set<string>;
  parseCache: Map<string, ParseWorkerResult>;
}

export async function computeImporterClosure(
  initialChangedFiles: Set<string>,
  prevSurfaces: Record<string, string>,
  parseFile: (path: string) => Promise<ParseWorkerResult>,
  queryImporters: (filePath: string) => Promise<string[]>,
): Promise<ClosureResult>;
```

Iterative fixpoint:

```
queue   = initialChangedFiles
closure = initialChangedFiles
parseCache = new Map()

while queue not empty:
  f = queue.pop()
  pr = await parseFile(f)            // single-file tree-sitter parse
  parseCache.set(f, pr)
  newSurface = extractSurfaceSignature(pr-derived graph, f)
  if newSurface !== prevSurfaces[f]:   // surface changed (or no prev)
    importers = await queryImporters(f)
    for i in importers \ closure:
      closure.add(i); queue.add(i)

return { closure, parseCache }
```

`queryImporters(f)` is `MATCH (a)-[r:IMPORTS]->(b) WHERE b.filePath = $f RETURN DISTINCT a.filePath` against the existing DB.

### `core/lbug/lbug-adapter.ts` — new `loadGraphFromLbug`

```ts
export async function loadGraphFromLbug(
  graph: KnowledgeGraph,
  unchangedFilePaths: Set<string>,
): Promise<{ nodesLoaded: number; edgesLoaded: number }>;
```

For each non-graph-wide node table (File, Folder, Function, Class, Method, …) streams rows where `filePath IN $unchangedFilePaths`, calls `graph.addNode(...)`. Then streams `CodeRelation` rows where source and target both have `filePath` in the set OR one endpoint is the source belongs to a node we already loaded. Skips Community/Process labels and their MEMBER_OF / STEP_IN_PROCESS edges entirely — those are graph-wide, will be regenerated by `communitiesPhase` / `processesPhase` from scratch.

Batch via `streamQuery` (already used in lbug-adapter for back-pressure). Filter set passed via Cypher parameter, not string interpolation.

### `pipeline-phases/hydrate.ts` (new)

```ts
import type { PipelinePhase } from './types.js';
import { getPhaseOutput } from './types.js';
import type { StructureOutput } from './structure.js';
import { loadGraphFromLbug } from '../../lbug/lbug-adapter.js';

export interface HydrateOutput {
  hydrated: boolean;
  nodesLoaded: number;
}

export const hydratePhase: PipelinePhase<HydrateOutput> = {
  name: 'hydrate',
  deps: ['structure'],
  async execute(ctx, deps) {
    const filesToParse = ctx.options?.filesToParse;
    if (!filesToParse) return { hydrated: false, nodesLoaded: 0 };  // full mode

    const { allFilePaths } = getPhaseOutput<StructureOutput>(deps, 'structure');
    const unchanged = new Set(allFilePaths.filter((f) => !filesToParse.has(f)));
    const result = await loadGraphFromLbug(ctx.graph, unchanged);
    return { hydrated: true, nodesLoaded: result.nodesLoaded };
  },
};
```

No-op when `filesToParse` is unset (full-rebuild path is byte-for-byte unchanged).

### `pipeline-phases/parse.ts` (modified, surgical)

Add ~8 lines at the top of `parsePhase.execute`:

```ts
const filesToParse = ctx.options?.filesToParse;
const prebuiltParseResults = ctx.options?.prebuiltParseResults;
const targetFiles = filesToParse
  ? scannedFiles.filter((f) => filesToParse.has(f.path))
  : scannedFiles;
// ... existing chunked parsing logic uses targetFiles
// when iterating, if prebuiltParseResults?.has(file.path), skip the worker
// dispatch and merge the cached result instead.
```

Existing chunked-parse logic, worker dispatch, and binding accumulator lifecycle unchanged.

### `pipeline.ts` (modified)

- Register `hydratePhase` in `buildPhaseList()` between `structurePhase` and `markdownPhase`/`cobolPhase`.
- Extend `PipelineOptions`:

```ts
export interface PipelineOptions {
  // existing fields...
  /** Subset of repo-relative paths to parse. When set, the parse phase skips
   *  files outside this set. Files not in this set are loaded from DB by the
   *  hydrate phase. */
  filesToParse?: Set<string>;
  /** Optional pre-parsed results to reuse instead of re-running tree-sitter
   *  on closure files (populated by the orchestrator during closure
   *  computation). */
  prebuiltParseResults?: Map<string, ParseWorkerResult>;
}
```

### `core/run-analyze.ts` (modified, the orchestrator)

```ts
// At the top of runFullAnalysis, after loading meta:

const repoHasGit = hasGitDir(repoPath);
const currentCommit = repoHasGit ? getCurrentCommit(repoPath) : '';
const existingMeta = await loadMeta(storagePath);

// Existing early-exit for "lastCommit == HEAD && clean tree" — keep as-is.

// Recover from a crashed previous run.
if (existingMeta?.incrementalInProgress) {
  log('Previous incremental run did not complete cleanly — full rebuild');
  options = { ...options, force: true };
}

// Decide path: incremental vs full.
const incremental =
  !options.force &&
  repoHasGit &&
  existingMeta &&
  existingMeta.schemaVersion === CURRENT_SCHEMA_VERSION &&
  existingMeta.surfaceSignatures &&
  existingCommitExists(repoPath, existingMeta.lastCommit);

if (incremental) {
  const changed = await getChangedFilesSinceCommit(repoPath, existingMeta.lastCommit);
  const initial = new Set([...changed.modified, ...changed.added]);

  const { closure, parseCache } = await computeImporterClosure(
    initial,
    existingMeta.surfaceSignatures,
    parseFileForSurface,                 // wraps parse-worker for one file
    queryImporters,                      // wraps the IMPORTS-into Cypher query
  );

  // Mark dirty BEFORE any delete.
  await saveMeta({ ...existingMeta, incrementalInProgress: { closure: [...closure], startedAt: Date.now() } });

  await initLbug(lbugPath);
  await deleteNodesForFiles([...closure, ...changed.deleted]);
  await deleteAllCommunitiesAndProcesses();

  pipelineOptions.filesToParse = closure;
  pipelineOptions.prebuiltParseResults = parseCache;

  // Pipeline runs once with these options.
  // After pipeline, ctx.graph contains hydrated unchanged + freshly parsed closure.

  // Writeback: ONLY closure files + graph-wide nodes/edges.
  await loadChangedSubgraphToLbug(graph, closure);

  // Update surfaces.
  const newSurfaces = { ...existingMeta.surfaceSignatures };
  for (const f of changed.deleted) delete newSurfaces[f];
  for (const f of closure) newSurfaces[f] = extractSurfaceSignature(graph, f);

  await saveMeta({
    ...existingMeta,
    lastCommit: currentCommit,
    surfaceSignatures: newSurfaces,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    incrementalInProgress: undefined,  // clears the dirty flag
    stats: ...,
    indexedAt: new Date().toISOString(),
  });
} else {
  // Full rebuild path (existing logic, unchanged).
  // After completion, populate surfaceSignatures for every file so the next
  // run can be incremental.
  const surfaces: Record<string, string> = {};
  for (const f of allFilePaths) surfaces[f] = extractSurfaceSignature(graph, f);
  await saveMeta({
    ...existingMeta,
    lastCommit: currentCommit,
    surfaceSignatures: surfaces,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ...
  });
}
```

### `storage/repo-manager.ts` (modified — `RepoMeta` schema)

```ts
export interface RepoMeta {
  // ... existing fields ...
  schemaVersion?: number;        // bump when incremental invariants change
  surfaceSignatures?: Record<string, string>;  // filePath → surface hash
  incrementalInProgress?: {
    closure: string[];
    startedAt: number;
  };
}

export const CURRENT_SCHEMA_VERSION = 1;
```

`schemaVersion` lets us force a full rebuild if internal invariants change. Missing or mismatched version → full rebuild path. `incrementalInProgress` is the dirty flag for crash recovery.

## Data flow (incremental run)

```
analyze (no flags) on a git repo with existing index
─────────────────────────────────────────────────────
1. Orchestrator loads meta.json
   ├── schemaVersion, lastCommit, surfaceSignatures, incrementalInProgress
   └── If incrementalInProgress present → log + force full rebuild
   └── If schemaVersion mismatch OR meta missing → full rebuild path

2. Sanity check: does lastCommit still exist?
   └── git cat-file -e <lastCommit> → if missing, full rebuild path

3. Compute git changes
   ├── git diff --name-status <lastCommit> HEAD
   ├── git status --porcelain
   └── → ChangedFiles { modified, added, deleted } (renames flattened)

4. Iterative closure expansion
   queue   = modified ∪ added
   closure = modified ∪ added
   parseCache = new Map()
   while queue not empty:
     f = queue.pop()
     pr = await parseFile(f)         // single-file tree-sitter
     parseCache.set(f, pr)
     newSurface = extractSurface(pr-derived, f)
     if newSurface !== prevSurfaces[f]:
       importers = db.queryImporters(f)
       for i in importers \ closure:
         closure.add(i); queue.add(i)

5. Mark dirty: meta.json.incrementalInProgress = { closure, startedAt }

6. Delete-before-write
   ├── deleteNodesForFiles(closure ∪ deleted)
   └── deleteAllCommunitiesAndProcesses()

7. Run pipeline ONCE with options:
     filesToParse        = closure
     prebuiltParseResults = parseCache
   Phase order:
     scan → structure → hydrate (NEW) → markdown,cobol → parse (filtered)
     → routes,tools,orm,crossFile,scopeResolution,mro
     → communities (Leiden on FULL graph) → processes

8. Writeback to DB
   ├── insertNodes(ctx.graph nodes where filePath ∈ closure)
   ├── insertNodes(Community, Process, etc. — graph-wide)
   ├── insertRelationships(... where source.filePath ∈ closure OR graph-wide)
   └── (Unchanged-file rows in DB are never touched.)

9. Update meta.json (clears incrementalInProgress)
   ├── lastCommit  = HEAD
   ├── surfaceSignatures = { ...prev (unchanged), ...new (closure) }, drop deleted
   └── schemaVersion = CURRENT_SCHEMA_VERSION
```

### Why iterative parse works correctly

A file's surface signature depends only on its own content (exported names, signatures, heritage), not on what it imports. So we can compute the new surface for `f` from a single-file tree-sitter parse without resolution or cross-file passes. The `parseCache` is the trick that prevents doing this work twice: the parse phase reuses these results when it sees them in `prebuiltParseResults`.

Time-complexity intuition: every file in `closure` is tree-sitter-parsed exactly once. Files outside `closure` are never parsed, just loaded from DB by `hydrate`. Parse cost ≈ proportional to `|closure|` rather than `|allFiles|`.

### Subtle correctness checks

| Concern | How handled |
|---|---|
| Renamed file `A.ts` → `B.ts` | Flattened to `delete A.ts` + `add B.ts`; `A` rows deleted; `B` ends up in closure |
| Deleted file | Rows deleted; importers added to closure via surface check (file's old surface treated as "different from absent new") |
| Added file | In `modified ∪ added`; its importers are zero (newly added; nobody imports it yet) |
| `lastCommit` rebased away | `git cat-file -e` fails → full rebuild |
| Working tree dirty mid-run | We snapshot `git status` once at step 3; later edits are caught next run |
| Graph-wide nodes (Community, Process) | Always deleted & regenerated; deleted by label, not by `filePath` |
| Concurrent analyze runs | Existing `lbug.lock` single-writer guard prevents this |
| First incremental after upgrade | `surfaceSignatures` empty in meta → fall through to full rebuild; that run populates it; next run is incremental |

## Error handling

The core hazard: step 6 deletes DB rows before step 8 writes new ones. A crash between leaves the index half-built. The recovery strategy is the **`incrementalInProgress` dirty flag** in meta.json:

- Step 5 writes the flag *before* any delete.
- Step 9 (success) clears it via overwrite.
- Step 1 of the *next* run detects the flag and forces a full rebuild.

This works regardless of LadybugDB transactional semantics.

| Failure | Detection | Action |
|---|---|---|
| `lastCommit` gone | `git cat-file -e <lastCommit>` fails | Full rebuild path |
| `schemaVersion` mismatch | meta.json check at step 1 | Full rebuild path |
| `surfaceSignatures` missing (first run after upgrade) | meta.json check | Full rebuild on this run; populates signatures; next run incremental |
| Git command fails | exec error | Refuse incremental; full rebuild |
| DB read fails during hydrate | bubbles from `loadGraphFromLbug` | Run aborts; dirty flag set; next run does full rebuild |
| Worker-pool crash during parse | existing pipeline error path | Same as today; dirty flag triggers full rebuild |
| Disk full during writeback | LadybugDB write error | Same — dirty flag → full rebuild |
| Concurrent runs | `lbug.lock` | Already prevented |
| User Ctrl-C | SIGINT | Dirty flag persists; next run is full rebuild |

## Logging

Each incremental run logs at the existing `log()` level:

```
Incremental: 7 changed, 12 importers (closure 19), 4843 unchanged
  Hydrated 50312 nodes from DB
  Parsed 19 files (cache reuse: 7)
  Communities: 287 detected (modularity 0.847)
  Wrote 19 file rows + Community/Process; preserved 4843 file rows
```

Plus a one-line `Full rebuild forced: <reason>` when falling back. Crucial for debugging on real repos.

## Testing

### Unit tests (`gitnexus/test/unit/`)

| Module | Critical cases |
|---|---|
| `git-diff.ts` | clean tree; dirty only; committed only; mixed; renames; deletes; lastCommit not in repo; empty repo |
| `surface.ts` | body-only edit produces same hash; signature change produces different hash; reorder of exports produces same hash; whitespace/comments don't affect hash |
| `closure.ts` | empty changed set → empty closure; single body-only change → closure size 1; signature change with N importers → closure size N+1; multi-hop cascade reaches fixpoint; cycle in import graph terminates; deleted file expansion includes its importers |
| `loadGraphFromLbug` | roundtrip via `loadGraphToLbug` → identical node/edge sets; respects `filePath IN $set` filter; correctly skips Community/Process labels |

### Integration tests (`gitnexus/test/integration/`)

- `hydratePhase` populates `ctx.graph` from a fixture DB correctly.
- Closure-driven parse: 2-file fixture (`a.ts` imports `b.ts`); body-only edit to `b.ts` parses only `b.ts`; signature edit parses both.
- Dirty flag recovery: write `incrementalInProgress` manually, run analyze, verify full rebuild path triggered + flag cleared at end.

### Equivalence test (the gold standard)

```ts
test('incremental ≡ full-rebuild on real fixture', async () => {
  const repo = await setupFixtureRepo();
  await runFullAnalysis(repo, { force: true });
  const baseline = await snapshotDb();

  for (const editScenario of EDIT_SCENARIOS) {
    await editScenario.apply(repo);

    // path A: incremental
    await runFullAnalysis(repo, {});
    const incrementalSnap = await snapshotDb();

    // path B: rebuild from scratch on the same edited state
    await runFullAnalysis(repo, { force: true });
    const fullRebuildSnap = await snapshotDb();

    expect(incrementalSnap).toEqual(fullRebuildSnap);

    await editScenario.revert(repo);
  }
});

const EDIT_SCENARIOS = [
  bodyOnlyEdit,
  signatureChange,
  exportRename,
  classHeritageChange,
  fileDelete,
  fileAdd,
  barrelRewrite,
  multiFile,
];
```

This requires **seeded Leiden RNG** (one-line change in `community-processor.ts`) so community assignment is deterministic between runs.

### Local validation plan (pre-PR)

| Repo | Why | Expected closure on small edit |
|---|---|---|
| GitNexus (this repo) | Mid-size (~5k symbols), TS, dogfood | 1–10 files |
| Larger TS repo (60k+ symbols) | Stress test, validates timing | 5–50 files for body edit |
| Barrel-heavy repo | Worst case for cascade | up to ~full re-index for surface change in a leaf |

For each: full-rebuild baseline, then for each scenario:
1. Apply edit
2. Run incremental
3. Run `--force` from same edited state
4. DB diff must be zero
5. Capture: closure size, time per phase, modularity

Plus: SIGINT mid-incremental → next run recovery; multi-edit succession.

### Performance gates (informational, not blocking)

- Closure size 1: target ≥3× speedup vs full
- Closure 10% of repo: target ≥2× speedup
- Closure 50% of repo: ~break-even, acceptable
- Full rebuild path: zero regression vs today

### Pre-PR checklist (per CONTRIBUTING.md)

- [ ] `cd gitnexus && npm test` passes
- [ ] `cd gitnexus && npx tsc --noEmit` passes
- [ ] Equivalence test passes for all scenarios
- [ ] Crash recovery scenario passes
- [ ] PR title is `feat(analyze): incremental indexing via git diff`
- [ ] PR body credits zenprocess / davidbeesley / azeemshaik025 with links to #592 / #533 / #1146
- [ ] AGENTS.md / GUARDRAILS.md updated for new behavior (default is incremental; `--force` for full)
- [ ] No drive-by refactors

## Out of scope (v2 follow-ups)

- Embeddings: an `--embeddings` run after incremental should regenerate vectors only for closure-added nodes. Currently regenerates per existing semantics (which is broader than necessary). Optimize later.
- Persistent on-disk parse cache (PR #533's contribution) — content-addressed cache that survives across analyze invocations. Composes cleanly with this work.
- Cross-repo incremental for groups (group bridges).
- Incremental MCP `detect_changes` invalidation.
