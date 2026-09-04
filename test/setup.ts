import {vi} from 'vitest';
import type {App, TFile as ObsidianTFile, TFolder as ObsidianTFolder} from 'obsidian';

// vitest.config.ts runs tests under the `node` environment (no DOM), but src/ code
// increasingly calls `window.setTimeout`/`window.clearTimeout`/`window.require` etc.
// (obsidianmd/prefer-window-timers — needed for popout-window compatibility inside
// Obsidian's Electron renderer, where `window === globalThis`). Alias `window` to
// `globalThis` here so that real behavior (window === globalThis in the app) is
// mirrored in tests, without pulling in a full jsdom environment.
if (typeof (globalThis as {window?: unknown}).window === 'undefined') {
	(globalThis as {window?: unknown}).window = globalThis;
}

// ---------------------------------------------------------------------------
// TAbstractFile / TFile / TFolder + MockVault — an in-memory stand-in for the
// real Obsidian `Vault` API, general enough for any test touching
// `App`/`Vault`/`TFile`/`TFolder` (not shaped to one assertion).
//
// Defined via `vi.hoisted` so the same class instances are both (a) exported
// below for tests to build fixtures with, and (b) returned by the
// `vi.mock('obsidian', ...)` factory further down — `vi.mock` factories are
// hoisted above normal imports/declarations, so anything they reference must
// be defined through `vi.hoisted` too, or `instanceof` checks in src/ (which
// imports `TFile`/`TFolder` from `obsidian`) would compare against a
// different, disconnected class than test fixtures use.
//
// Behavior intentionally mirrors real Obsidian rather than being bent to any
// one test:
//   - `create()`/`createFolder()` throw if the target already exists, and
//     throw if the parent folder does not exist yet (Obsidian does not
//     silently create intermediate directories — callers are expected to
//     have called `createFolder` for every intermediate segment already,
//     which is exactly what `src/configWriter.ts`'s `ensureFolder` does).
//   - the root folder's path is `''`, matching `normalizePath` stripping
//     leading/trailing slashes.
// ---------------------------------------------------------------------------

const {
	TAbstractFile,
	TFile,
	TFolder,
	MockVault,
	createMockApp,
	normalizePathForMock,
} = vi.hoisted(() => {
	function normalize(p: string): string {
		return p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
	}

	class TAbstractFile {
		path: string;
		name: string;
		parent: TFolder | null = null;

		constructor(path: string) {
			this.path = normalize(path);
			const segments = this.path.split('/');
			this.name = segments[segments.length - 1] ?? this.path;
		}
	}

	class TFile extends TAbstractFile {
		basename: string;
		extension: string;
		/** Matches the real `TFile#stat` shape; timestamps aren't meaningfully simulated. */
		stat = {ctime: 0, mtime: 0, size: 0};

		constructor(path: string) {
			super(path);
			const dot = this.name.lastIndexOf('.');
			if (dot > 0) {
				this.basename = this.name.slice(0, dot);
				this.extension = this.name.slice(dot + 1);
			} else {
				this.basename = this.name;
				this.extension = '';
			}
		}
	}

	class TFolder extends TAbstractFile {
		children: TAbstractFile[] = [];

		isRoot(): boolean {
			return this.path === '';
		}
	}

	class MockVault {
		readonly root = new TFolder('');
		/**
		 * Deliberately NOT the real `.obsidian` default. `Vault.configDir` is
		 * user-configurable, so any code that excludes the config folder must read this
		 * property rather than assume the default — using a distinctive value here means a
		 * regression that hardcodes `.obsidian` fails the test instead of passing by
		 * coincidence. (It also keeps the literal out of the tree, which
		 * `obsidianmd/hardcoded-config-path` forbids and `eslint-comments/no-restricted-disable`
		 * refuses to let anyone suppress.)
		 */
		readonly configDir = '.mock-config-dir';
		private readonly nodes = new Map<string, TAbstractFile>();
		private readonly contents = new Map<string, string>();
		readonly adapter: {
			basePath: string;
			exists: (path: string) => Promise<boolean>;
		};

		constructor(basePath = 'C:/mock-vault') {
			this.nodes.set('', this.root);
			this.adapter = {
				basePath,
				exists: async (path: string) => this.nodes.has(normalize(path)),
			};
		}

		private parentKeyOf(path: string): string {
			const idx = path.lastIndexOf('/');
			return idx === -1 ? '' : path.slice(0, idx);
		}

		private getParentFolderOrThrow(path: string): TFolder {
			const parentKey = this.parentKeyOf(path);
			const parent = this.nodes.get(parentKey);
			if (!(parent instanceof TFolder)) {
				throw new Error(`Parent folder does not exist: "${parentKey}" (for path "${path}")`);
			}
			return parent;
		}

		getAbstractFileByPath(path: string): TAbstractFile | null {
			return this.nodes.get(normalize(path)) ?? null;
		}

		getRoot(): TFolder {
			return this.root;
		}

		getFiles(): TFile[] {
			return [...this.nodes.values()].filter((n): n is TFile => n instanceof TFile);
		}

		async createFolder(path: string): Promise<TFolder> {
			const key = normalize(path);
			if (this.nodes.has(key)) {
				throw new Error(`Folder already exists: "${key}"`);
			}
			const parent = this.getParentFolderOrThrow(key);
			const folder = new TFolder(key);
			folder.parent = parent;
			parent.children.push(folder);
			this.nodes.set(key, folder);
			return folder;
		}

		async create(path: string, content: string): Promise<TFile> {
			const key = normalize(path);
			if (this.nodes.has(key)) {
				throw new Error(`File already exists: "${key}"`);
			}
			const parent = this.getParentFolderOrThrow(key);
			const file = new TFile(key);
			file.parent = parent;
			parent.children.push(file);
			this.nodes.set(key, file);
			this.contents.set(key, content);
			return file;
		}

		async read(file: TFile): Promise<string> {
			const content = this.contents.get(file.path);
			if (content === undefined) {
				throw new Error(`File not found: "${file.path}"`);
			}
			return content;
		}

		async modify(file: TFile, content: string): Promise<void> {
			if (!this.nodes.has(file.path)) {
				throw new Error(`File not found: "${file.path}"`);
			}
			this.contents.set(file.path, content);
		}

		async trash(file: TAbstractFile, _system: boolean): Promise<void> {
			const key = file.path;
			if (!this.nodes.has(key)) {
				throw new Error(`File not found: "${key}"`);
			}
			this.nodes.delete(key);
			this.contents.delete(key);
			if (file.parent) {
				file.parent.children = file.parent.children.filter((c: TAbstractFile) => c !== file);
			}
		}

		/** Test helper: seed a file directly (auto-creating missing intermediate folders), bypassing `create()`'s existence checks. */
		seedFile(path: string, content: string): TFile {
			const key = normalize(path);
			const parentKey = this.parentKeyOf(key);
			const parent = parentKey ? this.seedFolder(parentKey) : this.root;
			const file = new TFile(key);
			file.parent = parent;
			parent.children.push(file);
			this.nodes.set(key, file);
			this.contents.set(key, content);
			return file;
		}

		/** Test helper: seed a (possibly nested) folder directly. */
		seedFolder(path: string): TFolder {
			const key = normalize(path);
			if (key === '') return this.root;
			const existing = this.nodes.get(key);
			if (existing instanceof TFolder) return existing;
			const parentKey = this.parentKeyOf(key);
			const parent = parentKey ? this.seedFolder(parentKey) : this.root;
			const folder = new TFolder(key);
			folder.parent = parent;
			parent.children.push(folder);
			this.nodes.set(key, folder);
			return folder;
		}
	}

	function createMockApp(basePath?: string): {vault: InstanceType<typeof MockVault>} {
		return {vault: new MockVault(basePath)};
	}

	return {TAbstractFile, TFile, TFolder, MockVault, createMockApp, normalizePathForMock: normalize};
});

export {TAbstractFile, TFile, TFolder, MockVault, createMockApp};

// ---------------------------------------------------------------------------
// Typed seeding helpers — tests construct fixtures against `App` (the type
// every src/ function actually takes), not the mock's own class types, so
// these narrow the one `as unknown as App` cast down to a single place
// instead of forcing every call site to reach through `app.vault as any`.
// ---------------------------------------------------------------------------

/** Directly seed a file (auto-creating missing intermediate folders) into an `App` built by `createMockApp()`. */
export function seedFile(app: App, path: string, content: string): ObsidianTFile {
	const vault = app.vault as unknown as InstanceType<typeof MockVault>;
	return vault.seedFile(path, content) as unknown as ObsidianTFile;
}

/** Directly seed a (possibly nested) folder into an `App` built by `createMockApp()`. */
export function seedFolder(app: App, path: string): ObsidianTFolder {
	const vault = app.vault as unknown as InstanceType<typeof MockVault>;
	return vault.seedFolder(path) as unknown as ObsidianTFolder;
}

/**
 * Read a vault-relative file's content, narrowing via `instanceof TFile`
 * (rather than an `as TFile` cast — `obsidianmd/no-tfile-tfolder-cast`
 * prefers the safe narrowing check, and it also gives a clear error when a
 * test's path doesn't point at a file at all, e.g. a typo'd report path).
 */
export async function readVaultFile(app: App, path: string): Promise<string> {
	const abstractFile = app.vault.getAbstractFileByPath(path);
	if (!(abstractFile instanceof TFile)) {
		throw new Error(`Not a file: "${path}"`);
	}
	return app.vault.read(abstractFile);
}

/**
 * Faithful re-implementation of Obsidian's documented `debounce()` contract (real
 * Obsidian's own implementation lives in its closed-source `app.js`, not in this repo
 * or `node_modules/obsidian`, which ships types only). `resetTimer: true` restarts the
 * timeout on every call (classic trailing-edge debounce — fires once, `timeout`ms after
 * the *last* call); `resetTimer: false` schedules on the first call and lets later calls
 * before the timeout update the pending args without pushing the fire time out further.
 * Used by `settings.ts`'s provider Base URL / API key debouncing (#148) and exercised by
 * `test/settings.test.ts`.
 */
function debounceForMock<T extends unknown[]>(cb: (...args: T) => void, timeout = 100, resetTimer = false) {
	let timerId: ReturnType<typeof setTimeout> | null = null;
	let lastArgs: T;
	const debounced = ((...args: T) => {
		lastArgs = args;
		if (resetTimer && timerId !== null) {
			clearTimeout(timerId);
			timerId = null;
		}
		if (timerId === null) {
			timerId = setTimeout(() => {
				timerId = null;
				cb(...lastArgs);
			}, timeout);
		}
		return debounced;
	}) as ((...args: T) => typeof debounced) & {cancel: () => typeof debounced; run: () => void};
	debounced.cancel = () => {
		if (timerId !== null) {
			clearTimeout(timerId);
			timerId = null;
		}
		return debounced;
	};
	debounced.run = () => {
		if (timerId !== null) {
			clearTimeout(timerId);
			timerId = null;
			cb(...lastArgs);
		}
	};
	return debounced;
}

// Global mock for the Obsidian API since it's only available inside the Obsidian app.
vi.mock('obsidian', () => {
	return {
		normalizePath: normalizePathForMock,
		debounce: debounceForMock,
		TFile,
		TFolder,
		TAbstractFile,
		App: class {
			vault = {
				getFiles: () => [],
			};
		},
		PluginSettingTab: class {
			app: any;
			plugin: any;
			constructor(app: any, plugin: any) {
				this.app = app;
				this.plugin = plugin;
			}
		},
		Setting: class {
			constructor(containerEl: any) {}
			setName(name: string) { return this; }
			setDesc(desc: string) { return this; }
			addText(cb: any) { return this; }
			addToggle(cb: any) { return this; }
			addDropdown(cb: any) { return this; }
			addButton(cb: any) { return this; }
			addTextArea(cb: any) { return this; }
		},
		Modal: class {
			app: any;
			constructor(app: any) {
				this.app = app;
			}
			open() {}
			close() {}
		},
		Notice: class {
			constructor(message: string, duration?: number) {}
		},
		requestUrl: vi.fn().mockResolvedValue({
			status: 200,
			json: () => Promise.resolve({}),
			text: () => Promise.resolve(''),
			arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
			headers: {},
		}),
		Platform: {
			isDesktop: true,
			isMobile: false,
			isIosApp: false,
			isAndroidApp: false,
			isMacOS: false,
			isSafari: false,
		},
		Plugin: class {
			app: any;
			manifest: any;
			constructor(app: any, manifest: any) {
				this.app = app;
				this.manifest = manifest;
			}
			onload() {}
			onunload() {}
			registerEvent() {}
			registerInterval() {}
			addCommand() {}
			addSettingTab() {}
			addRibbonIcon() {}
			loadData() { return Promise.resolve({}); }
			saveData() { return Promise.resolve(); }
		},
		addIcon: vi.fn(),
		setIcon: vi.fn(),
		Menu: class {
			addItem() { return this; }
			showAtPosition() {}
		},
		MarkdownView: class {},
		MarkdownRenderer: class {},
		Component: class {
			load() {}
			unload() {}
		},
	};
});
