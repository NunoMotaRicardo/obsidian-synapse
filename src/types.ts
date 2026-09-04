/** Parsed agent configuration from *.agent.md frontmatter + body. */
export interface AgentConfig {
	name: string;
	description: string;
	model?: string;
	/** List of MCP tool server names to enable. Empty/undefined = all. */
	tools?: string[];
	/** List of skill names to enable. Empty/undefined = all. */
	skills?: string[];
	instructions: string;
	filePath: string;
}

/** Vault event types that can trigger execution. */
export type TriggerEvent = 'file-created' | 'file-modified' | 'file-deleted' | 'file-renamed';

/** Parsed trigger configuration from _synapse/triggers/*.md frontmatter + body. */
export interface TriggerConfig {
	name: string;
	description: string;
	/** Vault event that fires this trigger. Mutually exclusive with `schedule`. */
	event?: TriggerEvent;
	/** Cron expression for scheduled execution. Mutually exclusive with `event`. */
	schedule?: string;
	/** Glob pattern scoping which files the trigger applies to. */
	path?: string;
	/** Model alias or local model ID to use. */
	model?: string;
	/** Agent name to use for this trigger. */
	agent?: string;
	/** Whether the trigger may write back. false = read-only, true = full write, 'frontmatter' = frontmatter-only. */
	write?: boolean | 'frontmatter';
	/** Whether the trigger is active. Defaults to true when omitted. */
	enabled?: boolean;
	/** Prompt/instructions from the markdown body. */
	body: string;
	/** Vault-relative path to the trigger file. */
	filePath: string;
}

/** Parsed skill information from a skill folder's SKILL.md. */
export interface SkillInfo {
	/**
	 * The skill's own name, as written in its `SKILL.md` folder — always unqualified.
	 * This is what the user typed when they created the skill, so it is what the popup
	 * displays, what the popup filters on, and what an agent's `skills:` restriction is
	 * matched against (issue #163).
	 */
	name: string;
	description: string;
	/** Vault-relative path to the skill folder. */
	folderPath: string;
	/**
	 * The CLI's namespaced id for this command (`<plugin>:<name>`), when it has one — set
	 * only for skills sourced from the live `supportedCommands()` capture (#130), and only
	 * when the CLI actually namespaced them. This is the form inserted into the input,
	 * because it is what the CLI advertises and therefore certainly resolves, while `name`
	 * alone is what the user sees and types (issue #163).
	 */
	qualifiedName?: string;
}

/** A message in the Synapse chat conversation. */
export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant' | 'info';
	content: string;
	reasoning?: string;
	timestamp: number;
	attachments?: ChatAttachment[];
}

/** An attachment added to a chat message. */
export interface ChatAttachment {
	type: 'file' | 'directory' | 'clipboard' | 'image' | 'selection' | 'blob';
	name: string;
	/** Vault-relative path (for files, directories, images, selections) or absolute OS path when `absolutePath` is true. */
	path?: string;
	/** Raw text content (for clipboard or selection). */
	content?: string;
	/** When true, `path` is an absolute OS path (not vault-relative). */
	absolutePath?: boolean;
	/** Base64-encoded binary data (for blob attachments). */
	data?: string;
	/** MIME type of the binary data (for blob attachments). */
	mimeType?: string;
	/** Selection range (1-based line numbers). */
	selection?: {
		startLine: number;
		startChar: number;
		endLine: number;
		endChar: number;
	};
}

/** Selection info passed when "Chat with Synapse" is invoked on selected text. */
export interface SelectionInfo {
	filePath?: string;
	fileName: string;
	startLine: number;
	startChar: number;
	endLine: number;
	endChar: number;
}

/** Image file extensions recognized for icon display, drag-drop handling, and attachment. */
export const IMAGE_EXTS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

/** Check whether an attachment represents an image (for icon rendering). */
export function isImageAttachment(att: Pick<ChatAttachment, 'type' | 'name' | 'mimeType'>): boolean {
	if (att.type === 'image') return true;
	if (att.type === 'blob') return !!att.mimeType?.startsWith('image/');
	if (att.type === 'file' && att.name) {
		const ext = att.name.split('.').pop()?.toLowerCase() ?? '';
		return IMAGE_EXTS.has(ext);
	}
	return false;
}
