import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { run } from "./core.ts";

export default function piCiStandard(pi: ExtensionAPI): void {
	pi.registerCommand("ci", {
		description: "CI standard: /ci init|audit|status [dir] [--kind node|go|rust]",
		getArgumentCompletions: (prefix: string) => {
			const items = ["init", "audit", "status"].map((value) => ({ value, label: value }));
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const { code, output } = run(args.trim().split(/\s+/).filter(Boolean), ctx.cwd);
			if (ctx.hasUI) {
				ctx.ui.notify(output, code === 0 ? "info" : "error");
			} else if (code === 0) {
				console.log(output);
			} else {
				console.error(output);
			}
		},
	});
}
