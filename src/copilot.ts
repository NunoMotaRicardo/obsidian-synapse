import {CopilotClient, CopilotSession, RuntimeConnection, approveAll} from '@github/copilot-sdk';
import type {
	CustomAgentConfig,
	ModelInfo,
	SessionConfig,
	SessionMetadata,
	SessionListFilter,
	GetAuthStatusResponse,
	GetStatusResponse,
	AssistantMessageEvent,
	MCPServerConfig,
	MCPHTTPServerConfig,
	MCPStdioServerConfig,
	SessionEvent,
	SessionEventType,
	MessageOptions,
	PermissionRequest,
	PermissionRequestResult,
	PermissionHandler,
	ElicitationHandler,
	ElicitationContext,
	ElicitationResult,
	ElicitationSchema,
	ElicitationSchemaField,
	ElicitationFieldValue,
} from '@github/copilot-sdk';
import type {ProviderConfig, UserInputHandler, UserInputRequest, UserInputResponse, ReasoningEffort, ReasoningSummary, ContextTier, InfiniteSessionConfig} from '@github/copilot-sdk/dist/types';
import {resolveDefaultCliPath, cleanEnv} from './runtimeManager';
import type {CliPathSource, ResolvedCliPath} from './runtimeManager';

/**
 * Connection state tracked by CopilotService.
 * SDK 1.x removed CopilotClient.getState(); the service tracks state itself
 * around start()/stop() so the rest of the plugin keeps the same contract.
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

// Available at runtime in the esbuild CJS bundle.
const nodeRequire = typeof globalThis.require === 'function' ? globalThis.require : undefined;

/**
 * Manages the CopilotClient lifecycle and provides high-level methods
 * for interacting with the Copilot SDK from within Obsidian.
 */
export class CopilotService {
	private client: CopilotClient | null = null;
	private connectPromise: Promise<void> | null = null;
	private readonly cliPath: string | undefined;
	private readonly cliUrl: string | undefined;
	private readonly githubToken: string | undefined;
	private readonly useLoggedInUser: boolean | undefined;
	private readonly onListModels: (() => Promise<ModelInfo[]> | ModelInfo[]) | undefined;
	private readonly onVersionInfo: ((status: GetStatusResponse, resolvedPath: string) => void) | undefined;
	private readonly onConnectionError: ((error: Error) => void) | undefined;
	private readonly provider: ProviderConfig | undefined;
	private readonly providerStreaming: boolean | undefined;
	private readonly requestTimeout: number | undefined;
	private resolvedCliPath: ResolvedCliPath | null = null;
	private versionInfo: GetStatusResponse | null = null;

	constructor(opts?: {
		cliPath?: string;
		cliUrl?: string;
		githubToken?: string;
		useLoggedInUser?: boolean;
		onListModels?: () => Promise<ModelInfo[]> | ModelInfo[];
		onVersionInfo?: (status: GetStatusResponse, resolvedPath: string) => void;
		/** Callback for connection/network errors (e.g. Ollama not running). */
		onConnectionError?: (error: Error) => void;
		/** BYOK provider config injected into all sessions created by chat()/inlineChat(). */
		provider?: ProviderConfig;
		/** Explicit streaming override; when false, sessions use non-streaming mode. */
		streaming?: boolean;
		/** Request timeout in ms for sendAndWait calls. undefined = SDK default (60s). */
		requestTimeout?: number;
	}) {
		this.cliPath = opts?.cliPath;
		this.cliUrl = opts?.cliUrl;
		this.githubToken = opts?.githubToken;
		this.useLoggedInUser = opts?.useLoggedInUser;
		this.onListModels = opts?.onListModels;
		this.onVersionInfo = opts?.onVersionInfo;
		this.onConnectionError = opts?.onConnectionError;
		this.provider = opts?.provider;
		this.providerStreaming = opts?.streaming;
		this.requestTimeout = opts?.requestTimeout;
	}

	/** Configured request timeout in ms, or undefined for SDK default (60s). */
	get timeout(): number | undefined { return this.requestTimeout; }

	private state: ConnectionState = 'disconnected';

	private async createClient(): Promise<CopilotClient> {
		if (this.cliUrl) {
			// Remote mode — connect to existing server
			return new CopilotClient({
				connection: RuntimeConnection.forUri(this.cliUrl),
				...(this.githubToken ? {gitHubToken: this.githubToken} : {}),
				...(this.onListModels ? {onListModels: this.onListModels} : {}),
			});
		}
		// Local mode — spawn CLI process. An explicit settings path
		// short-circuits resolution; otherwise walk the runtime-manager chain.
		let cliPath: string;
		if (this.cliPath) {
			cliPath = this.cliPath;
			this.resolvedCliPath = {path: this.cliPath, source: 'settings'};
		} else {
			this.resolvedCliPath = await resolveDefaultCliPath();
			cliPath = this.resolvedCliPath.path;
		}
		const os = nodeRequire?.('node:os') as typeof import('node:os') ?? await import('node:os');
		return new CopilotClient({
			connection: RuntimeConnection.forStdio({path: cliPath}),
			workingDirectory: os.homedir(),
			env: cleanEnv(),
			...(this.githubToken ? {gitHubToken: this.githubToken} : {}),
			...(this.useLoggedInUser !== undefined ? {useLoggedInUser: this.useLoggedInUser} : {}),
			...(this.onListModels ? {onListModels: this.onListModels} : {}),
		});
	}

	/**
	 * Ensure the client is started and connected.
	 * If the client is in a broken state, recreates it before starting.
	 */
	async ensureConnected(): Promise<void> {
		if (this.client && this.state === 'connected') {
			return;
		}

		if (this.connectPromise) {
			await this.connectPromise;
			return;
		}

		const connectAttempt = (async () => {
			if (!this.client || this.state === 'error') {
				// No client yet, or the previous one is broken — tear down and recreate.
				if (this.client) {
					try { await this.client.forceStop(); } catch { /* ignore */ }
				}
				this.client = await this.createClient();
			}
			this.state = 'connecting';
			try {
				await this.client.start();
				this.state = 'connected';
				// Fire-and-forget: query CLI version info for logging/display.
				// Must not block or break the connect path on failure.
				this.client.getStatus().then((status) => {
					this.versionInfo = status;
					const resolvedTarget = this.resolvedCliPath?.path ?? this.cliPath ?? this.cliUrl ?? 'unknown';
					this.onVersionInfo?.(status, resolvedTarget);
				}).catch(() => { /* version info is best-effort */ });
			} catch (e) {
				this.state = 'error';
				const detail = e instanceof Error ? e.message : String(e);
				throw new Error(
					`Could not connect to the Copilot CLI (${detail}). ` +
					'Make sure the CLI is installed and up to date — run "copilot update" ' +
					'(SDK 1.x requires a recent CLI).',
				);
			}
		})();

		this.connectPromise = connectAttempt;
		try {
			await connectAttempt;
		} finally {
			if (this.connectPromise === connectAttempt) {
				this.connectPromise = null;
			}
		}
	}

	/** Current connection state. */
	getState(): ConnectionState {
		return this.client ? this.state : 'disconnected';
	}

	/** Cached CLI version info from `getStatus()`, or null if not yet retrieved. */
	getVersionInfo(): GetStatusResponse | null {
		return this.versionInfo;
	}

	/**
	 * Resolve the CLI binary path that would be used for a local connection,
	 * together with which step of the resolution chain it came from. Returns
	 * `undefined` in remote mode. Safe to call without connecting; if a client
	 * has already resolved a path, that cached result is returned.
	 */
	async resolveCliPath(): Promise<ResolvedCliPath | undefined> {
		if (this.cliUrl) return undefined;
		if (this.resolvedCliPath) return this.resolvedCliPath;
		if (this.cliPath) {
			this.resolvedCliPath = {path: this.cliPath, source: 'settings'};
			return this.resolvedCliPath;
		}
		this.resolvedCliPath = await resolveDefaultCliPath();
		return this.resolvedCliPath;
	}

	// ── Authentication ──────────────────────────────────────────────

	/** Check the current authentication status against the Copilot backend. */
	async getAuthStatus(): Promise<GetAuthStatusResponse> {
		await this.ensureConnected();
		return await this.client!.getAuthStatus();
	}

	// ── Models ──────────────────────────────────────────────────────

	/** List available models with capabilities, policy and billing info. */
	async listModels(): Promise<ModelInfo[]> {
		await this.ensureConnected();
		return await this.client!.listModels();
	}

	// ── Sessions ────────────────────────────────────────────────────

	/**
	 * Create a new conversation session.
	 *
	 * @param config - Session configuration (model, tools, system message, etc.)
	 * @returns The newly created CopilotSession.
	 */
	async createSession(config: SessionConfig): Promise<CopilotSession> {
		await this.ensureConnected();
		return await this.client!.createSession({clientName: 'obsidian-claude-brain', ...config});
	}

	/**
	 * Resume an existing session by its ID.
	 *
	 * @param sessionId - ID of the session to resume.
	 * @param config - Optional overrides (model, tools, etc.).
	 */
	async resumeSession(
		sessionId: string,
		config: Omit<SessionConfig, 'clientName'>,
	): Promise<CopilotSession> {
		await this.ensureConnected();
		return await this.client!.resumeSession(sessionId, {
			clientName: 'obsidian-claude-brain',
			...config,
		});
	}

	/** List all persisted sessions, optionally filtered. */
	async listSessions(filter?: SessionListFilter): Promise<SessionMetadata[]> {
		await this.ensureConnected();
		return await this.client!.listSessions(filter);
	}

	/** Permanently delete a session and its data. */
	async deleteSession(sessionId: string): Promise<void> {
		await this.ensureConnected();
		return await this.client!.deleteSession(sessionId);
	}

	/** Get the most recently updated session ID, if any. */
	async getLastSessionId(): Promise<string | undefined> {
		await this.ensureConnected();
		return await this.client!.getLastSessionId();
	}

	// ── Convenience: one-shot chat ──────────────────────────────────

	/**
	 * Send a single prompt and wait for the assistant's response.
	 * Creates a temporary session, sends the message, waits for idle,
	 * then disconnect the session.
	 *
	 * @param prompt - The user prompt.
	 * @param model  - Model to use (e.g. "gpt-5", "claude-sonnet-4.5").
	 * @param systemMessage - Optional system message content to append.
	 * @param customAgents - Optional custom agent configs.
	 * @returns The assistant's final message content, or undefined.
	 */
	async chat(options: {
		prompt: string;
		model?: string;
		systemMessage?: string;
		customAgents?: CustomAgentConfig[];
		agent?: string;
		onPermissionRequest?: PermissionHandler;
		onUserInputRequest?: UserInputHandler;
		onElicitationRequest?: ElicitationHandler;
		attachments?: MessageOptions['attachments'];
	}): Promise<string | undefined> {
		try {
			const session = await this.createSession({
				model: options.model,
				agent: options.agent,
				onPermissionRequest: options.onPermissionRequest ?? approveAll,
				...(options.onUserInputRequest ? {onUserInputRequest: options.onUserInputRequest} : {}),
				...(options.onElicitationRequest ? {onElicitationRequest: options.onElicitationRequest} : {}),
				customAgents: options.customAgents,
				...(options.agent ? {agent: options.agent} : {}),
				...(options.systemMessage
					? {systemMessage: {content: options.systemMessage}}
					: {}),
				...(this.provider ? {provider: this.provider} : {}),
				...(this.providerStreaming !== undefined ? {streaming: this.providerStreaming} : {}),
			});
			try {
				const response: AssistantMessageEvent | undefined =
					await session.sendAndWait({
						prompt: options.prompt,
						...(options.attachments && options.attachments.length > 0 ? {attachments: options.attachments} : {}),
					}, this.requestTimeout);
				return response?.data.content;
			} finally {
				await session.disconnect();
			}
		} catch (e) {
			if (this.onConnectionError && e instanceof Error && this.isConnectionError(e)) {
				this.onConnectionError(e);
			}
			throw e;
		}
	}

	/**
	 * Send a single prompt, wait for the response, and keep the session alive.
	 * Like chat() but the session is NOT disconnected, so it persists in the
	 * session list and can be resumed later.
	 *
	 * @returns Object containing the assistant's response content and the sessionId.
	 */
	async inlineChat(options: {
		prompt: string;
		model?: string;
		systemMessage?: string;
		customAgents?: CustomAgentConfig[];
		agent?: string;
		skillDirectories?: string[];
		disabledSkills?: string[];
		onPermissionRequest?: PermissionHandler;
		onUserInputRequest?: UserInputHandler;
		onElicitationRequest?: ElicitationHandler;
		attachments?: MessageOptions['attachments'];
	}): Promise<{content: string | undefined; sessionId: string}> {
		try {
			const session = await this.createSession({
				model: options.model,
				agent: options.agent,
				onPermissionRequest: options.onPermissionRequest ?? approveAll,
				...(options.onUserInputRequest ? {onUserInputRequest: options.onUserInputRequest} : {}),
				...(options.onElicitationRequest ? {onElicitationRequest: options.onElicitationRequest} : {}),
				customAgents: options.customAgents,
				...(options.agent ? {agent: options.agent} : {}),
				...(options.skillDirectories && options.skillDirectories.length > 0 ? {skillDirectories: options.skillDirectories} : {}),
				...(options.disabledSkills && options.disabledSkills.length > 0 ? {disabledSkills: options.disabledSkills} : {}),
				...(options.systemMessage
					? {systemMessage: {content: options.systemMessage}}
					: {}),
				...(this.provider ? {provider: this.provider} : {}),
				...(this.providerStreaming !== undefined ? {streaming: this.providerStreaming} : {}),
			});
			const response: AssistantMessageEvent | undefined =
				await session.sendAndWait({
					prompt: options.prompt,
					...(options.attachments && options.attachments.length > 0 ? {attachments: options.attachments} : {}),
				}, this.requestTimeout);
			return {content: response?.data.content, sessionId: session.sessionId};
		} catch (e) {
			if (this.onConnectionError && e instanceof Error && this.isConnectionError(e)) {
				this.onConnectionError(e);
			}
			throw e;
		}
	}

	// ── Error detection ────────────────────────────────────────────

	/**
	 * Detect connection/network errors (ECONNREFUSED, ENOTFOUND, fetch failures)
	 * that indicate the provider is unreachable. Avoids bare 'connect' which
	 * would false-positive on CLI spawn errors ("Could not connect to the
	 * Copilot CLI (spawn ENOENT)") or SDK session messages.
	 */
	private isConnectionError(error: Error): boolean {
		const msg = error.message.toLowerCase();
		return /econnrefused|enotfound|etimedout|econnreset|ehostunreach|fetch failed|network|socket hang up/.test(msg);
	}

	// ── Health ───────────────────────────────────────────────────────

	/** Ping the Copilot CLI server to verify connectivity. */
	async ping(): Promise<{message: string; timestamp: string; protocolVersion?: number}> {
		await this.ensureConnected();
		return await this.client!.ping();
	}

	// ── Lifecycle ───────────────────────────────────────────────────

	/**
	 * Gracefully stop the client. Falls back to forceStop on errors.
	 * Call this from the plugin's `onunload()`.
	 */
	async stop(): Promise<void> {
		if (!this.client) {
			this.state = 'disconnected';
			this.connectPromise = null;
			return;
		}
		try {
			const errors = await this.client.stop();
			if (errors.length > 0) {
				console.error('Copilot service stop errors:', errors);
				try {
					await this.client.forceStop();
				} catch (forceStopError) {
					console.error('Copilot service forceStop failed:', forceStopError);
				}
			}
		} catch (stopError) {
			console.error('Copilot service stop failed:', stopError);
			try {
				await this.client.forceStop();
			} catch (forceStopError) {
				console.error('Copilot service forceStop failed:', forceStopError);
			}
		} finally {
			this.state = 'disconnected';
			this.connectPromise = null;
		}
	}
}

export {approveAll};

export type {
	CopilotSession,
	ModelInfo,
	SessionMetadata,
	GetAuthStatusResponse,
	GetStatusResponse,
	CustomAgentConfig,
	AssistantMessageEvent,
	SessionConfig,
	MCPServerConfig,
	MCPHTTPServerConfig,
	MCPStdioServerConfig,
	SessionEvent,
	SessionEventType,
	MessageOptions,
	PermissionRequest,
	PermissionRequestResult,
	PermissionHandler,
	UserInputHandler,
	UserInputRequest,
	UserInputResponse,
	SessionListFilter,
	ProviderConfig,
	ReasoningEffort,
	ReasoningSummary,
	ContextTier,
	ElicitationHandler,
	ElicitationContext,
	ElicitationResult,
	ElicitationSchema,
	ElicitationSchemaField,
	ElicitationFieldValue,
	InfiniteSessionConfig,
};

export type {CliPathSource, ResolvedCliPath};
