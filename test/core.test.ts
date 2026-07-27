import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../src/core.ts";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

const dirs: string[] = [];

function fixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-ci-test-"));
	dirs.push(dir);
	return dir;
}

function nodePkg(dir: string, scripts: Record<string, string> = { validate: "tsc", ci: "tsc && node --test" }): void {
	writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "fixture", scripts }, null, 2)}\n`);
}

after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("detection", () => {
	it("detects node, go, rust from marker files", () => {
		for (const [kind, marker] of [
			["node", "package.json"],
			["go", "go.mod"],
			["rust", "Cargo.toml"],
		] as const) {
			const dir = fixture();
			if (kind === "node") nodePkg(dir);
			else writeFileSync(join(dir, marker), "");
			const result = run(["status"], dir);
			assert.equal(result.code, 0, result.output);
			assert.match(result.output, new RegExp(`^kind: ${kind}$`, "m"));
		}
	});

	it("fails clearly when no marker exists", () => {
		const result = run(["status"], fixture());
		assert.equal(result.code, 1);
		assert.match(result.output, /could not detect project kind/);
	});

	it("fails clearly on ambiguous markers", () => {
		const dir = fixture();
		nodePkg(dir);
		writeFileSync(join(dir, "go.mod"), "");
		const result = run(["status"], dir);
		assert.equal(result.code, 1);
		assert.match(result.output, /ambiguous project kind/);
	});

	it("honors explicit --kind and validates its marker", () => {
		const dir = fixture();
		nodePkg(dir);
		writeFileSync(join(dir, "go.mod"), "");
		const resolved = run(["status", "--kind", "go"], dir);
		assert.equal(resolved.code, 0, resolved.output);
		assert.match(resolved.output, /^kind: go$/m);

		const empty = fixture();
		const bad = run(["status", "--kind=rust"], empty);
		assert.equal(bad.code, 1);
		assert.match(bad.output, /--kind rust: no Cargo\.toml/);

		const unknown = run(["status", "--kind", "python"], dir);
		assert.equal(unknown.code, 1);
		assert.match(unknown.output, /unknown kind "python"/);
	});

	it("rejects unknown subcommands and flags with usage", () => {
		assert.match(run([], fixture()).output, /usage: pi-ci/);
		assert.match(run(["run"], fixture()).output, /unknown subcommand "run"/);
		assert.match(run(["status", "--force"], fixture()).output, /unknown flag: --force/);
	});
});

describe("init generation", () => {
	it("fails for node without validate/ci scripts and writes nothing", () => {
		const dir = fixture();
		nodePkg(dir, { build: "tsc" });
		const result = run(["init"], dir);
		assert.equal(result.code, 1);
		assert.match(result.output, /missing required scripts: validate, ci/);
		assert.equal(existsSync(join(dir, "mise.toml")), false);
	});

	it("generates mise tasks, workflow, and AGENTS block for node", () => {
		const dir = fixture();
		nodePkg(dir);
		const result = run(["init"], dir);
		assert.equal(result.code, 0, result.output);

		const mise = readFileSync(join(dir, "mise.toml"), "utf8");
		assert.match(mise, /\[tasks\.check\]/);
		assert.match(mise, /run = "npm run validate"/);
		assert.match(mise, /npm ci\nnpm run ci/);
		assert.match(mise, /pi-ci-standard managed/);

		const workflow = readFileSync(join(dir, ".github", "workflows", "ci.yml"), "utf8");
		assert.ok(workflow.startsWith("# Managed by pi-ci-standard"));
		assert.match(workflow, /run: mise run ci/);
		assert.ok(!workflow.includes("npm"), "workflow must contain no language command");

		const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
		assert.match(agents, /pi-ci-standard:validation:start/);
		assert.match(agents, /mise run check/);
		assert.match(agents, /mise run ci/);
	});

	it("generates stdlib-only go tasks", () => {
		const dir = fixture();
		writeFileSync(join(dir, "go.mod"), "module example.com/x\n");
		const result = run(["init"], dir);
		assert.equal(result.code, 0, result.output);
		const mise = readFileSync(join(dir, "mise.toml"), "utf8");
		for (const expected of [
			'test -z "$(gofmt -l .)"',
			"go vet ./...",
			"go test ./...",
			"go test -race ./...",
			"go build ./...",
		]) {
			assert.ok(mise.includes(expected), `missing: ${expected}`);
		}
		const workflow = readFileSync(join(dir, ".github", "workflows", "ci.yml"), "utf8");
		assert.ok(!workflow.includes("npm ci"));
	});

	it("generates rust tasks with warnings denied", () => {
		const dir = fixture();
		writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "x"\n');
		const result = run(["init"], dir);
		assert.equal(result.code, 0, result.output);
		const mise = readFileSync(join(dir, "mise.toml"), "utf8");
		for (const expected of ["cargo fmt --check", "cargo check", "cargo clippy -- -D warnings", "cargo test"]) {
			assert.ok(mise.includes(expected), `missing: ${expected}`);
		}
	});

	it("is idempotent: second init produces no changes", () => {
		const dir = fixture();
		nodePkg(dir);
		assert.equal(run(["init"], dir).code, 0);
		const before = ["mise.toml", join(".github", "workflows", "ci.yml"), "AGENTS.md"].map((p) =>
			readFileSync(join(dir, p), "utf8"),
		);
		const second = run(["init"], dir);
		assert.equal(second.code, 0, second.output);
		assert.match(second.output, /no changes \(kind: node\)/);
		const after = ["mise.toml", join(".github", "workflows", "ci.yml"), "AGENTS.md"].map((p) =>
			readFileSync(join(dir, p), "utf8"),
		);
		assert.deepEqual(after, before);
	});

	it("preserves existing mise tools config and AGENTS text", () => {
		const dir = fixture();
		nodePkg(dir);
		writeFileSync(join(dir, "mise.toml"), '[tools]\nnode = "24.18.0"\n');
		writeFileSync(join(dir, "AGENTS.md"), "# My project\n\nCustom notes.\n");
		const result = run(["init"], dir);
		assert.equal(result.code, 0, result.output);
		const mise = readFileSync(join(dir, "mise.toml"), "utf8");
		assert.ok(mise.startsWith('[tools]\nnode = "24.18.0"'));
		const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
		assert.ok(agents.startsWith("# My project\n\nCustom notes.\n"));
	});
});

describe("conflict refusal", () => {
	it("refuses to overwrite unmanaged tasks.check in mise.toml", () => {
		const dir = fixture();
		nodePkg(dir);
		const original = '[tasks.check]\nrun = "make check"\n';
		writeFileSync(join(dir, "mise.toml"), original);
		const result = run(["init"], dir);
		assert.equal(result.code, 1);
		assert.match(result.output, /already defines \[tasks\.check\]/);
		assert.equal(readFileSync(join(dir, "mise.toml"), "utf8"), original);
	});

	it("refuses to overwrite an unmanaged workflow", () => {
		const dir = fixture();
		nodePkg(dir);
		mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
		writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "name: custom\n");
		const result = run(["init"], dir);
		assert.equal(result.code, 1);
		assert.match(result.output, /not managed by pi-ci-standard/);
		assert.equal(readFileSync(join(dir, ".github", "workflows", "ci.yml"), "utf8"), "name: custom\n");
	});

	it("fails on malformed managed markers", () => {
		const dir = fixture();
		nodePkg(dir);
		writeFileSync(join(dir, "mise.toml"), "# >>> pi-ci-standard managed — regenerate with: pi-ci init >>>\n");
		const result = run(["init"], dir);
		assert.equal(result.code, 1);
		assert.match(result.output, /malformed managed markers/);
	});

	it("is mutation-free when any artifact conflicts", () => {
		const dir = fixture();
		nodePkg(dir);
		const miseOriginal = '[tools]\nnode = "24.18.0"\n';
		writeFileSync(join(dir, "mise.toml"), miseOriginal);
		mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
		const workflowOriginal = "name: custom\n";
		writeFileSync(join(dir, ".github", "workflows", "ci.yml"), workflowOriginal);
		const result = run(["init"], dir);
		assert.equal(result.code, 1);
		assert.match(result.output, /not managed by pi-ci-standard/);
		assert.equal(readFileSync(join(dir, "mise.toml"), "utf8"), miseOriginal);
		assert.equal(readFileSync(join(dir, ".github", "workflows", "ci.yml"), "utf8"), workflowOriginal);
		assert.equal(existsSync(join(dir, "AGENTS.md")), false);
	});

	it("reports malformed package.json as a concise error, not a stack trace", () => {
		const dir = fixture();
		writeFileSync(join(dir, "package.json"), "{ not json");
		for (const sub of ["init", "audit", "status"]) {
			const result = run([sub], dir);
			assert.equal(result.code, 1, `${sub} should fail`);
			assert.match(result.output, /cannot read package\.json/);
			assert.ok(!result.output.includes("    at "), `${sub} leaked a stack trace`);
		}
	});
});

describe("audit and status", () => {
	it("audit passes right after init", () => {
		const dir = fixture();
		nodePkg(dir);
		assert.equal(run(["init"], dir).code, 0);
		const audit = run(["audit"], dir);
		assert.equal(audit.code, 0, audit.output);
		assert.match(audit.output, /audit passed \(kind: node\)/);
	});

	it("audit fails with nonzero exit when pieces are missing", () => {
		const dir = fixture();
		nodePkg(dir);
		const audit = run(["audit"], dir);
		assert.equal(audit.code, 1);
		assert.match(audit.output, /FAIL mise\.toml: missing/);
		assert.match(audit.output, /FAIL workflow: .*missing/);
		assert.match(audit.output, /FAIL AGENTS\.md: missing/);
	});

	it("audit detects drift in managed sections", () => {
		const dir = fixture();
		nodePkg(dir);
		assert.equal(run(["init"], dir).code, 0);
		const misePath = join(dir, "mise.toml");
		writeFileSync(misePath, readFileSync(misePath, "utf8").replace("npm run validate", "npm run whatever"));
		const audit = run(["audit"], dir);
		assert.equal(audit.code, 1);
		assert.match(audit.output, /FAIL mise\.toml: managed block drifted/);
	});

	it("audit fails when node scripts disappear", () => {
		const dir = fixture();
		nodePkg(dir);
		assert.equal(run(["init"], dir).code, 0);
		nodePkg(dir, { validate: "tsc" });
		const audit = run(["audit"], dir);
		assert.equal(audit.code, 1);
		assert.match(audit.output, /FAIL package\.json: missing required scripts: ci/);
	});

	it("status stays read-only with exit 0 on a broken project", () => {
		const dir = fixture();
		nodePkg(dir);
		const status = run(["status"], dir);
		assert.equal(status.code, 0, status.output);
		assert.match(status.output, /^kind: node$/m);
		assert.match(status.output, /^mise\.toml: missing/m);
	});
});

describe("cli bin", () => {
	it("runs through node with argument arrays and reports exit codes", () => {
		const dir = fixture();
		nodePkg(dir);
		const ok = spawnSync(process.execPath, [cliPath, "init", dir], { encoding: "utf8" });
		assert.equal(ok.status, 0, ok.stderr);
		assert.match(ok.stdout, /init complete \(kind: node\)/);

		const bad = spawnSync(process.execPath, [cliPath, "audit", join(dir, "does-not-exist")], { encoding: "utf8" });
		assert.equal(bad.status, 1);
		assert.match(bad.stderr, /not a directory/);
	});
});
