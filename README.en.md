# dsh-research-solver

Solve a problem the way you would write a paper: first show where existing work falls short, then measure every option with one ruler, then iterate on numbers instead of vibes.

It is not a longer prompt. A prompt disappears with the session, its conclusions cannot be recomputed, and its stages get skipped — those three holes are what this plugin fills.

## Two principles

| Principle | What it becomes in code |
| --- | --- |
| **1. Innovate against someone's shortfall** | Every gap must cite a real source; every candidate must claim which gaps it closes. A candidate that claims none is called out in `human/成品/方案.md` as not yet an innovation. |
| **2. Spend as little as possible — local before web** | Every source carries a `tier`: 0 local workspace → 1 local knowledge base → 2 local app/MCP → 3 web. Tier 3 requires `whyLocalFailed`, otherwise the check reports `S001`; a local share below 50% reports `S002`. |

## Four stages

```
1 collect  ──→  2 metrics & evaluation  ──→  3 improve / fuse  ──→  4 iterate
  find gaps        one ruler for all            fix the weak spots      measure again
```

The stage is **derived from the artifacts**, not declared: sources make it 1; metrics plus scores make it 2; a fused candidate makes it 3; two completed rounds make it 4. Skip a step and `research_task action=status` says so.

## Three tools

### `research_task` — move the process forward

| action | effect |
| --- | --- |
| `init` | create `research/<slug>/` with `ai/state.json` and the whole `human/` tree |
| `status` | current stage, ranking, check results, what to do next |
| `source` | record a source (with `tier`, `whyLocalFailed`) |
| `gap` | record "who does what badly", with `evidence` pointing at a source id |
| `metric` | define a metric (0–10, `direction: higher/lower`, weight); `replace: true` swaps the whole set and marks earlier conclusions stale |
| `candidate` | record a candidate; `kind: fused` + `fuses: [ids]` marks a merge |
| `choose` | finalize into `human/成品/方案.md` |
| `check` | re-render every document and compare byte for byte: `H001` missing file / `H002` hand-edited / `H003` state-vs-artifact drift |

### `research_score` — score and iterate

| action | effect |
| --- | --- |
| `evaluate` | score a candidate and attach the reasoning |
| `iterate` | freeze a round; `hypothesis` is required |
| `compare` | recompute only, write nothing — for challenging an existing conclusion |

### `file_layout` — file governance (not just for research projects)

The requested layout was "files for people and files for AI, with people's side split into chat / process / deliverable / verifiable intermediate" — those four plus `ai/` are the only skeleton this tool knows, and **any directory** can use it.

| action | effect |
| --- | --- |
| `init` | create the five folders plus six folder READMEs; never overwrites |
| `audit` | classify every file deterministically into misplaced / needs-a-human / loose-at-root |
| `move` | move files; `all: true` moves only high/medium confidence, `path` + `kind` handles the rest |
| `map` | rebuild `human/README.md` (human map) and `ai/index.json` (machine index) |

Classification uses two clues in a fixed order — **name first, extension second** — and refuses to guess: an ambiguous file is reported as `?` with the reason, never moved. Moving a file to the wrong folder costs more than asking the user once.

### Scoring is deterministic

```
norm  = direction === 'higher' ? s/10 : (10-s)/10
total = Σ (weight / Σweight) × norm
```

For a given `ai/state.json`, the total is identical no matter who computes it or how many times. The model supplies the 0–10 raw scores and the reasoning; the arithmetic is the engine's.

Two views that ignore the total:

- **Pareto front** — candidates nothing dominates, so a high total cannot hide a collapsed dimension.
- **Gap coverage** — the share of gaps claimed by candidates scoring ≥ 0.60. A candidate can rank first and still not be solving the problem you started from.

## Artifacts: two trees

```
research/<slug>/
├── ai/                      ← for machines: the single source of truth
│   ├── state.json           all state, replayable as a whole
│   ├── index.json           file list + sha256 (detects hand edits)
│   ├── evidence/sources.jsonl
│   └── log.jsonl            one line per operation, append-only
└── human/                   ← for people: rendered from state, do not edit
    ├── 交流/                 chat & decisions
    ├── 流程展示/             stage-by-stage process
    ├── 成品/                 the deliverable
    └── 可验证中间过程/        score sheet + check list
```

Every file under `human/` is a pure function of state, which is why `check` can compare it byte for byte. To change a document you change state — that is what "verifiable" means here: conclusions are recomputed, not maintained by hand.

## Install

From npm:

```
dsh plugin add dsh-research-solver
```

From GitHub:

```
dsh plugin add github:LoneLeave/dsh-research-solver
```

From a local checkout:

```
plugin_manager action=install_bundle target=<absolute path to this directory>
```

Host-only bundle, no client code, no third-party dependencies, `node >= 22`. It registers the skill `research-solver`, which explains when to reach for the two principles and the four stages.

## Self-test

```bash
node scripts/selftest.mjs
```

32 assertions, run without the DSH runtime against the engine and the disk layer: independent recomputation of totals, `lower` direction inversion, contiguous ranks, Pareto subset, gap coverage, byte-identical re-render, write/read round trip, and negative cases for `S001` / `C001` / `G001` / `R001`, plus the file-layout rules.

## Known limitations

- **It keeps books, it does not verify facts.** Whether a source exists or a score is fair is outside its scope; what it guarantees is consistent records and recomputable conclusions.
- **`human/` is read-only.** Hand edits are caught by `H002` and overwritten on the next render — deliberate, but it means wording changes go through the render templates.
- **No concurrent writes.** Two sessions advancing the same project will overwrite each other; there is no lock.
- **Weights are a human decision.** A different weighting can crown a different winner; `metric replace` marks earlier conclusions stale (`R001`) but will not re-evaluate for you.
- **File classification is heuristic.** `file_layout` reads names and extensions, not content: a process note called `plan.md` will be suggested for the deliverables folder. It reports `?` instead of guessing, but it is not smarter than your naming — glance at the `audit` suggestions before moving a batch.
- **`move` changes paths**, so scripts, links and IDE configs that rely on relative paths will break.

## Relation to prompt-only research skills

Domain skills (paper writing, idea review, literature search) are strong at knowledge and prose. This plugin does not repeat them; it fills the gaps they leave — state, recomputation, stage discipline, and a human/machine split. They compose: use them to produce content, use this to keep the books and the scores.
