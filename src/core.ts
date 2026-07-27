import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type Kind = "node" | "go" | "rust";
export const KINDS = ["node", "go", "rust"] as const;

export class CiError extends Error {}

// ponytail: quote-aware whitespace tokenizer; no escape sequences inside quotes.
export function tokenize(input: string): string[] {
	const tokens: string[] = [];
	const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
	for (const match of input.matchAll(pattern)) {
		tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
	}
	return tokens;
}

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

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

interface PlatformConfig {
	command: string;
	runners: string[];
}

interface ProjectConfig {
	check?: string;
	ci?: string;
	platform?: PlatformConfig;
}

function ownKeys(value: object, allowed: string[], label: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) throw new CiError(`${label}: unknown field(s): ${unknown.join(", ")}`);
}

function configCommand(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") throw new CiError(`${label} must be a non-empty string`);
	return value.trim();
}

function loadConfig(dir: string, kind: Kind): ProjectConfig {
	const path = join(dir, ".pi-ci.json");
	if (!existsSync(path)) return {};
	if (!isFile(path)) throw new CiError(".pi-ci.json is not a regular file");
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new CiError(`cannot read .pi-ci.json: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new CiError(".pi-ci.json must contain an object");
	}
	ownKeys(value, ["check", "ci", "platform"], ".pi-ci.json");
	if (kind === "node" && ("check" in value || "ci" in value)) {
		throw new CiError(".pi-ci.json check/ci overrides are unavailable for node; use package.json validate/ci scripts");
	}
	const config: ProjectConfig = {};
	const check = configCommand(Reflect.get(value, "check"), ".pi-ci.json check");
	const ci = configCommand(Reflect.get(value, "ci"), ".pi-ci.json ci");
	if (check !== undefined) config.check = check;
	if (ci !== undefined) config.ci = ci;
	const platform = Reflect.get(value, "platform");
	if (platform === undefined) return config;
	if (typeof platform !== "object" || platform === null || Array.isArray(platform)) {
		throw new CiError(".pi-ci.json platform must contain an object");
	}
	ownKeys(platform, ["command", "runners"], ".pi-ci.json platform");
	const platformCommand = configCommand(Reflect.get(platform, "command"), ".pi-ci.json platform.command");
	const runners = Reflect.get(platform, "runners");
	if (platformCommand === undefined || !Array.isArray(runners) || runners.length === 0) {
		throw new CiError(".pi-ci.json platform requires command and at least one runner");
	}
	if (!runners.every((runner) => typeof runner === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runner))) {
		throw new CiError(".pi-ci.json platform.runners contains an invalid runner label");
	}
	if (new Set(runners).size !== runners.length) throw new CiError(".pi-ci.json platform.runners contains duplicates");
	config.platform = { command: platformCommand, runners } as PlatformConfig;
	return config;
}

export function detectKind(dir: string, explicit?: string): Kind {
	if (explicit !== undefined) {
		if (!KINDS.includes(explicit as Kind)) {
			throw new CiError(`unknown kind "${explicit}" (expected: ${KINDS.join("|")})`);
		}
		const kind = explicit as Kind;
		if (!isFile(join(dir, MARKER_FILE[kind]))) {
			throw new CiError(`--kind ${kind}: no ${MARKER_FILE[kind]} found in ${dir}`);
		}
		return kind;
	}
	const found = KINDS.filter((k) => isFile(join(dir, MARKER_FILE[k])));
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

function task(description: string, run: string): string {
	return `description = ${JSON.stringify(description)}\nrun = ${JSON.stringify(run)}\n`;
}

function miseBlock(kind: Kind, config: ProjectConfig): string {
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
	let content = tasks[kind];
	if (config.check !== undefined) {
		const ciStart = content.indexOf("\n[tasks.ci]");
		content = `[tasks.check]\n${task("Project check command", config.check)}${content.slice(ciStart)}`;
	}
	if (config.ci !== undefined) {
		const ciStart = content.indexOf("[tasks.ci]");
		content = `${content.slice(0, ciStart)}[tasks.ci]\n${task("Project full CI command", config.ci)}`;
	}
	if (config.platform !== undefined) {
		content += `\n[tasks.platform-check]\n${task("Platform-specific checks", config.platform.command)}`;
	}
	return `${MISE_START}\n${content}${MISE_END}`;
}

function workflowContent(config: ProjectConfig): string {
	const platform =
		config.platform === undefined
			? ""
			: `

  platform:
    strategy:
      fail-fast: false
      matrix:
        runner: [${config.platform.runners.map((runner) => JSON.stringify(runner)).join(", ")}]
    runs-on: \${{ matrix.runner }}
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: actions/checkout@v7

      - name: Setup toolchain
        uses: jdx/mise-action@v4

      - name: Run platform checks
        run: mise run platform-check
`;
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
${platform}`;
}

function agentsBlock(): string {
	return `${AGENTS_START}
## Validation

CI contract for this repository (managed by pi-ci-standard — regenerate with \`pi-ci init\`):

- Run \`mise run check\` while iterating; fix all failures before continuing.
- Run \`mise run ci\` before declaring work complete; it must pass.
- GitHub Actions runs project checks only through managed mise tasks. Never add language-specific check commands to workflows.
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

function planMise(dir: string, kind: Kind, config: ProjectConfig): Planned {
	const path = join(dir, "mise.toml");
	const block = miseBlock(kind, config);
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

function planWorkflow(dir: string, config: ProjectConfig): Planned {
	const path = join(dir, ".github", "workflows", "ci.yml");
	const desired = workflowContent(config);
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

interface PackageJson {
	scripts?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

function loadPackage(dir: string): PackageJson {
	const path = join(dir, "package.json");
	if (!isFile(path)) throw new CiError("cannot read package.json: not a regular file");
	try {
		return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
	} catch (err) {
		throw new CiError(`cannot read package.json: ${err instanceof Error ? err.message : String(err)}`);
	}
}

interface Prereq {
	label: string;
	ok: boolean;
	detail: string; // value on success, problems on failure
	problems: string[];
}

function prereqOk(label: string, detail: string): Prereq {
	return { label, ok: true, detail, problems: [] };
}

function prereqFail(label: string, problems: string[]): Prereq {
	return { label, ok: false, detail: problems.join("; "), problems };
}

// ponytail: minimal line parser for a plain [tools] table with one-line quoted
// assignments (node = "24.18.0"). Inline tables, multi-line arrays, and
// biome.jsonc-style variants are unsupported by design; no TOML dependency.
function toolPin(miseContent: string | null, tool: string): string | null {
	if (miseContent === null) return null;
	let inTools = false;
	for (const line of miseContent.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("[")) {
			inTools = trimmed === "[tools]";
			continue;
		}
		if (!inTools) continue;
		const match = trimmed.match(/^([A-Za-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/);
		const key = match?.[1];
		if (match && key === tool) {
			const value = (match[2] ?? match[3] ?? "").trim();
			return value === "" ? null : value;
		}
	}
	return null;
}

function scriptProblems(scripts: Record<string, string>): string[] {
	const problems: string[] = [];
	for (const name of ["quality", "validate", "ci"]) {
		const value = scripts[name];
		if (typeof value !== "string" || value.trim() === "") problems.push(`missing or empty script: ${name}`);
	}
	const quality = (scripts.quality ?? "").trim();
	if (quality !== "" && quality !== "biome ci .") {
		problems.push('script quality must be exactly "biome ci ."');
	}
	const validate = (scripts.validate ?? "").trim();
	if (validate !== "") {
		if (!validate.includes("npm run quality")) problems.push('script validate must invoke "npm run quality"');
		if (validate.includes("mise run check"))
			problems.push('script validate must not invoke "mise run check" (recursion)');
	}
	const ci = (scripts.ci ?? "").trim();
	if (ci !== "") {
		if (!ci.includes("npm run quality") && !ci.includes("npm run validate")) {
			problems.push('script ci must invoke "npm run quality" or "npm run validate"');
		}
		if (ci.includes("mise run ci")) problems.push('script ci must not invoke "mise run ci" (recursion)');
	}
	return problems;
}

function biomeProblems(dir: string, pkg: PackageJson): string[] {
	const problems: string[] = [];
	const version = pkg.devDependencies?.["@biomejs/biome"];
	if (typeof version !== "string" || version.trim() === "") {
		problems.push("devDependencies must contain a non-empty @biomejs/biome version");
	}
	if (!isFile(join(dir, "biome.json"))) {
		problems.push("missing biome.json (biome.jsonc is not supported)");
	}
	return problems;
}

function prerequisites(dir: string, kind: Kind): Prereq[] {
	const items: Prereq[] = [];
	const misePath = join(dir, "mise.toml");
	const pin = toolPin(isFile(misePath) ? readFileSync(misePath, "utf8") : null, kind);
	items.push(
		pin === null
			? {
					label: `pin ${kind}`,
					ok: false,
					detail: "missing",
					problems: [
						`mise.toml needs a non-empty [tools] pin (add: ${kind} = "<version>"); pi-ci never chooses versions`,
					],
				}
			: prereqOk(`pin ${kind}`, pin),
	);
	if (kind !== "node") return items;
	if (!isFile(join(dir, "package-lock.json"))) {
		items.push({
			label: "lockfile",
			ok: false,
			detail: "missing",
			problems: ["missing package-lock.json (generated ci task runs npm ci)"],
		});
	} else {
		items.push(prereqOk("lockfile", "ok"));
	}
	const pkg = loadPackage(dir);
	const scripts = scriptProblems(pkg.scripts ?? {});
	items.push(scripts.length > 0 ? prereqFail("scripts", scripts) : prereqOk("scripts", "ok"));
	const biome = biomeProblems(dir, pkg);
	items.push(
		biome.length > 0 ? prereqFail("biome", biome) : prereqOk("biome", pkg.devDependencies?.["@biomejs/biome"] ?? "ok"),
	);
	return items;
}

function assertPrerequisites(dir: string, kind: Kind): void {
	const problems = prerequisites(dir, kind).flatMap((p) => p.problems);
	if (problems.length > 0) {
		throw new CiError(`prerequisites not met:\n${problems.map((p) => `- ${p}`).join("\n")}`);
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

function pass(label: string, detail?: string): Finding {
	return detail === undefined || detail === "ok" ? { ok: true, label } : { ok: true, label, detail };
}

const OK_MISE = "mise.toml";
const OK_WORKFLOW = "workflow";
const OK_AGENTS = "AGENTS.md";

function auditMise(dir: string, kind: Kind, config: ProjectConfig): Finding[] {
	const path = join(dir, "mise.toml");
	if (!isFile(path)) return [fail(OK_MISE, "missing (run: pi-ci init)")];
	const content = readFileSync(path, "utf8");
	const { before, block, after } = splitManaged(content, MISE_START, MISE_END);
	const findings: Finding[] = [];
	if (block === null) findings.push(fail(OK_MISE, "no pi-ci-standard managed block (run: pi-ci init)"));
	else if (block !== miseBlock(kind, config)) findings.push(fail(OK_MISE, "managed block drifted (run: pi-ci init)"));
	else findings.push(pass(OK_MISE));
	const conflict = (before + after).match(MISE_CONFLICT);
	if (conflict) {
		findings.push(fail(OK_MISE, `unmanaged ${conflict[0].trim()} present outside managed block`));
	}
	return findings;
}

function auditWorkflow(dir: string, config: ProjectConfig): Finding {
	const path = join(dir, ".github", "workflows", "ci.yml");
	const desired = workflowContent(config);
	if (!existsSync(path)) return fail(OK_WORKFLOW, ".github/workflows/ci.yml missing (run: pi-ci init)");
	const content = readFileSync(path, "utf8");
	if (!content.startsWith(WORKFLOW_MARKER)) return fail(OK_WORKFLOW, "ci.yml not managed by pi-ci-standard");
	if (content !== desired) return fail(OK_WORKFLOW, "drifted (run: pi-ci init)");
	const runners = ["ubuntu-latest", ...(config.platform?.runners ?? [])];
	return pass(OK_WORKFLOW, runners.join(", "));
}

function auditAgents(dir: string): Finding {
	const path = join(dir, "AGENTS.md");
	if (!existsSync(path)) return fail(OK_AGENTS, "missing (run: pi-ci init)");
	const content = readFileSync(path, "utf8");
	const { block } = splitManaged(content, AGENTS_START, AGENTS_END);
	if (block === null) return fail(OK_AGENTS, "no managed Validation block (run: pi-ci init)");
	if (block !== agentsBlock()) return fail(OK_AGENTS, "managed block drifted (run: pi-ci init)");
	return pass(OK_AGENTS);
}

function auditProject(dir: string, kind: Kind): Finding[] {
	const config = loadConfig(dir, kind);
	const findings: Finding[] = prerequisites(dir, kind).map((p) =>
		p.ok ? pass(p.label, p.detail) : fail(p.label, p.problems.join("; ")),
	);
	findings.push(
		pass(
			"project commands",
			kind === "node"
				? "package.json validate/ci"
				: `check=${config.check === undefined ? "default" : "custom"}, ci=${config.ci === undefined ? "default" : "custom"}`,
		),
	);
	findings.push(pass("platform runners", config.platform?.runners.join(", ") ?? "none"));
	if (config.platform !== undefined) {
		const matches =
			config.platform.command === config.ci ? "ci" : config.platform.command === config.check ? "check" : null;
		findings.push(
			pass("platform command", matches === null ? "distinct" : `matches ${matches}; review duplicate execution`),
		);
	}
	findings.push(...auditMise(dir, kind, config));
	findings.push(auditWorkflow(dir, config));
	findings.push(auditAgents(dir));
	return findings;
}

interface ParsedArgs {
	sub: string;
	dir: string;
	kind?: string;
}

const USAGE = "usage: pi-ci init|audit [dir] [--kind node|go|rust]";
const HELP = `pi-ci-standard manages and audits repository CI configuration.

${USAGE}

commands:
  init    Generate or update managed CI configuration
  audit   Show details and audit configuration; does not run project checks

options:
  --kind node|go|rust  Override project-kind detection
  -h, --help           Show this help

configuration:
  .pi-ci.json  Optional Go/Rust commands and focused platform runners

validation:
  mise run check  Run iterative project checks
  mise run ci     Run full CI gate`;

function parseArgs(argv: string[], cwd: string): ParsedArgs {
	const [sub, ...rest] = argv;
	if (sub !== "init" && sub !== "audit") {
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
		assertPrerequisites(parsed.dir, kind);
		const config = loadConfig(parsed.dir, kind);
		const plans = [planMise(parsed.dir, kind, config), planWorkflow(parsed.dir, config), planAgents(parsed.dir)];
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
	const lines = findings.map((f) => {
		const detail = f.detail === undefined ? "" : `: ${f.detail}`;
		return f.ok ? `ok ${f.label}${detail}` : `FAIL ${f.label}${detail}`;
	});
	const failed = findings.filter((f) => !f.ok).length;
	lines.push(
		failed === 0
			? `audit passed: configuration only (kind: ${kind}); next: mise run check`
			: `audit failed: ${failed} finding(s) (kind: ${kind})`,
	);
	return { code: failed === 0 ? 0 : 1, output: lines.join("\n") };
}

export function run(argv: string[], cwd: string): RunResult {
	if (argv[0] === "help" || argv.includes("--help") || argv.includes("-h")) return { code: 0, output: HELP };
	try {
		return dispatch(parseArgs(argv, cwd));
	} catch (err) {
		if (err instanceof CiError) return { code: 1, output: `error: ${err.message}` };
		throw err;
	}
}
