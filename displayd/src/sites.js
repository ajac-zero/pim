// The sites whose signed-in access is limited to a number of displays at a time, so a person's
// account is not seen from several places at once. A file of {"<site>": {"max": 1, "domains": [...]}}:
// the cookies of the domains (and their subdomains) belong to the site, which defaults to its own name.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const DEFAULT_SITES = { 'linkedin.com': { max: 1, domains: ['linkedin.com', 'licdn.com'] } }

export function parseSites(data) {
	if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('the sites file must be a JSON object')
	const sites = {}
	for (const [site, entry] of Object.entries(data)) {
		if (!Number.isInteger(entry?.max) || entry.max < 1) throw new Error(`site ${site}: max must be a whole number of at least 1`)
		const domains = entry.domains ?? [site]
		if (!Array.isArray(domains) || !domains.length || domains.some((d) => typeof d !== 'string' || !d)) throw new Error(`site ${site}: domains must be a list of names`)
		sites[site] = { max: entry.max, domains: domains.map((d) => d.toLowerCase().replace(/^\./, '')) }
	}
	return sites
}

// Reads the file, first writing the defaults when there is none.
export function loadSites(file) {
	try {
		return parseSites(JSON.parse(readFileSync(file, 'utf8')))
	} catch (e) {
		if (e.code !== 'ENOENT') throw new Error(`${file}: ${e.message}`)
	}
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
	writeFileSync(file, `${JSON.stringify(DEFAULT_SITES, null, '\t')}\n`, { mode: 0o600 })
	return parseSites(DEFAULT_SITES)
}
