import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type Kind = "node" | "go" | "rust";
export const KINDS = ["node", "go", "rust"] as const;

export class CiError extends Error {}

export interface RunResult {
	code: number;
	output: string;
}

const MARKER_FILE: Record<Kind, string> = {
	node: "package.json",
	go: "go.mod",
	rust: "Cargo.toml",
};

const MISE_START = "# >>> pi-ci-standard managed — regenerate with: pi-ci init >>>";
const MISE_END = "# <<< pi-ci-standard managed <<<";
const WORKFLOW_MARKER = "# Managed by pi-ci-standard — regenerate with: pi-ci init";
const AGENTS_START = "<!-- pi-ci-standard:validation:start -->";
const AGENTS_END = "<!-- pi-ci-standard:validation:end -->";

const MISE_CONFLICT = /^\s*\[tasks\.(check|ci)\]/m;

export function detectKind(dir: string, explicit?: string): Kind {
	if (explicit !== undefined) {
		if (!KINDS.includes(explicit as Kind)) {
			throw new CiError(`unknown kind "${explicit}" (expected: ${KINDS.join("|")})`);
		}
		const kind = explicit as Kind;
		if (!existsSync(join(dir, MARKER_FILE[kind]))) {
			throw new CiError(`--kind ${kind}: no ${MARKER_FILE[kind]} found in ${dir}`);
		}
		return kind;
	}
	const found = KINDS.filter((k) => existsSync(join(dir, MARKER_FILE[k])));
	if (found.length === 0) {
		throw new CiError(
			`could not detect project kind in ${dir}: no package.json, go.mod, or Cargo.toml (or pass --kind ${KINDS.join("|")})`,
		);
	}
	if (found.length > 1) {
		throw new CiError(
			`ambiguous project kind in ${dir}: found ${found.map((k) => MARKER_FILE[k]).join(" and ")}; pass --kind ${KINDS.join("|")}`,
		);
	}
	const kind = found[0];
	if (kind === undefined) throw new CiError("unreachable: empty detection result");
	return kind;
}

function miseBlock(kind: Kind): string {
	const tasks: Record<Kind, string> = {
		node: `[tasks.check]
description = "Iterative checks (npm run validate)"
run = "npm run validate"

[tasks.ci]
description = "Full CI gate: fresh install, then npm run ci"
run = '''
npm ci
npm run ci
'''
`,
		go: `[tasks.check]
description = "Format verification, vet, and tests"
run = '''
test -z "$(gofmt -l .)"
go vet ./...
go test ./...
'''

[tasks.ci]
description = "check plus race detector and build"
depends = ["check"]
run = '''
go test -race ./...
go build ./...
'''
`,
		rust: `[tasks.check]
description = "fmt, check, and clippy with warnings denied"
run = '''
cargo fmt --check
cargo check
cargo clippy -- -D warnings
'''

[tasks.ci]
description = "check plus tests"
depends = ["check"]
run = "cargo test"
`,
	};
	return `${MISE_START}\n${tasks[kind]}${MISE_END}`;
}

function workflowContent(): string {
	return `${WORKFLOW_MARKER}
name: CI

on:
  push:
    branches: [main, master]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-\${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  ci:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: actions/checkout@v7

      - name: Setup toolchain
        uses: jdx/mise-action@v4

      - name: Run CI gate
        run: mise run ci
`;
}

function agentsBlock(): string {
	return `${AGENTS_START}
## Validation

CI contract for this repository (managed by pi-ci-standard — regenerate with \`pi-ci init\`):

- Run \`mise run check\` while iterating; fix all failures before continuing.
- Run \`mise run ci\` before declaring work complete; it must pass.
- GitHub Actions calls only \`mise run ci\`. Never add language-specific check commands to workflows.
${AGENTS_END}`;
}

interface ManagedRegion {
	before: string;
	block: string | null;
	after: string;
}

function splitManaged(content: string, start: string, end: string): ManagedRegion {
	const startIdx = content.indexOf(start);
	const endIdx = content.indexOf(end);
	if (startIdx === -1 && endIdx === -1) return { before: content, block: null, after: "" };
	if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
		throw new CiError(`malformed managed markers ("${start}" / "${end}"); fix or remove them manually`);
	}
	const blockEnd = endIdx + end.length;
	return {
		before: content.slice(0, startIdx),
		block: content.slice(startIdx, blockEnd),
		after: content.slice(blockEnd),
	};
}

interface Planned {
	path: string;
	action: "created" | "updated" | "unchanged";
	content: string | null; // desired content when action !== "unchanged"
}

function planned(path: string, action: Planned["action"], content: string | null): Planned {
	return { path, action, content };
}

function planMise(dir: string, kind: Kind): Planned {
	const path = join(dir, "mise.toml");
	const block = miseBlock(kind);
	if (!existsSync(path)) return planned(path, "created", `${block}\n`);
	const content = readFileSync(path, "utf8");
	const { before, block: existing, after } = splitManaged(content, MISE_START, MISE_END);
	const conflict = (before + after).match(MISE_CONFLICT);
	if (conflict) {
		throw new CiError(
			`mise.toml already defines ${conflict[0].trim()} outside the pi-ci-standard managed block; ` +
				"remove or rename that task, then re-run: pi-ci init",
		);
	}
	let next: string;
	if (existing !== null) {
		next = before + block + after;
	} else {
		const base = content.endsWith("\n") ? content : `${content}\n`;
		next = `${base}\n${block}\n`;
	}
	return next === content ? planned(path, "unchanged", null) : planned(path, "updated", next);
}

function planWorkflow(dir: string): Planned {
	const path = join(dir, ".github", "workflows", "ci.yml");
	const desired = workflowContent();
	if (!existsSync(path)) return planned(path, "created", desired);
	const content = readFileSync(path, "utf8");
	if (!content.startsWith(WORKFLOW_MARKER)) {
		throw new CiError(
			".github/workflows/ci.yml exists and is not managed by pi-ci-standard; rename it or merge manually, refusing to overwrite",
		);
	}
	return content === desired ? planned(path, "unchanged", null) : planned(path, "updated", desired);
}

function planAgents(dir: string): Planned {
	const path = join(dir, "AGENTS.md");
	const block = agentsBlock();
	if (!existsSync(path)) return planned(path, "created", `${block}\n`);
	const content = readFileSync(path, "utf8");
	const { before, block: existing, after } = splitManaged(content, AGENTS_START, AGENTS_END);
	let next: string;
	if (existing !== null) {
		next = before + block + after;
	} else {
		const base = content.endsWith("\n") ? content : `${content}\n`;
		next = `${base}\n${block}\n`;
	}
	return next === content ? planned(path, "unchanged", null) : planned(path, "updated", next);
}

function missingNodeScripts(dir: string): string[] {
	const pkgPath = join(dir, "package.json");
	let pkg: { scripts?: Record<string, string> };
	try {
		pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
	} catch (err) {
		throw new CiError(`cannot read package.json: ${err instanceof Error ? err.message : String(err)}`);
	}
	const scripts = pkg.scripts ?? {};
	return ["validate", "ci"].filter((name) => typeof scripts[name] !== "string");
}

function assertNodeScripts(dir: string): void {
	const missing = missingNodeScripts(dir);
	if (missing.length > 0) {
		throw new CiError(
			`package.json missing required scripts: ${missing.join(", ")}; ` +
				"pi-ci-standard reuses existing scripts and does not invent project-specific ones — add them, then re-run: pi-ci init",
		);
	}
}

interface Finding {
	ok: boolean;
	label: string;
	detail?: string;
}

function fail(label: string, detail: string): Finding {
	return { ok: false, label, detail };
}

const OK_MISE = "mise.toml";
const OK_WORKFLOW = "workflow";
const OK_AGENTS = "AGENTS.md";

function auditMise(dir: string, kind: Kind): Finding[] {
	const path = join(dir, "mise.toml");
	if (!existsSync(path)) return [fail(OK_MISE, "missing (run: pi-ci init)")];
	const content = readFileSync(path, "utf8");
	const { before, block, after } = splitManaged(content, MISE_START, MISE_END);
	const findings: Finding[] = [];
	if (block === null) findings.push(fail(OK_MISE, "no pi-ci-standard managed block (run: pi-ci init)"));
	else if (block !== miseBlock(kind)) findings.push(fail(OK_MISE, "managed block drifted (run: pi-ci init)"));
	else findings.push({ ok: true, label: OK_MISE });
	const conflict = (before + after).match(MISE_CONFLICT);
	if (conflict) {
		findings.push(fail(OK_MISE, `unmanaged ${conflict[0].trim()} present outside managed block`));
	}
	return findings;
}

function auditWorkflow(dir: string): Finding {
	const path = join(dir, ".github", "workflows", "ci.yml");
	const desired = workflowContent();
	if (!existsSync(path)) return fail(OK_WORKFLOW, ".github/workflows/ci.yml missing (run: pi-ci init)");
	const content = readFileSync(path, "utf8");
	if (!content.startsWith(WORKFLOW_MARKER)) return fail(OK_WORKFLOW, "ci.yml not managed by pi-ci-standard");
	if (content !== desired) return fail(OK_WORKFLOW, "drifted (run: pi-ci init)");
	return { ok: true, label: OK_WORKFLOW };
}

function auditAgents(dir: string): Finding {
	const path = join(dir, "AGENTS.md");
	if (!existsSync(path)) return fail(OK_AGENTS, "missing (run: pi-ci init)");
	const content = readFileSync(path, "utf8");
	const { block } = splitManaged(content, AGENTS_START, AGENTS_END);
	if (block === null) return fail(OK_AGENTS, "no managed Validation block (run: pi-ci init)");
	if (block !== agentsBlock()) return fail(OK_AGENTS, "managed block drifted (run: pi-ci init)");
	return { ok: true, label: OK_AGENTS };
}

function auditProject(dir: string, kind: Kind): Finding[] {
	const findings: Finding[] = [];
	if (kind === "node") {
		const missing = missingNodeScripts(dir);
		findings.push(
			missing.length > 0
				? fail("package.json", `missing required scripts: ${missing.join(", ")}`)
				: { ok: true, label: "package.json" },
		);
	}
	findings.push(...auditMise(dir, kind));
	findings.push(auditWorkflow(dir));
	findings.push(auditAgents(dir));
	return findings;
}

interface ParsedArgs {
	sub: string;
	dir: string;
	kind?: string;
}

const USAGE = "usage: pi-ci init|audit|status [dir] [--kind node|go|rust]";

function parseArgs(argv: string[], cwd: string): ParsedArgs {
	const [sub, ...rest] = argv;
	if (sub !== "init" && sub !== "audit" && sub !== "status") {
		throw new CiError(sub === undefined ? USAGE : `unknown subcommand "${sub}"\n${USAGE}`);
	}
	let dir: string | undefined;
	let kind: string | undefined;
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === undefined) continue;
		if (arg === "--kind") {
			kind = rest[i + 1];
			if (kind === undefined) throw new CiError("--kind requires a value");
			i++;
		} else if (arg.startsWith("--kind=")) {
			kind = arg.slice("--kind=".length);
		} else if (arg.startsWith("-")) {
			throw new CiError(`unknown flag: ${arg}\n${USAGE}`);
		} else if (dir === undefined) {
			dir = arg;
		} else {
			throw new CiError(`unexpected argument: ${arg}\n${USAGE}`);
		}
	}
	const resolved = resolve(cwd, dir ?? ".");
	if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
		throw new CiError(`not a directory: ${resolved}`);
	}
	const parsed: ParsedArgs = { sub, dir: resolved };
	if (kind !== undefined) parsed.kind = kind;
	return parsed;
}

function dispatch(parsed: ParsedArgs): RunResult {
	const kind = detectKind(parsed.dir, parsed.kind);
	if (parsed.sub === "init") {
		if (kind === "node") assertNodeScripts(parsed.dir);
		const plans = [planMise(parsed.dir, kind), planWorkflow(parsed.dir), planAgents(parsed.dir)];
		for (const plan of plans) {
			if (plan.content === null) continue;
			mkdirSync(dirname(plan.path), { recursive: true });
			writeFileSync(plan.path, plan.content);
		}
		const lines = plans.map((p) => `${p.action}: ${p.path}`);
		const allSame = plans.every((p) => p.action === "unchanged");
		lines.push(allSame ? `no changes (kind: ${kind})` : `init complete (kind: ${kind}); next: mise run check`);
		return { code: 0, output: lines.join("\n") };
	}
	const findings = auditProject(parsed.dir, kind);
	if (parsed.sub === "audit") {
		const lines = findings.map((f) => (f.ok ? `ok ${f.label}` : `FAIL ${f.label}: ${f.detail ?? ""}`));
		const failed = findings.filter((f) => !f.ok).length;
		lines.push(failed === 0 ? `audit passed (kind: ${kind})` : `audit failed: ${failed} finding(s) (kind: ${kind})`);
		return { code: failed === 0 ? 0 : 1, output: lines.join("\n") };
	}
	const lines = [`kind: ${kind}`];
	for (const f of findings) lines.push(`${f.label}: ${f.ok ? "ok" : (f.detail ?? "fail")}`);
	return { code: 0, output: lines.join("\n") };
}

export function run(argv: string[], cwd: string): RunResult {
	try {
		return dispatch(parseArgs(argv, cwd));
	} catch (err) {
		if (err instanceof CiError) return { code: 1, output: `error: ${err.message}` };
		throw err;
	}
}
