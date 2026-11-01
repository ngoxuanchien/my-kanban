import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EditorFileLinkError, resolveEditorFileUrl } from "../../../src/server/editor-link";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "kanban-editor-link-"));
	tempDirs.push(path);
	return path;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("resolveEditorFileUrl", () => {
	it("opens existing files in an allowed root at a line and column", async () => {
		const root = await makeTempDir();
		const file = join(root, "file.ts");
		await writeFile(file, "content");
		const realFile = await realpath(file);

		expect(await resolveEditorFileUrl({ path: file, line: 12, column: 3 }, [root])).toBe(
			`vscode://file${realFile}:12:3`,
		);
		expect(await resolveEditorFileUrl({ path: file }, [root])).toBe(`vscode://file${realFile}`);
	});

	it("encodes spaces in file paths", async () => {
		const root = await makeTempDir();
		const file = join(root, "with space.ts");
		await writeFile(file, "content");
		const realFile = await realpath(file);

		expect(await resolveEditorFileUrl({ path: file }, [root])).toBe(`vscode://file${realFile.replace(" ", "%20")}`);
	});

	it.each([
		{ path: "relative.ts", code: "BAD_REQUEST" },
		{ path: "/definitely/missing/file.ts", code: "BAD_REQUEST" },
	])("rejects invalid path $path", async ({ path, code }) => {
		await expect(resolveEditorFileUrl({ path }, [await makeTempDir()])).rejects.toMatchObject({ code });
	});

	it("rejects files outside roots, including paths escaping with ..", async () => {
		const root = await makeTempDir();
		const outside = await makeTempDir();
		const file = join(outside, "outside.ts");
		await mkdir(join(root, "nested"));
		await writeFile(file, "content");

		await expect(resolveEditorFileUrl({ path: file }, [root])).rejects.toBeInstanceOf(EditorFileLinkError);
		await expect(
			resolveEditorFileUrl({ path: join(root, "..", basename(outside), "outside.ts") }, [root]),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
