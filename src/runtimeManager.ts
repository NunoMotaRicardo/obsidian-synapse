/**
 * runtime-manager — resolves the Claude CLI binary and builds a clean
 * subprocess environment.
 *
 * Kept separate from the SDK consumer so the resolution chain stands alone. This module touches only `node:*` builtins and values
 * passed in by the caller — it must NOT import `@anthropic-ai/claude-agent-sdk`.
 * `AgentService` stays the sole SDK consumer and calls into here for path
 * resolution.
 *
 * Desktop-only: Node builtins are lazy-loaded so the module stays import-safe
 * on mobile.
 */

import {nodeRequire} from './nodeRequire';

declare const __dirname: string;
declare const process: {
	platform: string;
	arch: string;
	env: Record<string, string | undefined>;
	cwd(): string;
};

// Baked in at build time by esbuild.config.mjs from the installed
// `@anthropic-ai/claude-agent-sdk` package.json — see the comment there.
// Not defined outside the esbuild bundle (e.g. under vitest), hence the
// `typeof` guard rather than a bare reference.
declare const __SYNAPSE_SDK_VERSION__: string;

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
}

/**
 * Version of `@anthropic-ai/claude-agent-sdk` this build was bundled against.
 * Compared against the resolved CLI's own `--version` output to detect skew —
 * see `getVersionSkewWarning()`. Falls back to `'unknown'` when the define
 * isn't present (e.g. running under vitest instead of the esbuild bundle).
 */
export const BUNDLED_SDK_VERSION: string =
	typeof __SYNAPSE_SDK_VERSION__ !== 'undefined' ? __SYNAPSE_SDK_VERSION__ : 'unknown';

/**
 * Extract the trailing numeric component of a dotted version string, e.g.
 * "2.1.258" -> 258. The `claude` CLI (`@anthropic-ai/claude-code`, currently
 * a `2.x` line) and the `@anthropic-ai/claude-agent-sdk` JS package (a `0.3.x`
 * line) are released from the same pipeline and share this trailing build
 * number even though their major.minor differ — it's the only part of the
 * two version schemes that's meaningfully comparable.
 */
function trailingBuildNumber(version: string): number | null {
	const parts = version.trim().split('.');
	const last = parts[parts.length - 1];
	if (!last) return null;
	const n = Number.parseInt(last, 10);
	return Number.isFinite(n) ? n : null;
}

/**
 * Compare the resolved CLI's version against the bundled SDK version and
 * return a non-blocking, human-readable skew warning, or `null` when they're
 * in sync (or a version couldn't be parsed). A newer CLI is normal — the
 * binary self-updates independently of the plugin — so this never blocks
 * anything, it's purely informational for the settings UI.
 */
export function getVersionSkewWarning(cliVersion: string, sdkVersion: string = BUNDLED_SDK_VERSION): string | null {
	if (cliVersion === 'unknown' || sdkVersion === 'unknown') return null;
	const cliBuild = trailingBuildNumber(cliVersion);
	const sdkBuild = trailingBuildNumber(sdkVersion);
	if (cliBuild === null || sdkBuild === null) return null;
	const diff = cliBuild - sdkBuild;
	if (diff === 0) return null;
	if (diff > 0) {
		return `CLI (${cliVersion}) is ${diff} release${diff === 1 ? '' : 's'} ahead of the bundled SDK (${sdkVersion}). This is expected — the CLI self-updates — but newer CLI capabilities may not be exposed yet.`;
	}
	return `Bundled SDK (${sdkVersion}) is ${-diff} release${diff === -1 ? '' : 's'} ahead of the installed CLI (${cliVersion}). Consider updating the Claude CLI.`;
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
	//    Note: we do NOT include %APPDATA%\npm\claude.cmd / claude.exe here.
	//    .cmd wrapper scripts cannot be executed by execFile() or passed as
	//    pathToClaudeCodeExecutable — they require shell: true. Instead, we
	//    detect the npm global install by probing the native package binary
	//    under %APPDATA%\npm\node_modules directly.
	const searchRoots: string[] = [];
	if (process.platform === 'win32') {
		const appData = process.env['APPDATA'];
		if (appData) {
			searchRoots.push(path.join(appData, 'npm', 'node_modules'));
		}
	} else {
		const home = process.env['HOME'];
		if (home) {
			searchRoots.push(path.join(home, '.nvm', 'versions', 'node', 'current', 'lib', 'node_modules'));
		}
		searchRoots.push('/usr/local/lib/node_modules');
		searchRoots.push('/opt/homebrew/lib/node_modules');
	}
	searchRoots.push(path.join(__dirname, 'node_modules'));
	for (const root of searchRoots) {
		candidates.push({path: path.join(root, nativePkg, `claude${ext}`), source: 'global-npm'});
		candidates.push({path: path.join(root, '@anthropic-ai', 'claude-agent-sdk', 'node_modules', nativePkg, `claude${ext}`), source: 'global-npm'});
		candidates.push({path: path.join(root, '@anthropic-ai', 'claude-code', 'node_modules', nativePkg, `claude${ext}`), source: 'global-npm'});
		candidates.push({path: path.join(root, '@anthropic-ai', 'claude-code', 'bin', `claude${ext}`), source: 'global-npm'});
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
	//    Both nested and flat paths are existence-checked. If neither exists, we
	//    return the flat path anyway so callers get a consistent "not found"
	//    error pointing at a real expected location (ensureConnected() will
	//    throw after an fs.access check of its own).
	const sdkFallbackPath = path.join(__dirname, 'node_modules', '@anthropic-ai', nativePkg, `claude${ext}`);
	const sdkFallbackNested = path.join(__dirname, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'node_modules', '@anthropic-ai', nativePkg, `claude${ext}`);
	for (const fbPath of [sdkFallbackNested, sdkFallbackPath]) {
		try {
			await fs.access(fbPath);
			return {path: fbPath, source: 'sdk-fallback'};
		} catch {
			// not found, try next
		}
	}

	// No binary found anywhere — return the canonical expected path so the
	// caller's fs.access check surfaces a clear "file not found" error.
	return {path: sdkFallbackPath, source: 'sdk-fallback'};
}

/**
 * Validate that a path is safe to pass to execFile.
 * Accepts absolute paths ending in a known binary extension (or no extension
 * on non-Windows). Rejects relative paths and unexpected extensions.
 */
function isSafeBinaryPath(binaryPath: string): boolean {
	// Must be an absolute path
	if (!binaryPath || binaryPath.trim() !== binaryPath) return false;
	// Basic absoluteness check without importing path (may not be loaded yet)
	const isAbsolute = binaryPath.startsWith('/') ||
		// Windows: drive letter (C:\) or UNC (\\server)
		/^[A-Za-z]:[\\/]/.test(binaryPath) ||
		binaryPath.startsWith('\\\\');
	if (!isAbsolute) return false;
	// Extension allowlist: .exe, .cmd (cmd is accepted here since we only read
	// version output, but the SDK call path rejects .cmd separately), or none.
	// Reject .sh, .bat, .ps1, .vbs etc. that could be shell-script attacks.
	const ALLOWED_EXT = /(\.exe|\.cmd)?$/i;
	const ext = binaryPath.match(/\.[^./\\]*$/)?.[0]?.toLowerCase() ?? '';
	if (ext && !['', '.exe', '.cmd'].includes(ext)) return false;
	return ALLOWED_EXT.test(binaryPath);
}

/**
 * Check and return the version and protocol version of the resolved CLI binary.
 *
 * Security: `binaryPath` is validated by `isSafeBinaryPath` before execution.
 * Only absolute paths with expected binary extensions are accepted.
 */
export async function getCliVersion(binaryPath: string): Promise<{version: string}> {
	// Validate the path before executing to guard against user-controlled input
	// (claudeLocation setting) being passed to a subprocess.
	if (!isSafeBinaryPath(binaryPath)) {
		return {version: 'unknown'};
	}
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
			resolve({version});
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
		'GITHUB_', 'GH_', 'CLAUDE_', 'ANTHROPIC_',
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
