# pi-ci-standard

Deterministic CI-standard generator/auditor for Pi. Establishes one house contract in a repository:

- `mise run check` — iterative checks while working
- `mise run ci` — final full gate before completion
- GitHub Actions calls **only** `mise run ci`, never language-specific check commands

It generates and audits three artifacts, all with ownership markers:

| File | What |
| --- | --- |
| `mise.toml` | Managed `[tasks.check]` / `[tasks.ci]` block |
| `.github/workflows/ci.yml` | Managed workflow that runs `mise run ci` |
| `AGENTS.md` | Managed `## Validation` block telling agents the contract |

## Install

```bash
pi install /path/to/pi-ci-standard        # or npm:/git: source
```

Loads one extension registering `/ci`. No LLM tools, no prompt snippets, no skills — Pi's tool surface is unchanged. CI execution stays in your terminal (`mise run check` / `mise run ci`); there is deliberately no `/ci run`.

## Use

Inside Pi:

```
/ci init [dir] [--kind node|go|rust]
/ci audit [dir] [--kind node|go|rust]
/ci status [dir] [--kind node|go|rust]
/ci fix [dir] [--kind node|go|rust]
```

Quote paths containing spaces: `/ci fix "../my project"` (no escape sequences inside quotes).

Same core logic (init/audit/status only) is exposed as a CLI for agents/scripts via bash:

```bash
pi-ci init
pi-ci audit        # configuration-only, exit 1 on drift/missing
pi-ci status       # read-only compact summary, exit 0
pi-ci --help
```

`pi install` loads the extension but may not place the package bin on shell `PATH`. `/ci fix` therefore gives the agent the bundled CLI's absolute path; standalone shell use requires installing/linking the npm package so `pi-ci` is on `PATH`.

- `init` — generate or update the three artifacts. Idempotent: a second run reports `no changes`.
- `audit` — read-only configuration drift/missing report, nonzero exit on any finding. It does not run project checks; use `mise run check` or `mise run ci` for execution.
- `status` — read-only one-line-per-artifact summary.
- `fix` — **Pi-only** (deliberately absent from the `pi-ci` CLI; `pi-ci fix` is invalid). Runs the deterministic audit first: if it passes, notifies `CI standard already satisfied` and does nothing; if it fails with ordinary findings, sends one repair prompt to the agent containing the exact audit output, target directory/kind, bundled CLI path, and safety rules (preserve project checks and thresholds, migrate unmanaged workflow behavior, preserve unrelated config, evidence-based toolchain pins, run bundled `init` → `audit` → `mise run check` → `mise run ci`, fix root causes, no commit/push). Usage/detection errors show a notification instead of invoking the LLM.

## Project kinds

Exactly three, auto-detected by marker file: `node` (package.json), `go` (go.mod), `rust` (Cargo.toml). Missing or ambiguous detection fails with a clear message; pass `--kind` to disambiguate (the marker for the explicit kind must still exist).

- **node**: reuses your existing `npm run validate` (check) and `npm ci && npm run ci` (ci — fresh install keeps local and CI identical).
- **go**: stdlib only, no new dependencies. check = `gofmt` verification + `go vet` + `go test`; ci = check + `-race` + `go build`.
- **rust**: check = `cargo fmt --check` + `cargo check` + `cargo clippy -- -D warnings`; ci = check + `cargo test`.

## Prerequisites

`init` fails mutation-free when any prerequisite is absent; `audit` reports them; `status` shows values or `missing`. pi-ci never installs dependencies, writes versions, adds scripts, or creates biome config.

**All kinds** — `mise.toml` must pin the toolchain in a plain `[tools]` table with one-line quoted assignments, e.g. `node = "24.18.0"`. Parsing limitation: inline tables, multi-line arrays, and dotted keys are not parsed (no TOML dependency); use the plain form.

**Node:**

- `package-lock.json` must exist (generated ci runs `npm ci`).
- `package.json` scripts, all non-empty after trim:
  - `quality` must normalize to exactly `biome ci .`
  - `validate` must invoke `npm run quality`
  - `ci` must invoke `npm run quality` or `npm run validate`
  - recursion rejected: `validate` must not invoke `mise run check`, `ci` must not invoke `mise run ci`
- `devDependencies` must contain a non-empty `@biomejs/biome` version, and `biome.json` must exist (`biome.jsonc` unsupported).

## Safety

- Everything generated carries ownership markers; only marked regions are ever rewritten.
- Pre-existing `[tasks.check]`/`[tasks.ci]` outside the managed block, or an unmanaged `.github/workflows/ci.yml`, cause a hard failure with an actionable message — nothing is silently overwritten.
- Existing `mise.toml` `[tools]` config and arbitrary `AGENTS.md` text are preserved.
- All subprocess use in tests/CLI is argument-array based; no shell interpolation of user input.
- `init` plans all three artifacts first: validation/conflict failures are mutation-free (no partial writes).

## Toolchain versions

The project's own `mise.toml` `[tools]` section owns and pins Node/Go/Rust versions. pi-ci requires the pin to exist but never chooses or writes a version.

## Design boundaries

Out of scope, on purpose: no LLM tools or prompt metadata (the only model interaction is the explicit, user-invoked `/ci fix` repair message), no CI execution (`/ci run` does not exist), no project kinds beyond node/go/rust, no feature-flag/workspace policy invention for rust, no config DSL, no plugin architecture, no dependency installation, no remote CI APIs, no background processes.

Known limits: unmanaged-task conflict detection in `mise.toml` covers the `[tasks.check]` / `[tasks.ci]` table forms; exotic inline-table task definitions are not detected.

## Development

```bash
npm install
mise run check   # iterative: biome + tsc + node --test
mise run ci      # full gate: check + pi smoke + package checks
```
