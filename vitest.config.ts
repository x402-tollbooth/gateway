import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		root: "src",
		testTimeout: 5000,
		include: ["**/*.test.ts"],
	},
});
