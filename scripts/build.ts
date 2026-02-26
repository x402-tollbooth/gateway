import { build } from "bun";
import { rmSync } from "node:fs";

// Clean dist
rmSync("./dist", { recursive: true, force: true });

// ESM build
await build({
	entrypoints: ["./src/index.ts", "./src/cli.ts"],
	outdir: "./dist",
	format: "esm",
	target: "bun",
	sourcemap: "none",
	minify: true,
	external: ["yaml", "zod"],
});

// Generate declarations (no source maps, no declaration maps)
const proc = Bun.spawn(
	["bunx", "tsc", "--emitDeclarationOnly", "--declaration", "--declarationMap", "false", "--outDir", "dist"],
	{
		stdout: "inherit",
		stderr: "inherit",
	},
);
await proc.exited;

console.log("✅ Build complete");
