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
```

Same core logic is exposed as a CLI for agents/scripts via bash:

```bash
pi-ci init
pi-ci audit        # read-only, exit 1 on drift/missing
pi-ci status       # read-only compact summary, exit 0
```

- `init` — generate or update the three artifacts. Idempotent: a second run reports `no changes`.
- `audit` — read-only drift/missing report, nonzero exit on any finding.
- `status` — read-only one-line-per-artifact summary.

## Project kinds

Exactly three, auto-detected by marker file: `node` (package.json), `go` (go.mod), `rust` (Cargo.toml). Missing or ambiguous detection fails with a clear message; pass `--kind` to disambiguate (the marker for the explicit kind must still exist).

- **node**: reuses your existing `npm run validate` (check) and `npm ci && npm run ci` (ci — fresh install keeps local and CI identical). If either script is missing, init/audit fail — scripts are never invented for you.
- **go**: stdlib only, no new dependencies. check = `gofmt` verification + `go vet` + `go test`; ci = check + `-race` + `go build`.
- **rust**: check = `cargo fmt --check` + `cargo check` + `cargo clippy -- -D warnings`; ci = check + `cargo test`.

## Safety

- Everything generated carries ownership markers; only marked regions are ever rewritten.
- Pre-existing `[tasks.check]`/`[tasks.ci]` outside the managed block, or an unmanaged `.github/workflows/ci.yml`, cause a hard failure with an actionable message — nothing is silently overwritten.
- Existing `mise.toml` `[tools]` config and arbitrary `AGENTS.md` text are preserved.
- All subprocess use in tests/CLI is argument-array based; no shell interpolation of user input.
- `init` plans all three artifacts first: validation/conflict failures are mutation-free (no partial writes).

## Toolchain versions

The project's own `mise.toml` `[tools]` section owns and pins Node/Go/Rust versions. pi-ci-standard never writes `[tools]` and `audit` does not enforce versions — it only manages the `check`/`ci` tasks, workflow, and AGENTS.md block.

## Design boundaries

Out of scope, on purpose: no LLM tools or prompt injection, no CI execution (`/ci run` does not exist), no project kinds beyond node/go/rust, no feature-flag/workspace policy invention for rust, no config DSL, no plugin architecture, no dependency installation, no remote CI APIs, no background processes.

Known limits: unmanaged-task conflict detection in `mise.toml` covers the `[tasks.check]` / `[tasks.ci]` table forms; exotic inline-table task definitions are not detected.

## Development

```bash
npm install
mise run check   # iterative: biome + tsc + node --test
mise run ci      # full gate: check + pi smoke + package checks
```
