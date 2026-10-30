export async function drainCliOutput(): Promise<void> {
	await Promise.all([
		new Promise<void>((resolve) => process.stdout.write("", () => resolve())),
		new Promise<void>((resolve) => process.stderr.write("", () => resolve())),
	]);
}
