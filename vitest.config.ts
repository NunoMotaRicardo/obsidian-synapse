import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
		setupFiles: ['./test/setup.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'html', 'json-summary'],
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.d.ts'],
			// No thresholds configured: the baseline is unknown, and a failing gate
			// on day one is worse than no gate. Report the number first (#146).
		},
	},
});
