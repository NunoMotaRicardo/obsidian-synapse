/**
 * runtime-manager — resolves the Claude CLI binary and builds a clean
 * subprocess environment.
 *
 * Extracted from `src/copilot.ts` so the resolution chain stays separate from
 * the SDK consumer. This module touches only `node:*` builtins and values
 * passed in by the caller — it must NOT import `@anthropic-ai/claude-agent-sdk`.
 * `AgentService` stays the sole SDK consumer and calls into here for path
 * resolution.
 *
 * Desktop-only: Node builtins are lazy-loaded so the module stays import-safe
 * on mobile.
 */

// Available at runtime in the esbuild CJS bundle.
const nodeRequire = typeof globalThis.require === 'function' ? globalThis.require : undefined;
declare const __dirname: string;
declare const process: {
	platform: string;
	arch: string;
	env: Record<string, string | undefined>;
	cwd(): string;
};

/** Which step of the resolution chain produced the resolved binary path. */
export type CliPathSource =
	| 'settings'
	| 'global-npm'
	| 'os-links'
	| 'sdk-fallback';

/** A resolved CLI binary path together with the chain step it came from. */
export interface ResolvedCliPath {
	path: string;
	source: CliPathSource;
	version?: string;
	protocolVersion?: string;
}

/**
 * Resolve the platform-specific Claude native binary, in priority order:
 *   1. global npm prefix (`%APPDATA%\npm\node_modules` or global npm binaries) + `__dirname/node_modules`,
 *   2. OS links (WinGet links, ~/.claude/bin, /usr/local/bin, etc.),
 *   3. SDK fallback package binary (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude(.exe)`).
 *
 * The explicit settings path (`claudeLocation`) is handled by the caller and
 * is not part of this function — when set it short-circuits resolution
 * entirely.
 *
 * Returns the resolved path and which chain step produced it.
 */
export async function resolveDefaultCliPath(): Promise<ResolvedCliPath> {
	// Lazy-load Node.js builtins so the module can be imported on mobile
	const path = nodeRequire?.('node:path') as typeof import('node:path') ?? await import('node:path');
	const fs = nodeRequire?.('node:fs/promises') as typeof import('node:fs/promises') ?? await import('node:fs/promises');

	const ext = process.platform === 'win32' ? '.exe' : '';
	const nativePkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;

	// Each candidate is tagged with the chain step it represents so the caller
	// (and settings UI) can report where the binary came from.
	const candidates: {path: string; source: CliPathSource}[] = [];

	// 1. Global npm prefix (Windows) + the __dirname/node_modules search root.
	const searchRoots: string[] = [];
	if (process.platform === 'win32') {
		const appData = process.env['APPDATA'];
		if (appData) {
			searchRoots.push(path.join(appData, 'npm', 'node_modules'));
			candidates.push({path: path.join(appData, 'npm', 'claude.cmd'), source: 'global-npm'});
			candidates.push({path: path.join(appData, 'npm', 'claude.exe'), source: 'global-npm'});
			candidates.push({path: path.join(appData, 'npm', 'claude'), source: 'global-npm'});
		}
	}
	searchRoots.push(path.join(__dirname, 'node_modules'));
	for (const root of searchRoots) {
		candidates.push({path: path.join(root, nativePkg, `claude${ext}`), source: 'global-npm'});
		candidates.push({path: path.join(root, '@anthropic-ai', 'claude-agent-sdk', 'node_modules', nativePkg, `claude${ext}`), source: 'global-npm'});
		candidates.push({path: path.join(root, '@anthropic-ai', 'claude-code', 'node_modules', nativePkg, `claude${ext}`), source: 'global-npm'});
	}

	for (const candidate of candidates) {
		try {
			await fs.access(candidate.path);
			return candidate;
		} catch {
			// not found, continue
		}
	}

	// 2. OS links.
	const osCandidates: {path: string; source: CliPathSource}[] = [];
	if (process.platform === 'win32') {
		const localAppData = process.env['LOCALAPPDATA'];
		if (localAppData) {
			osCandidates.push({path: path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'claude.exe'), source: 'os-links'});
		}
		const userProfile = process.env['USERPROFILE'];
		if (userProfile) {
			osCandidates.push({path: path.join(userProfile, '.claude', 'bin', 'claude.exe'), source: 'os-links'});
			osCandidates.push({path: path.join(userProfile, '.claude', 'bin', 'claude'), source: 'os-links'});
		}
	} else {
		osCandidates.push({path: '/usr/local/bin/claude', source: 'os-links'});
		osCandidates.push({path: '/usr/bin/claude', source: 'os-links'});
		const home = process.env['HOME'];
		if (home) {
			osCandidates.push({path: path.join(home, '.local', 'bin', 'claude'), source: 'os-links'});
			osCandidates.push({path: path.join(home, '.claude', 'bin', 'claude'), source: 'os-links'});
		}
	}

	for (const candidate of osCandidates) {
		try {
			await fs.access(candidate.path);
			return candidate;
		} catch {
			// not found, continue
		}
	}

	// 3. Fallback to SDK native package binary.
	const sdkFallbackPath = path.join(__dirname, 'node_modules', '@anthropic-ai', nativePkg, `claude${ext}`);
	const sdkFallbackNested = path.join(__dirname, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'node_modules', '@anthropic-ai', nativePkg, `claude${ext}`);
	try {
		await fs.access(sdkFallbackNested);
		return {path: sdkFallbackNested, source: 'sdk-fallback'};
	} catch {
		// return default fallback path
	}

	return {path: sdkFallbackPath, source: 'sdk-fallback'};
}

/**
 * Check and return the version and protocol version of the resolved CLI binary.
 */
export async function getCliVersion(binaryPath: string): Promise<{version: string; protocolVersion?: string}> {
	const childProcess = nodeRequire?.('node:child_process') as typeof import('node:child_process') ?? await import('node:child_process');
	return new Promise((resolve) => {
		childProcess.execFile(binaryPath, ['--version'], {timeout: 5000}, (error, stdout) => {
			if (error || !stdout) {
				resolve({version: 'unknown'});
				return;
			}
			const trimmed = stdout.trim();
			// E.g. "2.1.195 (Claude Code)" -> "2.1.195"
			const match = trimmed.match(/(\d+\.\d+\.\d+)/);
			const version = match ? match[1]! : trimmed;
			// Protocol version for Claude Agent SDK stream is protocol 1
			resolve({version, protocolVersion: '1'});
		});
	});
}

/**
 * Build a clean environment for the Claude CLI subprocess.
 * Uses an allowlist of safe, well-known environment variables
 * to avoid leaking sensitive or Electron-specific values.
 */
export function cleanEnv(): Record<string, string> {
	const ALLOWED_PREFIXES = [
		'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP',
		'LANG', 'LC_', 'SHELL', 'TERM', 'COLORTERM',
		'USER', 'USERNAME', 'LOGNAME', 'HOSTNAME',
		'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PROGRAMFILES',
		'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
		'XDG_', 'DISPLAY', 'WAYLAND_DISPLAY',
		'NODE_', 'NPM_', 'NVM_',
		'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
		'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
		'GITHUB_', 'GH_', 'COPILOT_', 'CLAUDE_', 'ANTHROPIC_',
		'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
	];
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (ALLOWED_PREFIXES.some(prefix => key === prefix || key.startsWith(prefix))) {
			env[key] = value;
		}
	}
	return env;
}
