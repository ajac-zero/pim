// A small streaming tar reader and writer, enough for workspace snapshots. It reads ustar, GNU
// long names and PAX headers (what Docker's archive API and GNU tar write) and writes ustar with a
// PAX header where a name or size does not fit. `transformTar` re-encodes every entry it keeps, so
// nothing the caller did not look at passes through.

export class TarError extends Error {}

const BLOCK = 512
const MAX_META = 1024 * 1024 // a PAX header or GNU long name larger than this is not a real one
const MAX_OCTAL = 0o77777777777
const TYPES = { 0: 'file', 7: 'file', 1: 'hardlink', 2: 'symlink', 3: 'device', 4: 'device', 5: 'dir', 6: 'fifo' }
const FLAGS = { file: '0', hardlink: '1', symlink: '2', dir: '5' }
const pad = (n) => (BLOCK - (n % BLOCK)) % BLOCK
const zeros = (n) => Buffer.alloc(n)

// Reads exact byte counts from an async iterable of buffers.
function reader(source) {
	const it = source[Symbol.asyncIterator]()
	let buf = Buffer.alloc(0)
	const more = async () => {
		const r = await it.next()
		if (r.done) return false
		buf = buf.length ? Buffer.concat([buf, r.value]) : Buffer.from(r.value)
		return true
	}
	return {
		// The next header block, or null at the end of the input.
		async block() {
			while (buf.length < BLOCK) {
				if (!(await more())) {
					if (buf.length) throw new TarError('truncated tar header')
					return null
				}
			}
			const b = buf.subarray(0, BLOCK)
			buf = buf.subarray(BLOCK)
			return b
		},
		async *chunks(n) {
			while (n > 0) {
				if (!buf.length && !(await more())) throw new TarError('truncated tar entry')
				const c = buf.subarray(0, Math.min(n, buf.length))
				buf = buf.subarray(c.length)
				n -= c.length
				yield c
			}
		},
		async read(n) {
			const parts = []
			for await (const c of this.chunks(n)) parts.push(c)
			return Buffer.concat(parts)
		},
		async skip(n) {
			for await (const _ of this.chunks(n));
		},
		// Reads what follows the end of the archive (GNU tar pads it to a 10 KiB record), so a
		// stream source ends normally instead of being torn down.
		async drain() {
			buf = Buffer.alloc(0)
			while (await more()) buf = Buffer.alloc(0)
		},
		close: () => it.return?.(),
	}
}

const cstr = (b) => {
	const z = b.indexOf(0)
	return (z < 0 ? b : b.subarray(0, z)).toString('utf8')
}

function parseHeader(b) {
	if (b.every((x) => x === 0)) return null
	const num = (off, len) => {
		if (b[off] & 0x80) {
			// GNU base-256, used for sizes of 8 GiB and more.
			let v = 0
			for (let i = off + 1; i < off + len; i++) v = v * 256 + b[i]
			return v
		}
		const s = cstr(b.subarray(off, off + len)).trim()
		if (!s) return 0
		if (!/^[0-7]+$/.test(s)) throw new TarError('invalid number in tar header')
		return parseInt(s, 8)
	}
	let sum = 0
	for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : b[i]
	if (sum !== num(148, 8)) throw new TarError('tar header checksum mismatch')
	const posix = b.subarray(257, 263).toString('latin1') === 'ustar\0'
	const prefix = posix ? cstr(b.subarray(345, 500)) : ''
	const name = cstr(b.subarray(0, 100))
	return {
		name: prefix ? `${prefix}/${name}` : name,
		mode: num(100, 8),
		uid: num(108, 8),
		gid: num(116, 8),
		size: num(124, 12),
		mtime: num(136, 12),
		flag: b[156] ? String.fromCharCode(b[156]) : '0',
		linkname: cstr(b.subarray(157, 257)),
	}
}

function parsePax(data) {
	const out = {}
	let i = 0
	while (i < data.length) {
		const sp = data.indexOf(32, i)
		const len = Number(data.subarray(i, sp).toString('latin1'))
		if (sp < 0 || !Number.isInteger(len) || len <= 0 || i + len > data.length) throw new TarError('invalid PAX header')
		const rec = data.subarray(sp + 1, i + len - 1).toString('utf8')
		const eq = rec.indexOf('=')
		if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1)
		i += len
	}
	return out
}

function paxRecord(k, v) {
	const s = ` ${k}=${v}\n`
	const base = Buffer.byteLength(s)
	let n = base + String(base).length
	if (String(n).length > String(base).length) n++
	return `${n}${s}`
}

function rawHeader({ name, mode = 0o644, uid = 0, gid = 0, size = 0, mtime = 0, flag, linkname = '' }) {
	const b = Buffer.alloc(BLOCK)
	const octal = (off, len, v) => b.write(`${Math.max(0, Math.floor(v)).toString(8).padStart(len - 1, '0')}\0`, off, len, 'latin1')
	b.write(name, 0, 100, 'utf8')
	octal(100, 8, mode)
	octal(108, 8, uid)
	octal(116, 8, gid)
	octal(124, 12, size)
	octal(136, 12, mtime)
	b.fill(32, 148, 156)
	b.write(flag, 156, 1, 'latin1')
	b.write(linkname, 157, 100, 'utf8')
	b.write('ustar\0', 257, 6, 'latin1')
	b.write('00', 263, 2, 'latin1')
	let sum = 0
	for (const x of b) sum += x
	b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1')
	return b
}

// The header blocks for one entry: {name, type: file|dir|symlink|hardlink, mode, uid, gid, size,
// mtime, linkname}. The file's data (padded to 512 bytes) follows it.
export function tarHeader(e) {
	const flag = e.flag ?? FLAGS[e.type]
	const size = e.type === 'file' ? e.size : 0
	let pax = ''
	if (Buffer.byteLength(e.name) > 100) pax += paxRecord('path', e.name)
	if (e.linkname && Buffer.byteLength(e.linkname) > 100) pax += paxRecord('linkpath', e.linkname)
	if (size > MAX_OCTAL) pax += paxRecord('size', String(size))
	const header = rawHeader({ ...e, flag, size: size > MAX_OCTAL ? 0 : size })
	if (!pax) return header
	const body = Buffer.from(pax)
	return Buffer.concat([rawHeader({ name: 'PaxHeader', flag: 'x', size: body.length }), body, zeros(pad(body.length)), header])
}

export const tarEnd = () => zeros(2 * BLOCK)

// Joins the small buffers a tar stream is made of (a 512-byte header, then a file's data, then its
// padding, for every entry) into buffers of at least `size` bytes, so what reads the stream (the
// compressor, whose every write is a round trip to the thread pool, or the HTTP request to Docker,
// a chunk of chunked encoding each) handles thousands of writes instead of three per file.
export async function* coalesce(source, size = 256 * 1024) {
	let parts = []
	let n = 0
	for await (const b of source) {
		if (!n && b.length >= size) {
			yield b
			continue
		}
		parts.push(b)
		n += b.length
		if (n >= size) {
			yield Buffer.concat(parts, n)
			parts = []
			n = 0
		}
	}
	if (n) yield Buffer.concat(parts, n)
}

// Reads a tar stream and yields a new one. `onEntry(entry)` sees each entry, with `type` one of
// file, dir, symlink, hardlink, device, fifo or other, and returns null to leave it out, or
// `{entry}` to write it (as changed), or `{entry, edit}` where `edit(Buffer)` returns the file's
// new contents (for small files only: it reads the whole file).
export async function* transformTar(source, onEntry) {
	const r = reader(source)
	try {
		let pax = {}
		let longName
		let longLink
		for (;;) {
			const block = await r.block()
			const h = block && parseHeader(block)
			if (!h) break
			if ('xgLK'.includes(h.flag)) {
				if (h.size > MAX_META) throw new TarError('tar metadata entry too large')
				const data = (await r.read(h.size + pad(h.size))).subarray(0, h.size)
				if (h.flag === 'x') pax = parsePax(data)
				else if (h.flag === 'L') longName = cstr(data)
				else if (h.flag === 'K') longLink = cstr(data)
				continue
			}
			const size = pax.size !== undefined ? Number(pax.size) : h.size
			if (!Number.isSafeInteger(size) || size < 0) throw new TarError('invalid entry size')
			const entry = {
				name: pax.path ?? longName ?? h.name,
				linkname: pax.linkpath ?? longLink ?? h.linkname,
				type: TYPES[h.flag] ?? 'other',
				mode: h.mode,
				uid: h.uid,
				gid: h.gid,
				mtime: pax.mtime !== undefined ? Number.parseFloat(pax.mtime) : h.mtime,
				size,
			}
			pax = {}
			longName = longLink = undefined
			const keep = await onEntry(entry)
			if (!keep) {
				await r.skip(size + pad(size))
				continue
			}
			const out = keep.entry
			if (keep.edit) {
				const data = keep.edit((await r.read(size + pad(size))).subarray(0, size))
				yield tarHeader({ ...out, size: data.length })
				yield data
				yield zeros(pad(data.length))
				continue
			}
			yield tarHeader({ ...out, size })
			if (out.type === 'file') {
				yield* r.chunks(size)
				if (pad(size)) yield zeros(pad(size))
				await r.skip(pad(size))
			} else await r.skip(size + pad(size))
		}
		await r.drain()
		yield tarEnd()
	} finally {
		await r.close()
	}
}
