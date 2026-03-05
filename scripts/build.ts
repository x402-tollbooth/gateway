import { execSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { build } from "esbuild";

// Clean dist
rmSync("./dist", { recursive: true, force: true });

// Read package.json to externalize all dependencies
const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));
const external = [
	...Object.keys(pkg.dependencies ?? {}),
	...Object.keys(pkg.peerDependencies ?? {}),
];

// ESM build
await build({
	entryPoints: ["./src/index.ts", "./src/cli.ts"],
	outdir: "./dist",
	format: "esm",
	platform: "node",
	target: "node20",
	sourcemap: false,
	minify: true,
	bundle: true,
	external,
	banner: {
		// Preserve CLI shebang in the output
		js: "",
	},
});

// Generate declarations (no source maps, no declaration maps)
execSync(
	"npx tsc --emitDeclarationOnly --declaration --declarationMap false --outDir dist",
	{ stdio: "inherit" },
);

console.log("Build complete");
