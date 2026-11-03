import { describe, expect, it } from "vitest";
import { abbreviatePathSegments } from "@/utils/path-display";

describe("abbreviatePathSegments", () => {
	it("keeps the home marker and abbreviates parent directories", () => {
		expect(abbreviatePathSegments("~/Documents/HCMUT/Architectures/ASA", 2)).toBe("~/D/H/Architectures/ASA");
	});

	it("keeps the leading slash on an absolute path", () => {
		expect(abbreviatePathSegments("/var/lib/projects/kanban", 2)).toBe("/v/l/projects/kanban");
	});

	it("leaves a single segment unchanged", () => {
		expect(abbreviatePathSegments("kanban", 1)).toBe("kanban");
	});

	it("never abbreviates the last segment", () => {
		expect(abbreviatePathSegments("~/Documents/HCMUT/ASA-CO5260", 10)).toBe("~/D/H/ASA-CO5260");
	});

	it("normalizes and abbreviates Windows-style paths", () => {
		expect(abbreviatePathSegments("C:\\Projects\\Kanban", 1)).toBe("C:/P/Kanban");
	});
});
