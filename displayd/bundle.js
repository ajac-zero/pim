// What the Pim serves at /displayd.tar.gz: displayd's own files (package.json and src/) as one gzipped
// tar, so a computer that has only pim-computer.ts can get displayd from the same Pim. The bytes depend
// only on the files (sorted, no dates or owners), so a computer can tell by its checksum that it has
// the newest. It is built with the web app (web/vite.config.ts); it is not part of the bundle.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

const here = path.dirname(new URL(import.meta.url).pathname)

/** The files of displayd that run, relative to its folder, in a fixed order. */
export function displaydFiles(dir = here) {
	const files = ['package.json']
	for (const name of readdirSync(path.join(dir, 'src'), { recursive: true, encoding: 'utf8' })) if (name.endsWith('.js')) files.push(`src/${name}`)
	return files.sort()
}

/** One ustar entry for a regular file. */
function entry(name, content) {
	if (Buffer.byteLength(name) > 100) throw new Error(`${name} is too long for a tar header`)
	const header = Buffer.alloc(512)
	header.write(name, 0)
	header.write('0000644\0', 100)
	header.write('0000000\0', 108)
	header.write('0000000\0', 116)
	header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124)
	header.write('00000000000\0', 136)
	header.write('        ', 148)
	header.write('0', 156)
	header.write('ustar\0', 257)
	header.write('00', 263)
	header.write(`${[...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148)
	return Buffer.concat([header, content, Buffer.alloc((512 - (content.length % 512)) % 512)])
}

/** displayd as a .tar.gz. */
export function displaydBundle(dir = here) {
	const parts = displaydFiles(dir).map((file) => entry(file, readFileSync(path.join(dir, file))))
	return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]), { level: 9 })
}
