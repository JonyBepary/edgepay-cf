declare const window: { matchMedia?: (query: string) => { matches: boolean } };
declare const document: { querySelector: (selector: string) => unknown };
declare const navigator: { vibrate?: (pattern: number | number[]) => boolean };
type HTMLElement = { textContent: string | null; querySelector?: (selector: string) => unknown; style: Record<string, string | number | undefined> };
type SVGPathElement = { getTotalLength: () => number; style: Record<string, string | number | undefined> };
