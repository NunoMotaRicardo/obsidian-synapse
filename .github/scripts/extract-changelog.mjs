// Extracts the release-notes body for a given version from CHANGELOG.md.
//
// CHANGELOG.md follows Keep a Changelog: each version has its own
// "## [x.y.z]" (or "## x.y.z") heading, with content up to the next "## "
// heading. Used by .github/workflows/release.yml to generate GitHub release
// notes straight from the changelog instead of duplicating them in the
// workflow or typing them by hand at tag time.
import { readFileSync } from 'fs'

const version = process.argv[2]
if (!version) {
	console.error('Usage: node extract-changelog.mjs <version>')
	process.exit(1)
}

const changelog = readFileSync('CHANGELOG.md', 'utf8')
const lines = changelog.split('\n')

const headingPattern = new RegExp(`^##\\s+\\[?${version.replace(/\./g, '\\.')}\\]?\\b`)
const nextHeadingPattern = /^##\s+/

let start = -1
for (let i = 0; i < lines.length; i++) {
	if (headingPattern.test(lines[i])) {
		start = i + 1
		break
	}
}

if (start === -1) {
	console.error(`No CHANGELOG.md section found for version ${version}`)
	process.exit(1)
}

let end = lines.length
for (let i = start; i < lines.length; i++) {
	if (nextHeadingPattern.test(lines[i])) {
		end = i
		break
	}
}

const section = lines
	.slice(start, end)
	.join('\n')
	.trim()

if (!section) {
	console.error(`CHANGELOG.md section for version ${version} is empty`)
	process.exit(1)
}

console.log(section)
