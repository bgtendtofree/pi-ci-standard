#!/usr/bin/env node
import { run } from "./core.ts";

const { code, output } = run(process.argv.slice(2), process.cwd());
if (output) {
	if (code === 0) console.log(output);
	else console.error(output);
}
process.exitCode = code;
