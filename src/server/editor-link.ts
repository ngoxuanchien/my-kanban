import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

export class EditorFileLinkError extends Error {
	constructor(
		message: string,
		readonly code: "BAD_REQUEST" | "FORBIDDEN",
	) {
		super(message);
	}
}

export async function resolveEditorFileUrl(
	input: { path: string; line?: number; column?: number },
	allowedRoots: string[],
): Promise<string> {
	if (!isAbsolute(input.path)) {
		throw new EditorFileLinkError("File path must be absolute.", "BAD_REQUEST");
	}

	let filePath: string;
	try {
		filePath = await realpath(input.path);
		if (!(await stat(filePath)).isFile()) {
			throw new Error("Not a file");
		}
	} catch {
		throw new EditorFileLinkError("File not found.", "BAD_REQUEST");
	}

	const roots = await Promise.all(
		allowedRoots.map(async (root) => {
			try {
				return await realpath(root);
			} catch {
				return null;
			}
		}),
	);
	if (
		!roots.some((root) => {
			if (!root) return false;
			const fromRoot = relative(root, filePath);
			return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
		})
	) {
		throw new EditorFileLinkError("File is outside the allowed roots.", "FORBIDDEN");
	}

	return `vscode://file${encodeURI(filePath)}${input.line ? `:${input.line}${input.column ? `:${input.column}` : ""}` : ""}`;
}
