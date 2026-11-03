import { useCallback, useEffect, useState } from "react";
import { abbreviatePathSegments } from "@/utils/path-display";

export function useAbbreviatedPath(path: string): {
	pathRef: React.Ref<HTMLDivElement>;
	displayPath: string;
	fullPathWidth: number | undefined;
} {
	const [element, setElement] = useState<HTMLDivElement | null>(null);
	const pathRef = useCallback((node: HTMLDivElement | null) => setElement(node), []);
	const [abbreviatedCount, setAbbreviatedCount] = useState(0);
	const [fullPathWidth, setFullPathWidth] = useState<number>();

	useEffect(() => {
		if (!element) {
			return;
		}
		const probe = document.createElement("span");
		const parentCount = path.split(/[\\/]/).filter(Boolean).length - 1;
		document.body.append(probe);
		const measure = () => {
			const styles = getComputedStyle(element.firstElementChild ?? element);
			probe.style.cssText = `position: fixed; visibility: hidden; white-space: nowrap; font: ${styles.font}; letter-spacing: ${styles.letterSpacing};`;
			probe.textContent = path;
			setFullPathWidth(probe.getBoundingClientRect().width);
			let count = 0;
			while (count < parentCount) {
				const candidate = abbreviatePathSegments(path, count);
				probe.textContent = candidate;
				if (probe.getBoundingClientRect().width <= element.getBoundingClientRect().width) {
					break;
				}
				count += 1;
			}
			setAbbreviatedCount(count);
		};
		measure();
		document.fonts?.addEventListener("loadingdone", measure);
		if (typeof ResizeObserver === "undefined") {
			return () => {
				document.fonts?.removeEventListener("loadingdone", measure);
				probe.remove();
			};
		}
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => {
			observer.disconnect();
			document.fonts?.removeEventListener("loadingdone", measure);
			probe.remove();
		};
	}, [element, path]);

	return { pathRef, displayPath: abbreviatePathSegments(path, abbreviatedCount), fullPathWidth };
}
