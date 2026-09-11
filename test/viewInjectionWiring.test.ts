import {describe, it, expect} from 'vitest';
import {readFileSync, readdirSync} from 'node:fs';
import {resolve} from 'node:path';

// ---------------------------------------------------------------------------
// View-injection wiring (#180)
//
// `src/view/*.ts` injects ~108 methods into `SynapseView` by declaration
// merging plus prototype assignment:
//
//   declare module '../synapseView' {
//     interface SynapseView { someMethod(x: string): void; }
//   }
//   export function installSomeFeature(ViewClass: {prototype: unknown}): void {
//     const proto = ViewClass.prototype as SynapseView;
//     proto.someMethod = function (x) { ... };
//   }
//
// Because `proto` is cast to `SynapseView`, the compiler catches an
// undeclared assignment and a signature mismatch. It does NOT catch:
//
//   1. A method declared in the `declare module` block with no matching
//      `proto.<name> =` assignment. The call site (`this.someMethod(...)`)
//      compiles clean against the declared interface and throws
//      "is not a function" at runtime.
//   2. A view file that declares and implements everything correctly, but
//      whose `installX(SynapseView)` call is missing from `synapseView.ts`
//      — none of its methods ever attach, again with no compile error.
//
// Both are wiring gaps, not logic gaps: a behavioural test would have to
// name the very method whose wiring was forgotten, which defeats the
// purpose. So — as with `test/sessionEventWiring.test.ts` before it (deleted
// once #179 made that particular seam compiler-checked) — this reads the
// source text directly and asserts the two structural invariants that hold
// the pattern together.
// ---------------------------------------------------------------------------

const repoRoot = resolve(__dirname, '..');

function read(relativePath: string): string {
	return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

/** `src/view/*.ts` filenames, discovered from disk so a new file is covered automatically. */
function viewFiles(): string[] {
	return readdirSync(resolve(repoRoot, 'src/view'))
		.filter(f => f.endsWith('.ts'))
		.sort();
}

/** Index of the `}` matching the `{` at `openIndex` (which must itself be `{`). */
function findMatchingBrace(source: string, openIndex: number): number {
	let depth = 0;
	for (let i = openIndex; i < source.length; i++) {
		if (source[i] === '{') depth++;
		else if (source[i] === '}') {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Method names declared in a file's `declare module '../synapseView' { interface SynapseView { ... } }`
 * block, or `null` if the file has no such block. Matches lines of the form `<tabs>name(` — i.e.
 * method signatures, not plain properties (`foo?: Bar;`, `readonly foo: Bar;`) — including ones
 * whose parameter list spans multiple lines (e.g. an inline object-literal parameter type).
 */
function declaredMethods(source: string): string[] | null {
	const marker = 'declare module \'../synapseView\' {';
	const markerIndex = source.indexOf(marker);
	if (markerIndex === -1) return null;
	const braceStart = markerIndex + marker.length - 1;
	const braceEnd = findMatchingBrace(source, braceStart);
	const block = braceEnd === -1 ? source.slice(markerIndex) : source.slice(markerIndex, braceEnd + 1);
	return Array.from(block.matchAll(/^\t+([A-Za-z_$][\w$]*)\(/gm), m => m[1]!);
}

/** `proto.<name> =` assignments at the top level of an `installX` function body. */
function protoAssignments(source: string): Set<string> {
	return new Set(Array.from(source.matchAll(/^\tproto\.([A-Za-z_$][\w$]*)\s*=/gm), m => m[1]!));
}

/** Names of `install*` functions a file exports (its top-level entry point into `synapseView.ts`). */
function installExports(source: string): string[] {
	return Array.from(source.matchAll(/^export function (install[A-Za-z]+)\(/gm), m => m[1]!);
}

describe('view-injection wiring', () => {
	it('finds declare-module blocks and proto assignments in the source (guards the regexes themselves)', () => {
		// If a refactor changes how declarations or assignments are written, these regexes could
		// silently match nothing and the per-file assertions below would pass vacuously.
		const files = viewFiles();
		expect(files.length).toBeGreaterThan(0);

		let totalDeclared = 0;
		let totalAssigned = 0;
		let filesWithDeclareBlock = 0;
		for (const file of files) {
			const source = read(`src/view/${file}`);
			const declared = declaredMethods(source);
			if (declared !== null) {
				filesWithDeclareBlock++;
				totalDeclared += declared.length;
			}
			totalAssigned += protoAssignments(source).size;
		}
		expect(filesWithDeclareBlock).toBeGreaterThan(0);
		expect(totalDeclared).toBeGreaterThan(30);
		expect(totalAssigned).toBeGreaterThan(30);
	});

	it('AC-1: every method declared in a declare-module block has a matching proto.<name> = assignment in the same file', () => {
		const problems: string[] = [];
		for (const file of viewFiles()) {
			const source = read(`src/view/${file}`);
			const declared = declaredMethods(source);
			if (declared === null) continue;
			const assigned = protoAssignments(source);
			for (const name of declared) {
				if (!assigned.has(name)) {
					problems.push(`src/view/${file}: '${name}' is declared in the 'declare module' block but has `
						+ `no 'proto.${name} = ...' assignment in this file — the call site will compile clean `
						+ `and throw "is not a function" at runtime`);
				}
			}
		}
		expect(problems).toEqual([]);
	});

	it('AC-2: every install* export has a corresponding call in synapseView.ts', () => {
		const synapseViewSource = read('src/synapseView.ts');
		const problems: string[] = [];
		let totalInstallers = 0;
		for (const file of viewFiles()) {
			const source = read(`src/view/${file}`);
			for (const installer of installExports(source)) {
				totalInstallers++;
				const calledPattern = new RegExp(`\\b${installer}\\(`);
				if (!calledPattern.test(synapseViewSource)) {
					problems.push(`src/view/${file} exports '${installer}' but src/synapseView.ts never calls it `
						+ `— none of this file's methods attach to SynapseView.prototype at runtime`);
				}
			}
		}
		// Guards the installExports regex itself: if it silently matched nothing, the loop above
		// would pass vacuously with zero problems found.
		expect(totalInstallers).toBeGreaterThan(0);
		expect(problems).toEqual([]);
	});
});
