import { describe, expect, test } from "vitest";
import { convertPathParams, extractOperations } from "../init.js";

describe("convertPathParams", () => {
	test("converts {param} to :param", () => {
		expect(convertPathParams("/users/{id}")).toBe("/users/:id");
	});

	test("converts multiple params", () => {
		expect(convertPathParams("/users/{userId}/posts/{postId}")).toBe(
			"/users/:userId/posts/:postId",
		);
	});

	test("leaves paths without params unchanged", () => {
		expect(convertPathParams("/users")).toBe("/users");
	});

	test("handles root path", () => {
		expect(convertPathParams("/")).toBe("/");
	});
});

describe("extractOperations", () => {
	test("extracts operations from OpenAPI spec", () => {
		const spec = {
			openapi: "3.0.3",
			paths: {
				"/pets": {
					get: { summary: "List pets" },
					post: { summary: "Create pet" },
				},
				"/pets/{petId}": {
					get: { summary: "Get pet" },
					delete: {},
				},
			},
		};

		const ops = extractOperations(spec);
		expect(ops).toEqual([
			{ method: "GET", path: "/pets", summary: "List pets" },
			{ method: "POST", path: "/pets", summary: "Create pet" },
			{ method: "GET", path: "/pets/:petId", summary: "Get pet" },
			{ method: "DELETE", path: "/pets/:petId", summary: undefined },
		]);
	});

	test("ignores non-HTTP-method keys like summary and parameters", () => {
		const spec = {
			openapi: "3.0.3",
			paths: {
				"/pets": {
					summary: "Pet operations",
					parameters: [{ name: "limit", in: "query" }],
					get: { summary: "List pets" },
				},
			},
		};

		const ops = extractOperations(spec);
		expect(ops).toHaveLength(1);
		expect(ops[0].method).toBe("GET");
	});

	test("returns empty array for missing paths", () => {
		expect(extractOperations({})).toEqual([]);
		expect(extractOperations({ paths: null })).toEqual([]);
	});

	test("converts path params in extracted operations", () => {
		const spec = {
			openapi: "3.0.3",
			paths: {
				"/users/{userId}/posts/{postId}": {
					get: {},
				},
			},
		};

		const ops = extractOperations(spec);
		expect(ops[0].path).toBe("/users/:userId/posts/:postId");
	});
});
