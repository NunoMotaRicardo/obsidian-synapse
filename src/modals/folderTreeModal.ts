import {App, Modal, TFolder, setIcon} from 'obsidian';

export class FolderTreeModal extends Modal {
	private readonly onSelect: (folder: TFolder) => void;
	private readonly currentPath: string;
	private collapsed: Set<string>;
	private searchInput!: HTMLInputElement;
	private listContainer!: HTMLElement;

	constructor(app: App, currentPath: string, onSelect: (folder: TFolder) => void) {
		super(app);
		this.onSelect = onSelect;
		this.currentPath = currentPath;
		this.collapsed = new Set<string>();
		this.collapseAllBelow(this.app.vault.getRoot(), 1);
		// Ensure current path is visible
		if (currentPath) {
			const parts = currentPath.split('/');
			for (let i = 1; i <= parts.length; i++) {
				this.collapsed.delete(parts.slice(0, i).join('/'));
			}
		}
		this.collapsed.delete('/');
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass('sidekick-scope-modal');

		contentEl.createEl('h3', {text: 'Select working directory'});

		this.searchInput = contentEl.createEl('input', {
			type: 'text',
			placeholder: 'Filter folders…',
			cls: 'sidekick-scope-search',
		});
		this.searchInput.addEventListener('input', () => this.renderTree());

		this.listContainer = contentEl.createDiv({cls: 'sidekick-scope-tree'});

		this.renderTree();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderTree(): void {
		this.listContainer.empty();
		const filter = this.searchInput.value.toLowerCase();
		const root = this.app.vault.getRoot();

		// Root node
		const rootRow = this.listContainer.createDiv({cls: 'sidekick-scope-item'});
		if (this.currentPath === '') rootRow.addClass('is-active');

		const toggle = rootRow.createSpan({cls: 'sidekick-scope-toggle'});
		setIcon(toggle, this.collapsed.has('/') ? 'chevron-right' : 'chevron-down');
		toggle.addEventListener('click', (e) => {
			e.stopPropagation();
			if (this.collapsed.has('/')) this.collapsed.delete('/');
			else this.collapsed.add('/');
			this.renderTree();
		});

		const iconSpan = rootRow.createSpan({cls: 'sidekick-scope-icon'});
		setIcon(iconSpan, 'vault');

		rootRow.createSpan({text: this.app.vault.getName(), cls: 'sidekick-scope-name sidekick-scope-root-name'});

		rootRow.addEventListener('click', () => {
			this.onSelect(root);
			this.close();
		});

		if (!this.collapsed.has('/')) {
			this.renderFolder(root, this.listContainer, 1, filter);
		}
	}

	private renderFolder(folder: TFolder, parent: HTMLElement, depth: number, filter: string): void {
		const children = [...folder.children]
			.filter((c): c is TFolder => c instanceof TFolder && !c.name.startsWith('.'))
			.sort((a, b) => a.name.localeCompare(b.name));

		for (const child of children) {
			const matchesFilter = !filter || child.path.toLowerCase().includes(filter);
			const hasMatch = this.hasMatchingDescendants(child, filter);
			if (!matchesFilter && !hasMatch) continue;

			const row = parent.createDiv({cls: 'sidekick-scope-item'});
			row.style.paddingLeft = `${depth * 20 + 8}px`;
			if (child.path === this.currentPath) row.addClass('is-active');

			const hasSubfolders = child.children.some(c => c instanceof TFolder && !c.name.startsWith('.'));
			if (hasSubfolders) {
				const toggle = row.createSpan({cls: 'sidekick-scope-toggle'});
				setIcon(toggle, this.collapsed.has(child.path) ? 'chevron-right' : 'chevron-down');
				toggle.addEventListener('click', (e) => {
					e.stopPropagation();
					if (this.collapsed.has(child.path)) this.collapsed.delete(child.path);
					else this.collapsed.add(child.path);
					this.renderTree();
				});
			} else {
				row.createSpan({cls: 'sidekick-scope-toggle sidekick-scope-toggle-spacer'});
			}

			const iconEl = row.createSpan({cls: 'sidekick-scope-icon'});
			setIcon(iconEl, 'folder');

			row.createSpan({text: child.name, cls: 'sidekick-scope-name'});

			row.addEventListener('click', () => {
				this.onSelect(child);
				this.close();
			});

			if (hasSubfolders && !this.collapsed.has(child.path)) {
				this.renderFolder(child, parent, depth + 1, filter);
			}
		}
	}

	private hasMatchingDescendants(folder: TFolder, filter: string): boolean {
		if (!filter) return true;
		for (const child of folder.children) {
			if (!(child instanceof TFolder) || child.name.startsWith('.')) continue;
			if (child.path.toLowerCase().includes(filter)) return true;
			if (this.hasMatchingDescendants(child, filter)) return true;
		}
		return false;
	}

	private collapseAllBelow(folder: TFolder, maxDepth: number, current = 0): void {
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				if (current >= maxDepth) this.collapsed.add(child.path);
				this.collapseAllBelow(child, maxDepth, current + 1);
			}
		}
	}
}
