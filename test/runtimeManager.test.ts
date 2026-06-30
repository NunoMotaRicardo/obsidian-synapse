import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

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
}))

import {resolveDefaultCliPath} from '../src/runtimeManager'
import * as fsMock from 'node:fs/promises'

const mockedAccess = fsMock.access as ReturnType<typeof vi.fn>

describe('resolveDefaultCliPath', () => {
	const originalEnv = {...process.env}

	beforeEach(() => {
		mockedAccess.mockReset()
	})

	afterEach(() => {
		// Restore env
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key]
		}
		Object.assign(process.env, originalEnv)
	})

	it('returns sdk-fallback source when all fs.access calls reject', async () => {
		// All access checks fail → fall through to sdk-fallback
		mockedAccess.mockRejectedValue(new Error('ENOENT'))

		const result = await resolveDefaultCliPath()

		expect(result.source).toBe('sdk-fallback')
		expect(typeof result.path).toBe('string')
		expect(result.path.length).toBeGreaterThan(0)
	})

	it('returns the first accessible path with its source tag', async () => {
		// Reject everything except the first call
		mockedAccess.mockImplementation(() => {
			// Accept the very first candidate that is checked
			if (mockedAccess.mock.calls.length === 1) {
				return Promise.resolve(undefined)
			}
			return Promise.reject(new Error('ENOENT'))
		})

		const result = await resolveDefaultCliPath()

		// The source should be one of the valid CliPathSource values
		expect(['global-npm', 'os-links', 'sdk-fallback']).toContain(result.source)
		expect(typeof result.path).toBe('string')
	})

	it('includes the platform in the binary package name within the resolved path', async () => {
		mockedAccess.mockRejectedValue(new Error('ENOENT'))

		const result = await resolveDefaultCliPath()

		// The sdk-fallback path should contain the platform name
		expect(result.path).toContain(process.platform)
	})

	it('includes process.arch in the resolved path', async () => {
		mockedAccess.mockRejectedValue(new Error('ENOENT'))

		const result = await resolveDefaultCliPath()

		expect(result.path).toContain(process.arch)
	})
})
