export async function drainCliOutput(): Promise<void> {
	await Promise.all([
		new Promise<void>((resolve, reject) =>
			process.stdout.write("", (error?: NodeJS.ErrnoException | null) => {
				if (error && error.code !== "EPIPE") {
					reject(error);
					return;
				}
				resolve();
			}),
		),
		new Promise<void>((resolve, reject) =>
			process.stderr.write("", (error?: NodeJS.ErrnoException | null) => {
				if (error && error.code !== "EPIPE") {
					reject(error);
					return;
				}
				resolve();
			}),
		),
	]);
}
