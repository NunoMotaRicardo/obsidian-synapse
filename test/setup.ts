/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import {vi} from 'vitest';

// Global mock for the Obsidian API since it's only available inside the Obsidian app.
vi.mock('obsidian', () => {
	return {
		normalizePath: (p: string) => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
		TFile: class {},
		TFolder: class {},
		TAbstractFile: class {},
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
