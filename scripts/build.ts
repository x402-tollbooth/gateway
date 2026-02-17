import { build } from "bun";

// ESM build
await build({
	entrypoints: ["./src/index.ts", "./src/cli.ts"],
	outdir: "./dist",
	format: "esm",
	target: "bun",
	sourcemap: "external",
	minify: false,
	external: ["yaml", "zod"],
});

// Generate declarations
const proc = Bun.spawn(["bunx", "tsc", "--emitDeclarationOnly", "--declaration", "--outDir", "dist"], {
	stdout: "inherit",
	stderr: "inherit",
});
await proc.exited;

console.log("✅ Build complete");
