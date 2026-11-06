import { describe, expect, it } from "vitest";
import { areasOfFiles, EMPLOYEE_AREAS, isEmployeeArea } from "../../../src/core/employee-areas";

describe("areasOfFiles", () => {
	it("drops tests when another area matched", () => {
		expect(areasOfFiles(["web-ui/src/a.tsx", "test/x.test.ts"])).toEqual(["web-ui"]);
	});
	it("keeps tests when nothing else matched", () => {
		expect(areasOfFiles(["test/x.test.ts"])).toEqual(["tests"]);
	});
	it("maps issue-sync before server", () => {
		expect(areasOfFiles(["src/server/github-issue-sync.ts"])).toEqual(["issue-sync"]);
	});
	it("maps cli, docs and other src", () => {
		expect(areasOfFiles(["src/cli.ts"])).toEqual(["cli"]);
		expect(areasOfFiles(["README.md"])).toEqual(["docs"]);
		expect(areasOfFiles(["src/core/x.ts"])).toEqual(["runtime-other"]);
	});
	it("dedupes and orders by area list", () => {
		expect(areasOfFiles(["src/state/a.ts", "src/fs/b.ts", "web-ui/c.ts"])).toEqual(["web-ui", "state"]);
	});
	it("validates area names", () => {
		expect(isEmployeeArea("web-ui")).toBe(true);
		expect(isEmployeeArea("bogus")).toBe(false);
		expect(EMPLOYEE_AREAS[0]).toBe("web-ui");
	});
});
