import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';

const root = resolve(import.meta.dirname, '..');
const verifier = resolve(root, '.github/scripts/verify-release.mjs');
const releaseWorkflow = resolve(root, '.github/workflows/release.yml');
const tagIdentityVerifier = resolve(root, '.github/scripts/verify-tag-identity.mjs');
const packageMetadata = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {version: string};
const releaseVersion = packageMetadata.version;

function runVerifier(args: string[], environment: NodeJS.ProcessEnv = {}): string {
	return execFileSync(process.execPath, [verifier, ...args], {
		cwd: root,
		encoding: 'utf8',
		env: {...process.env, ...environment},
	});
}

describe('release verification', () => {
	it('rejects v-prefixed tags before a release can be created', () => {
		expect(() => runVerifier(['--tag', `v${releaseVersion}`])).toThrow(/exact non-v semantic version/);
	});

	it('derives the source commit from git instead of trusting GITHUB_SHA', () => {
		expect(() => runVerifier(['--tag', releaseVersion], {GITHUB_SHA: '0000000000000000000000000000000000000000'})).toThrow(/GITHUB_SHA/);
	});

	it('records deterministic hashes for the required release assets', () => {
		const report = JSON.parse(runVerifier(['--tag', releaseVersion])) as {
			tag: string;
			sourceCommit: string | null;
			assets: Array<{name: string; sha256: string; size: number}>;
		};
		expect(report.tag).toBe(releaseVersion);
		expect(report.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
		expect(report.assets.map(({name}) => name)).toEqual(['main.js', 'manifest.json', 'styles.css']);
		for (const asset of report.assets) {
			expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
			expect(asset.size).toBeGreaterThan(0);
		}
	});

	it('handles annotated and lightweight tag identities before requiring default-branch ancestry', () => {
		const identityVerifier = readFileSync(tagIdentityVerifier, 'utf8');
		expect(identityVerifier).toContain("while (object.type === 'tag')");
		expect(identityVerifier).toContain('repos/${repository}/git/ref/tags/${tag}');
		expect(identityVerifier).toContain("['rev-parse', `${revision}^{commit}`]");
		expect(identityVerifier).toContain("['merge-base', '--is-ancestor', verifiedCommit, `refs/remotes/origin/${defaultBranch}`]");
		expect(identityVerifier).toContain('Tag/event identity mismatch');
		expect(identityVerifier).toContain('Checked-out commit ${checkedOutCommit} does not match tag commit ${verifiedCommit}');
	});

	it('separates read-only validation from retry-safe publication', () => {
		const workflow = readFileSync(releaseWorkflow, 'utf8');
		const validationJob = workflow.indexOf('validate-build:');
		const publishJob = workflow.indexOf('\n    publish:');
		const validation = workflow.slice(validationJob, publishJob);
		const publish = workflow.slice(publishJob);
		expect(validationJob).toBeGreaterThan(-1);
		expect(publishJob).toBeGreaterThan(validationJob);
		expect(validation).toContain('contents: read');
		expect(validation).not.toContain('contents: write');
		expect(validation).toContain('persist-credentials: false');
		expect(publish).toContain('contents: write');
		expect(publish).toContain('persist-credentials: false');
		expect(workflow).toContain('verified-release-build-${{ github.ref_name }}');
		expect(publish).toContain('Re-verify downloaded build artifact');
		expect(workflow).toContain('verify-tag-identity.mjs');
		expect(workflow).toContain('fetch-depth: 0');
		expect(workflow).toContain('--expected-commit "${VERIFIED_COMMIT}"');
		expect(workflow).toContain('concurrency:');
		expect(workflow).toContain('group: release-${{ github.workflow }}-${{ github.ref_name }}');
		expect(workflow).toContain('cancel-in-progress: false');
	});

	it('publishes only verified exact assets and cleans up only its own failed draft', () => {
		const workflow = readFileSync(releaseWorkflow, 'utf8');
		const draft = workflow.indexOf('Create and own this run\'s draft release through the REST API');
		const verify = workflow.indexOf('Verify uploaded draft assets through the captured release ID');
		const evidence = workflow.indexOf('Preserve publication verification evidence');
		const publish = workflow.indexOf('Publish this captured verified release through the REST API');
		expect(draft).toBeGreaterThan(-1);
		expect(verify).toBeGreaterThan(draft);
		expect(evidence).toBeGreaterThan(verify);
		expect(publish).toBeGreaterThan(evidence);
		expect(workflow).toContain('for asset in main.js manifest.json styles.css');
		expect(workflow).toContain('gh api --method POST "repos/${GITHUB_REPOSITORY}/releases"');
		expect(workflow).toContain('-f target_commitish="${VERIFIED_COMMIT}"');
		expect(workflow).toContain('upload_url="$(printf \'%s\' "$draft_response" | jq -r .upload_url)"');
		expect(workflow).toContain('expected_upload_url="https://uploads.github.com/repos/${GITHUB_REPOSITORY}/releases/${draft_id}/assets"');
		expect(workflow).toContain('test "$upload_url" = "$expected_upload_url"');
		expect(workflow).toContain("curl --fail-with-body --silent --show-error --proto '=https'");
		expect(workflow).toContain('--url "${DRAFT_UPLOAD_URL}?name=${asset}"');
		expect(workflow).toContain('--header "Authorization: Bearer ${GITHUB_TOKEN}"');
		expect(workflow).toContain('--data-binary "@${asset}"');
		expect(workflow).toContain('releases/assets/${asset_id}');
		expect(workflow).not.toContain('--hostname uploads.github.com');
		expect(workflow).toContain('--expected-report release-verification.json');
		expect(workflow).toContain('CREATED_DRAFT=true');
		expect(workflow).toContain('DRAFT_RELEASE_ID=${draft_id}');
		expect(workflow).toContain('env.CREATED_DRAFT == \'true\'');
		expect(workflow).toContain('gh api --method PATCH "repos/${GITHUB_REPOSITORY}/releases/${DRAFT_RELEASE_ID}" -F draft=false');
		expect(workflow).toContain('gh api --method DELETE "repos/${GITHUB_REPOSITORY}/releases/${DRAFT_RELEASE_ID}"');
		expect(workflow).not.toContain('gh release create');
		expect(workflow).not.toContain('gh release edit');
		expect(workflow).not.toContain('gh release download');
	});
});
