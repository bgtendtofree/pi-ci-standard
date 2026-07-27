import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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

const NODE_SCRIPTS = {
	quality: "biome ci .",
	validate: "npm run quality && npm run typecheck && npm test",
	ci: "npm run validate && npm run smoke",
};

function nodePkg(dir: string, scripts: Record<string, string> = NODE_SCRIPTS): void {
	writeFileSync(
		join(dir, "package.json"),
		`${JSON.stringify({ name: "fixture", scripts, devDependencies: { "@biomejs/biome": "2.5.4" } }, null, "\t")}\n`,
	);
	writeFileSync(join(dir, "package-lock.json"), "{}\n");
	writeFileSync(join(dir, "biome.json"), "{}\n");
	writeFileSync(join(dir, "mise.toml"), '[tools]\nnode = "24.18.0"\n');
}

function goFixture(dir: string): void {
	writeFileSync(join(dir, "go.mod"), "module example.com/x\n");
	writeFileSync(join(dir, "mise.toml"), '[tools]\ngo = "1.26.5"\n');
}

function rustFixture(dir: string): void {
	writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "x"\n');
	writeFileSync(join(dir, "mise.toml"), '[tools]\nrust = "1.97.1"\n');
}

after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("detection", () => {
	it("detects node, go, rust from marker files", () => {
		const dir = fixture();
		nodePkg(dir);
		const result = run(["status"], dir);
		assert.equal(result.code, 0, result.output);
		assert.match(result.output, /^kind: node$/m);

		for (const [kind, marker] of [
			["go", "go.mod"],
			["rust", "Cargo.toml"],
		] as const) {
			const plain = fixture();
			writeFileSync(join(plain, marker), "");
			const plainResult = run(["status"], plain);
			assert.equal(plainResult.code, 0, plainResult.output);
			assert.match(plainResult.output, new RegExp(`^kind: ${kind}$`, "m"));
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

describe("prerequisites", () => {
	it("requires a [tools] pin for every kind and never writes one", () => {
		for (const [kind, make] of [
			["go", goFixture],
			["rust", rustFixture],
		] as const) {
			const dir = fixture();
			make(dir);
			rmSync(join(dir, "mise.toml"));
			const result = run(["init"], dir);
			assert.equal(result.code, 1, result.output);
			assert.match(result.output, new RegExp(`non-empty \\[tools\\] pin \\(add: ${kind} = `));
			assert.equal(existsSync(join(dir, "mise.toml")), false, "must not create mise.toml");
			assert.equal(existsSync(join(dir, "AGENTS.md")), false);
			const status = run(["status"], dir);
			assert.equal(status.code, 0, status.output);
			assert.match(status.output, new RegExp(`^pin ${kind}: missing$`, "m"));
		}
	});

	it("rejects empty pin values and shows pinned value in status", () => {
		const dir = fixture();
		nodePkg(dir);
		writeFileSync(join(dir, "mise.toml"), '[tools]\nnode = "  "\n');
		const result = run(["init"], dir);
		assert.equal(result.code, 1);
		assert.match(result.output, /non-empty \[tools\] pin/);

		nodePkg(dir);
		const status = run(["status"], dir);
		assert.match(status.output, /^pin node: 24\.18\.0$/m);
	});

	it("accepts trailing comments but rejects trailing garbage in pins", () => {
		const dir = fixture();
		nodePkg(dir);
		writeFileSync(join(dir, "mise.toml"), '[tools]\nnode = "24.18.0" # lts line\n');
		const status = run(["status"], dir);
		assert.equal(status.code, 0, status.output);
		assert.match(status.output, /^pin node: 24\.18\.0$/m);

		writeFileSync(join(dir, "mise.toml"), '[tools]\nnode = "24.18.0" junk\n');
		const bad = run(["init"], dir);
		assert.equal(bad.code, 1);
		assert.match(bad.output, /non-empty \[tools\] pin/);
	});

	it("treats directories at prerequisite paths as missing, never raw stat errors", () => {
		const dir = fixture();
		nodePkg(dir);
		rmSync(join(dir, "package-lock.json"));
		mkdirSync(join(dir, "package-lock.json"));
		rmSync(join(dir, "biome.json"));
		mkdirSync(join(dir, "biome.json"));
		const result = run(["init"], dir);
		assert.equal(result.code, 1);
		assert.match(result.output, /missing package-lock\.json/);
		assert.match(result.output, /missing biome\.json/);

		const goDir = fixture();
		mkdirSync(join(goDir, "go.mod"));
		const detected = run(["status"], goDir);
		assert.equal(detected.code, 1);
		assert.match(detected.output, /could not detect project kind/);
		assert.ok(!detected.output.includes("EISDIR"));

		const pkgDir = fixture();
		mkdirSync(join(pkgDir, "package.json"));
		const pkgResult = run(["status"], pkgDir);
		assert.equal(pkgResult.code, 1);
		assert.match(pkgResult.output, /could not detect project kind/);
	});

	it("requires package-lock.json for node, mutation-free", () => {
		const dir = fixture();
		nodePkg(dir);
		unlinkSync(join(dir, "package-lock.json"));
		const miseBefore = readFileSync(join(dir, "mise.toml"), "utf8");
		const result = run(["init"], dir);
		assert.equal(result.code, 1);
		assert.match(result.output, /missing package-lock\.json/);
		assert.equal(readFileSync(join(dir, "mise.toml"), "utf8"), miseBefore);
		assert.equal(existsSync(join(dir, "AGENTS.md")), false);
		const audit = run(["audit"], dir);
		assert.equal(audit.code, 1);
		assert.match(audit.output, /^FAIL lockfile: missing package-lock\.json \(generated ci task runs npm ci\)$/m);
	});

	it("requires non-empty quality/validate/ci scripts", () => {
		const dir = fixture();
		nodePkg(dir, { quality: "biome ci .", validate: "  ", ci: "npm run validate" });
		const result = run(["init"], dir);
		assert.equal(result.code, 1);
		assert.match(result.output, /missing or empty script: validate/);
	});

	it("requires quality to normalize exactly to biome ci .", () => {
		const dir = fixture();
		nodePkg(dir, { ...NODE_SCRIPTS, quality: "biome check ." });
		const bad = run(["init"], dir);
		assert.equal(bad.code, 1);
		assert.match(bad.output, /script quality must be exactly "biome ci \."/);

		nodePkg(dir, { ...NODE_SCRIPTS, quality: "  biome ci .  " });
		const good = run(["init"], dir);
		assert.equal(good.code, 0, good.output);
	});

	it("requires validate to invoke npm run quality", () => {
		const dir = fixture();
		nodePkg(dir, { ...NODE_SCRIPTS, validate: "npm run typecheck" });
		const result = run(["init"], dir);
		assert.equal(result.code, 1);
		assert.match(result.output, /script validate must invoke "npm run quality"/);
	});

	it("requires ci to reach quality directly or via validate", () => {
		const dir = fixture();
		nodePkg(dir, { ...NODE_SCRIPTS, ci: "npm test" });
		const bad = run(["init"], dir);
		assert.equal(bad.code, 1);
		assert.match(bad.output, /script ci must invoke "npm run quality" or "npm run validate"/);

		nodePkg(dir, { ...NODE_SCRIPTS, ci: "npm run quality && npm test" });
		const direct = run(["init"], dir);
		assert.equal(direct.code, 0, direct.output);
	});

	it("rejects recursive mise task invocation", () => {
		const dir = fixture();
		nodePkg(dir, { ...NODE_SCRIPTS, validate: "npm run quality && mise run check" });
		const badValidate = run(["init"], dir);
		assert.equal(badValidate.code, 1);
		assert.match(badValidate.output, /must not invoke "mise run check"/);

		nodePkg(dir, { ...NODE_SCRIPTS, ci: "npm run validate && mise run ci" });
		const badCi = run(["init"], dir);
		assert.equal(badCi.code, 1);
		assert.match(badCi.output, /must not invoke "mise run ci"/);
	});

	it("requires @biomejs/biome devDependency and biome.json", () => {
		const dir = fixture();
		nodePkg(dir);
		writeFileSync(
			join(dir, "package.json"),
			`${JSON.stringify({ name: "fixture", scripts: NODE_SCRIPTS }, null, "\t")}\n`,
		);
		const noDep = run(["init"], dir);
		assert.equal(noDep.code, 1);
		assert.match(noDep.output, /non-empty @biomejs\/biome version/);

		nodePkg(dir);
		unlinkSync(join(dir, "biome.json"));
		const noConfig = run(["init"], dir);
		assert.equal(noConfig.code, 1);
		assert.match(noConfig.output, /missing biome\.json \(biome\.jsonc is not supported\)/);
	});
});

describe("init generation", () => {
	it("fails for node with missing scripts and writes nothing", () => {
		const dir = fixture();
		nodePkg(dir, { build: "tsc" });
		const result = run(["init"], dir);
		assert.equal(result.code, 1);
		assert.match(result.output, /missing or empty script: quality/);
		assert.match(result.output, /missing or empty script: validate/);
		assert.match(result.output, /missing or empty script: ci/);
		assert.equal(existsSync(join(dir, "AGENTS.md")), false);
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
		goFixture(dir);
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
	});

	it("generates rust tasks with warnings denied", () => {
		const dir = fixture();
		rustFixture(dir);
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
		const afterFiles = ["mise.toml", join(".github", "workflows", "ci.yml"), "AGENTS.md"].map((p) =>
			readFileSync(join(dir, p), "utf8"),
		);
		assert.deepEqual(afterFiles, before);
	});

	it("preserves existing AGENTS text", () => {
		const dir = fixture();
		nodePkg(dir);
		writeFileSync(join(dir, "AGENTS.md"), "# My project\n\nCustom notes.\n");
		const result = run(["init"], dir);
		assert.equal(result.code, 0, result.output);
		const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
		assert.ok(agents.startsWith("# My project\n\nCustom notes.\n"));
	});
});

describe("conflict refusal", () => {
	it("refuses to overwrite unmanaged tasks.check in mise.toml", () => {
		const dir = fixture();
		nodePkg(dir);
		const original = '[tools]\nnode = "24.18.0"\n\n[tasks.check]\nrun = "make check"\n';
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
		writeFileSync(
			join(dir, "mise.toml"),
			'[tools]\nnode = "24.18.0"\n# >>> pi-ci-standard managed — regenerate with: pi-ci init >>>\n',
		);
		const result = run(["init"], dir);
		assert.equal(result.code, 1);
		assert.match(result.output, /malformed managed markers/);
	});

	it("is mutation-free when any artifact conflicts", () => {
		const dir = fixture();
		nodePkg(dir);
		const miseOriginal = readFileSync(join(dir, "mise.toml"), "utf8");
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
		writeFileSync(join(dir, "mise.toml"), '[tools]\nnode = "24.18.0"\n');
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
		assert.match(audit.output, /FAIL mise\.toml: no pi-ci-standard managed block/);
		assert.match(audit.output, /FAIL workflow: .*missing/);
		assert.match(audit.output, /FAIL AGENTS\.md: missing/);
	});

	it("audit reports prerequisite failures", () => {
		const dir = fixture();
		goFixture(dir);
		rmSync(join(dir, "mise.toml"));
		const audit = run(["audit"], dir);
		assert.equal(audit.code, 1);
		assert.match(audit.output, /^FAIL pin go: mise\.toml needs a non-empty \[tools\] pin/m);
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

	it("audit fails when node scripts break the contract", () => {
		const dir = fixture();
		nodePkg(dir);
		assert.equal(run(["init"], dir).code, 0);
		nodePkg(dir, { quality: "biome ci .", validate: "npm run quality", ci: "npm run validate", build: "x" });
		writeFileSync(
			join(dir, "package.json"),
			`${JSON.stringify({ name: "fixture", scripts: { quality: "biome ci .", ci: "npm run validate" } }, null, "\t")}\n`,
		);
		const audit = run(["audit"], dir);
		assert.equal(audit.code, 1);
		assert.match(audit.output, /FAIL scripts: missing or empty script: validate/);
	});

	it("status shows kind, prerequisites, and artifacts; stays exit 0 on drift", () => {
		const dir = fixture();
		nodePkg(dir);
		assert.equal(run(["init"], dir).code, 0);
		const status = run(["status"], dir);
		assert.equal(status.code, 0, status.output);
		assert.match(status.output, /^kind: node$/m);
		assert.match(status.output, /^pin node: 24\.18\.0$/m);
		assert.match(status.output, /^lockfile: ok$/m);
		assert.match(status.output, /^scripts: ok$/m);
		assert.match(status.output, /^biome: 2\.5\.4$/m);
		assert.match(status.output, /^mise\.toml: ok$/m);
		assert.match(status.output, /^workflow: ok$/m);
		assert.match(status.output, /^AGENTS\.md: ok$/m);

		const broken = fixture();
		nodePkg(broken);
		const brokenStatus = run(["status"], broken);
		assert.equal(brokenStatus.code, 0, brokenStatus.output);
		assert.match(brokenStatus.output, /^mise\.toml: no pi-ci-standard managed block/m);
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
