// Five-field cron (minute hour day-of-month month day-of-week) in UTC, as the legacy triggers read it:
// `*`, numbers, ranges `a-b`, lists, and steps `*/n` or `a-b/n`. Days follow Vixie cron: when both day fields are restricted
// either may match. Used only to find the first occurrence after the cutover; a time zone other than UTC is not handled here.
const BOUNDS: readonly (readonly [number, number])[] = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 7],
];

export type CronFields = { readonly sets: readonly [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]; readonly dayRestricted: boolean; readonly weekRestricted: boolean };

export function parseCron(expression: string): CronFields {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) throw new Error(`Cron needs five fields: ${expression}`);
	const sets = parts.map((part, index) => {
		const [lo, hi] = BOUNDS[index]!;
		const values = new Set<number>();
		for (const item of part.split(",")) {
			const [range = "", stepText] = item.split("/");
			const step = stepText === undefined ? 1 : Number(stepText);
			if (!Number.isInteger(step) || step < 1) throw new Error(`Bad cron step in ${expression}`);
			let from = lo;
			let to = hi;
			if (range !== "*") {
				const [a = "", b] = range.split("-");
				from = Number(a);
				to = b === undefined ? (stepText === undefined ? from : hi) : Number(b);
			}
			if (!Number.isInteger(from) || !Number.isInteger(to) || from < lo || to > hi || from > to) throw new Error(`Bad cron field ${part} in ${expression}`);
			for (let v = from; v <= to; v += step) values.add(index === 4 && v === 7 ? 0 : v);
		}
		return values;
	}) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
	return { sets, dayRestricted: !parts[2]!.startsWith("*"), weekRestricted: !parts[4]!.startsWith("*") };
}

/** The first matching minute strictly after `after` (epoch ms), searching up to five years ahead. */
export function nextCronAfter(expression: string, after: number): number | null {
	const { sets, dayRestricted, weekRestricted } = parseCron(expression);
	const d = new Date(Math.floor(after / 60_000) * 60_000 + 60_000);
	const limit = after + 5 * 366 * 86_400_000;
	while (d.getTime() <= limit) {
		if (!sets[3].has(d.getUTCMonth() + 1)) {
			d.setUTCMonth(d.getUTCMonth() + 1, 1);
			d.setUTCHours(0, 0, 0, 0);
			continue;
		}
		const dom = sets[2].has(d.getUTCDate());
		const dow = sets[4].has(d.getUTCDay());
		const dayOk = dayRestricted && weekRestricted ? dom || dow : dom && dow;
		if (!dayOk) {
			d.setUTCDate(d.getUTCDate() + 1);
			d.setUTCHours(0, 0, 0, 0);
			continue;
		}
		if (!sets[1].has(d.getUTCHours())) {
			d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
			continue;
		}
		if (!sets[0].has(d.getUTCMinutes())) {
			d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0);
			continue;
		}
		return d.getTime();
	}
	return null;
}

/** Every matching minute in (from, to], at most `max`: the occurrences a restart would have to account for. */
export function cronOccurrencesBetween(expression: string, from: number, to: number, max = 1000): number[] {
	const out: number[] = [];
	let cursor = from;
	while (out.length < max) {
		const next = nextCronAfter(expression, cursor);
		if (next === null || next > to) break;
		out.push(next);
		cursor = next;
	}
	return out;
}
