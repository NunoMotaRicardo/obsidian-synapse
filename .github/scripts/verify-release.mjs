import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const REQUIRED_ASSETS = ['main.js', 'manifest.json', 'styles.css']
const SEMVER_TAG = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?$/

function fail(message) {
	throw new Error(message)
}

function parseArgs(args) {
	const options = { assetsDir: '.', sourceDir: '.', tag: undefined, writeReport: undefined, expectedReport: undefined, expectedCommit: undefined }
	for (let index = 0; index < args.length; index += 1) {
		const option = args[index]
		const value = args[index + 1]
		if (!['--assets-dir', '--source-dir', '--tag', '--write-report', '--expected-report', '--expected-commit'].includes(option) || value === undefined) {
			fail('Usage: node .github/scripts/verify-release.mjs --tag <non-v-semver> [--assets-dir <dir>] [--source-dir <dir>] [--write-report <file>] [--expected-report <file>] [--expected-commit <commit>]')
		}
		if (option === '--assets-dir') options.assetsDir = value
		if (option === '--source-dir') options.sourceDir = value
		if (option === '--tag') options.tag = value
		if (option === '--write-report') options.writeReport = value
		if (option === '--expected-report') options.expectedReport = value
		if (option === '--expected-commit') options.expectedCommit = value
		index += 1
	}
	if (!options.tag || !SEMVER_TAG.test(options.tag)) {
		fail(`Release tag must be an exact non-v semantic version; received ${options.tag ?? '(missing)'}`)
	}
	return options
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'))
	} catch (error) {
		fail(`Could not read JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`)
	}
}

function hashFile(path) {
	return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function resolveCommit(sourceDir, revision, label) {
	try {
		return execFileSync('git', ['rev-parse', `${revision}^{commit}`], { cwd: sourceDir, encoding: 'utf8' }).trim()
	} catch {
		fail(`Could not resolve ${label} to a commit in ${sourceDir}`)
	}
}

function getCommit(sourceDir) {
	return resolveCommit(sourceDir, 'HEAD', 'checked-out HEAD')
}

function verifyChangelog(sourceDir, version) {
	const changelog = readFileSync(join(sourceDir, 'CHANGELOG.md'), 'utf8')
	const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const heading = new RegExp(`^##\\s+\\[?${escapedVersion}\\]?(?:\\s|$)`, 'm')
	if (!heading.test(changelog)) fail(`CHANGELOG.md has no section for ${version}`)
}

function verifyMetadata(sourceDir, tag) {
	const manifest = readJson(join(sourceDir, 'manifest.json'))
	const packageJson = readJson(join(sourceDir, 'package.json'))
	const versions = readJson(join(sourceDir, 'versions.json'))
	if (manifest.version !== tag) fail(`manifest.json version ${manifest.version} does not match tag ${tag}`)
	if (packageJson.version !== tag) fail(`package.json version ${packageJson.version} does not match tag ${tag}`)
	if (versions[tag] !== manifest.minAppVersion) {
		fail(`versions.json must map ${tag} to manifest minAppVersion ${manifest.minAppVersion}`)
	}
	verifyChangelog(sourceDir, tag)
	return manifest
}

function verifyAssets(assetsDir) {
	const files = REQUIRED_ASSETS.map((name) => {
		const path = join(assetsDir, name)
		if (!existsSync(path) || !statSync(path).isFile()) fail(`Missing required release asset: ${name}`)
		const size = statSync(path).size
		if (size === 0) fail(`Release asset is empty: ${name}`)
		return { name, size, sha256: hashFile(path) }
	})
	const manifest = readJson(join(assetsDir, 'manifest.json'))
	return { files, manifest }
}

function verifyExpectedReport(expectedReportPath, files, metadata) {
	const expected = readJson(expectedReportPath)
	if (expected.tag !== metadata.tag || expected.manifestVersion !== metadata.manifestVersion || expected.minAppVersion !== metadata.minAppVersion) {
		fail(`Release metadata does not match the generated verification report ${basename(expectedReportPath)}`)
	}
	if (expected.sourceCommit && metadata.sourceCommit && expected.sourceCommit !== metadata.sourceCommit) {
		fail(`Release source commit does not match the generated verification report ${basename(expectedReportPath)}`)
	}
	const expectedFiles = new Map(expected.assets?.map((asset) => [asset.name, asset]))
	for (const file of files) {
		const expectedFile = expectedFiles.get(file.name)
		if (!expectedFile || expectedFile.sha256 !== file.sha256 || expectedFile.size !== file.size) {
			fail(`Downloaded ${file.name} does not match the generated release asset recorded in ${basename(expectedReportPath)}`)
		}
	}
}

try {
	const options = parseArgs(process.argv.slice(2))
	const sourceDir = resolve(options.sourceDir)
	const assetsDir = resolve(options.assetsDir)
	const sourceManifest = verifyMetadata(sourceDir, options.tag)
	const sourceCommit = getCommit(sourceDir)
	if (options.expectedCommit && sourceCommit !== resolveCommit(sourceDir, options.expectedCommit, 'expected release commit')) {
		fail(`Checked-out commit ${sourceCommit} does not match expected release commit ${options.expectedCommit}`)
	}
	if (process.env.GITHUB_SHA) {
		const eventCommit = resolveCommit(sourceDir, process.env.GITHUB_SHA, 'GITHUB_SHA')
		if (eventCommit !== sourceCommit) {
			fail(`Checked-out commit ${sourceCommit} does not match GITHUB_SHA commit ${eventCommit}`)
		}
	}
	const { files, manifest: assetManifest } = verifyAssets(assetsDir)
	if (assetManifest.version !== sourceManifest.version) {
		fail(`Release manifest version ${assetManifest.version} does not match source manifest version ${sourceManifest.version}`)
	}
	if (options.expectedReport) {
		verifyExpectedReport(resolve(options.expectedReport), files, {
			tag: options.tag,
			manifestVersion: sourceManifest.version,
			minAppVersion: sourceManifest.minAppVersion,
			sourceCommit,
		})
	}

	const report = {
		tag: options.tag,
		sourceCommit,
		manifestVersion: sourceManifest.version,
		minAppVersion: sourceManifest.minAppVersion,
		assets: files,
	}
	if (options.writeReport) writeFileSync(resolve(options.writeReport), `${JSON.stringify(report, null, '\t')}\n`)
	console.log(JSON.stringify(report, null, '\t'))
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error))
	process.exit(1)
}
