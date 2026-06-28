/**
 * runtime-manager — resolves the Copilot CLI binary and builds a clean
 * subprocess environment.
 *
 * Extracted from `src/copilot.ts` so the resolution chain stays separate from
 * the SDK consumer. This module touches only `node:*` builtins and values
 * passed in by the caller — it must NOT import `@github/copilot-sdk`.
 * `CopilotService` stays the sole SDK consumer and calls into here for path
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
	| 'winget'
	| 'js-fallback';

/** A resolved CLI binary path together with the chain step it came from. */
export interface ResolvedCliPath {
	path: string;
	source: CliPathSource;
}

/**
 * Resolve the platform-specific Copilot native binary, in priority order:
 *   1. global npm prefix (`%APPDATA%\npm\node_modules`) + the vestigial
 *      `__dirname/node_modules` search root,
 *   2. WinGet Links (Windows only),
 *   3. the JS CLI entry point fallback.
 *
 * The explicit settings path (`copilotLocation`) is handled by the caller and
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
	const nativePkg = `@github/copilot-${process.platform}-${process.arch}`;

	// Each candidate is tagged with the chain step it represents so the caller
	// (and settings UI) can report where the binary came from.
	const candidates: {path: string; source: CliPathSource}[] = [];

	// 1. Global npm prefix (Windows) + the vestigial __dirname/node_modules root.
	const searchRoots: string[] = [];
	if (process.platform === 'win32') {
		const appData = process.env['APPDATA'];
		if (appData) {
			searchRoots.push(path.join(appData, 'npm', 'node_modules'));
		}
	}
	searchRoots.push(path.join(__dirname, 'node_modules'));
	for (const root of searchRoots) {
		// The native binary may be a direct dependency or nested under
		// @github/copilot/node_modules (e.g. global npm installs on Windows).
		candidates.push({path: path.join(root, nativePkg, `copilot${ext}`), source: 'global-npm'});
		candidates.push({path: path.join(root, '@github', 'copilot', 'node_modules', nativePkg, `copilot${ext}`), source: 'global-npm'});
	}

	// 2. WinGet Links (Windows only).
	if (process.platform === 'win32') {
		const localAppData = process.env['LOCALAPPDATA'];
		if (localAppData) {
			candidates.push({path: path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'copilot.exe'), source: 'winget'});
		}
	}

	for (const candidate of candidates) {
		try {
			await fs.access(candidate.path);
			return candidate;
		} catch {
			// not found, continue
		}
	}

	// 3. Fallback to the JS CLI entry point.
	const fallback = path.join(__dirname, 'node_modules', '@github', 'copilot', 'index.js');
	return {path: fallback, source: 'js-fallback'};
}

/**
 * Build a clean environment for the Copilot CLI subprocess.
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
		'GITHUB_', 'GH_', 'COPILOT_',
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
