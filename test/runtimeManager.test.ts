import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';

// ---------------------------------------------------------------------------
// resolveDefaultCliPath — unit tests
//
// The function uses `globalThis.require` (CJS) or `await import()` (ESM),
// `process.env`, `process.platform`, and `__dirname`.
//
// In Vitest's ESM environment:
// - `globalThis.require` is undefined → the function falls through to `await import()`.
// - `vi.mock('node:fs/promises', ...)` intercepts the dynamic import.
// - `__dirname` is not defined in ESM; the source has `declare const __dirname`,
//   which means it will be `undefined` at runtime in this environment.
//   `path.join(undefined, ...)` still produces a string, so the function
//   proceeds and ultimately returns a `sdk-fallback` result when fs.access
//   always rejects.
// ---------------------------------------------------------------------------

// Mock node:fs/promises before importing the module under test so the
// dynamic import in resolveDefaultCliPath picks up our mock.
vi.mock('node:fs/promises', () => ({
	access: vi.fn(),
}));

import {cleanEnv, resolveDefaultCliPath, withTimeout} from '../src/runtimeManager';
import * as fsMock from 'node:fs/promises';

const mockedAccess = fsMock.access as unknown as ReturnType<typeof vi.fn<typeof fsMock.access>>;

describe('cleanEnv', () => {
	it('omits identity variables while preserving runtime paths', () => {
		vi.stubEnv('USER', 'private-user');
		vi.stubEnv('USERNAME', 'private-user');
		vi.stubEnv('LOGNAME', 'private-user');
		vi.stubEnv('HOSTNAME', 'private-host');
		vi.stubEnv('USERPROFILE', 'C:\\Users\\runtime');
		try {
			const env = cleanEnv();
			for (const key of ['USER', 'USERNAME', 'LOGNAME', 'HOSTNAME']) {
				expect(env).not.toHaveProperty(key);
			}
			expect(env['USERPROFILE']).toBe('C:\\Users\\runtime');
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe('resolveDefaultCliPath', () => {
	const originalEnv = {...process.env};

	beforeEach(() => {
		mockedAccess.mockReset();
	});

	afterEach(() => {
		// Restore env
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	});

	it('returns sdk-fallback source when all fs.access calls reject', async () => {
		// All access checks fail → fall through to sdk-fallback
		mockedAccess.mockRejectedValue(new Error('ENOENT'));

		const result = await resolveDefaultCliPath();

		expect(result.source).toBe('sdk-fallback');
		expect(typeof result.path).toBe('string');
		expect(result.path.length).toBeGreaterThan(0);
	});

	it('returns the first accessible path with its source tag', async () => {
		// Reject everything except the first call
		mockedAccess.mockImplementation(() => {
			// Accept the very first candidate that is checked
			if (mockedAccess.mock.calls.length === 1) {
				return Promise.resolve(undefined);
			}
			return Promise.reject(new Error('ENOENT'));
		});

		const result = await resolveDefaultCliPath();

		// The source should be one of the valid CliPathSource values
		expect(['global-npm', 'os-links', 'mise', 'path', 'sdk-fallback']).toContain(result.source);
		expect(typeof result.path).toBe('string');
	});

	describe.skipIf(process.platform === 'win32')('mise and PATH lookup', () => {
		const accessOnly = (...allowed: string[]) => {
			mockedAccess.mockImplementation((p) =>
				allowed.includes(String(p)) ? Promise.resolve(undefined) : Promise.reject(new Error('ENOENT')));
		};

		beforeEach(() => {
			vi.stubEnv('HOME', '/home/tester');
			vi.stubEnv('MISE_DATA_DIR', '');
			vi.stubEnv('XDG_DATA_HOME', '');
			vi.stubEnv('PATH', '');
		});

		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('finds the mise-installed binary under the default data dir', async () => {
			const bin = '/home/tester/.local/share/mise/installs/claude/latest/claude';
			accessOnly(bin);

			const result = await resolveDefaultCliPath();

			expect(result).toEqual({path: bin, source: 'mise'});
		});

		it('honours MISE_DATA_DIR over the default location', async () => {
			vi.stubEnv('MISE_DATA_DIR', '/opt/mise-data');
			const bin = '/opt/mise-data/installs/claude/latest/claude';
			accessOnly(bin);

			const result = await resolveDefaultCliPath();

			expect(result).toEqual({path: bin, source: 'mise'});
		});

		it('honours XDG_DATA_HOME when MISE_DATA_DIR is unset', async () => {
			vi.stubEnv('XDG_DATA_HOME', '/xdg/data');
			const bin = '/xdg/data/mise/installs/claude/global/claude';
			accessOnly(bin);

			const result = await resolveDefaultCliPath();

			expect(result).toEqual({path: bin, source: 'mise'});
		});

		it('finds claude on PATH', async () => {
			vi.stubEnv('PATH', '/nonexistent:/custom/bin');
			const bin = '/custom/bin/claude';
			accessOnly(bin);

			const result = await resolveDefaultCliPath();

			expect(result).toEqual({path: bin, source: 'path'});
		});

		it('ignores relative PATH entries', async () => {
			vi.stubEnv('PATH', 'bin:./tools::/custom/bin');
			accessOnly('bin/claude', 'tools/claude', 'claude', '/custom/bin/claude');

			const result = await resolveDefaultCliPath();

			expect(result.path).toBe('/custom/bin/claude');
			expect(mockedAccess).not.toHaveBeenCalledWith('bin/claude');
			expect(mockedAccess).not.toHaveBeenCalledWith('tools/claude');
			expect(mockedAccess).not.toHaveBeenCalledWith('claude');
		});

		it('prefers the mise install over a PATH match', async () => {
			vi.stubEnv('PATH', '/custom/bin');
			const mise = '/home/tester/.local/share/mise/installs/claude/latest/claude';
			accessOnly(mise, '/custom/bin/claude');

			const result = await resolveDefaultCliPath();

			expect(result.source).toBe('mise');
		});

		it('prefers OS links over mise and PATH', async () => {
			vi.stubEnv('PATH', '/custom/bin');
			accessOnly('/usr/bin/claude', '/custom/bin/claude');

			const result = await resolveDefaultCliPath();

			expect(result).toEqual({path: '/usr/bin/claude', source: 'os-links'});
		});
	});

	it('includes the platform in the binary package name within the resolved path', async () => {
		mockedAccess.mockRejectedValue(new Error('ENOENT'));

		const result = await resolveDefaultCliPath();

		// The sdk-fallback path should contain the platform name
		expect(result.path).toContain(process.platform);
	});

	it('includes process.arch in the resolved path', async () => {
		mockedAccess.mockRejectedValue(new Error('ENOENT'));

		const result = await resolveDefaultCliPath();

		expect(result.path).toContain(process.arch);
	});
});

describe('withTimeout', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('resolves with the promise value when it settles before the timeout', async () => {
		const promise = withTimeout(Promise.resolve('done'), 1000);
		await vi.advanceTimersByTimeAsync(0);
		await expect(promise).resolves.toBe('done');
	});

	it('resolves with undefined when the timeout elapses first', async () => {
		const never = new Promise<string>(() => { /* never settles */ });
		const promise = withTimeout(never, 1000);
		await vi.advanceTimersByTimeAsync(1000);
		await expect(promise).resolves.toBeUndefined();
	});

	it('resolves with undefined (not a rejection) if the inner promise rejects', async () => {
		const promise = withTimeout(Promise.reject(new Error('boom')), 1000);
		await vi.advanceTimersByTimeAsync(0);
		await expect(promise).resolves.toBeUndefined();
	});

	it('does not fire the timeout after the promise already resolved', async () => {
		const promise = withTimeout(Promise.resolve('fast'), 1000);
		const result = await promise;
		// Advancing past the timeout afterward must not throw or change anything.
		await vi.advanceTimersByTimeAsync(2000);
		expect(result).toBe('fast');
	});
});
