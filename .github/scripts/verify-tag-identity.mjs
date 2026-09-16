import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

function fail(message) {
	throw new Error(message)
}

function command(command, args, options = {}) {
	return execFileSync(command, args, { encoding: 'utf8', ...options }).trim()
}

function githubApi(endpoint) {
	return JSON.parse(command('gh', ['api', endpoint]))
}

function peelGitHubTag(repository, tag) {
	let object = githubApi(`repos/${repository}/git/ref/tags/${tag}`).object
	while (object.type === 'tag') {
		object = githubApi(`repos/${repository}/git/tags/${object.sha}`).object
	}
	if (object.type !== 'commit') fail(`Tag ${tag} resolves to ${object.type}, not a commit`)
	return object.sha
}

function resolveLocalCommit(revision) {
	return command('git', ['rev-parse', `${revision}^{commit}`])
}

try {
	const repository = process.env.GITHUB_REPOSITORY
	const tag = process.env.GITHUB_REF_NAME
	const eventSha = process.env.GITHUB_SHA
	if (!repository || !tag || !eventSha) fail('GITHUB_REPOSITORY, GITHUB_REF_NAME, and GITHUB_SHA are required')

	const verifiedCommit = peelGitHubTag(repository, tag)
	command('git', ['fetch', '--no-tags', 'origin', `+refs/tags/${tag}:refs/tags/${tag}`])
	const localTagCommit = resolveLocalCommit(`refs/tags/${tag}`)
	const eventCommit = resolveLocalCommit(eventSha)
	if (localTagCommit !== verifiedCommit || eventCommit !== verifiedCommit) {
		fail(`Tag/event identity mismatch: API=${verifiedCommit}, local-tag=${localTagCommit}, event=${eventCommit}`)
	}

	command('git', ['checkout', '--detach', verifiedCommit])
	const checkedOutCommit = resolveLocalCommit('HEAD')
	if (checkedOutCommit !== verifiedCommit) fail(`Checked-out commit ${checkedOutCommit} does not match tag commit ${verifiedCommit}`)

	const defaultBranch = githubApi(`repos/${repository}`).default_branch
	command('git', ['fetch', '--no-tags', 'origin', `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`])
	const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', verifiedCommit, `refs/remotes/origin/${defaultBranch}`])
	if (ancestry.status !== 0) fail(`Tag commit ${verifiedCommit} is not contained in origin/${defaultBranch}`)

	if (process.env.GITHUB_ENV) {
		appendFileSync(process.env.GITHUB_ENV, `VERIFIED_COMMIT=${verifiedCommit}\nDEFAULT_BRANCH=${defaultBranch}\n`)
	}
	console.log(JSON.stringify({ tag, verifiedCommit, defaultBranch }))
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error))
	process.exit(1)
}
