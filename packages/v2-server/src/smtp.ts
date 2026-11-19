/**
 * Sending email to the person, through the deployment's own SMTP server. It is optional: a deployment that sets `PIM_SMTP_URL` (`smtps://user:pass@host:465`, or
 * `smtp://host:25`, which upgrades to TLS when the server offers it) and `PIM_EMAIL_FROM` lets each person confirm an address in Settings, and Pim can then send
 * messages there. Pim only ever emails that one confirmed address. The client is small on purpose: one message per connection, plain text in UTF-8.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import net from "node:net";
import tls from "node:tls";
import type { Mail, Mailer } from "@pim/v2-app/mail";

type Env = Readonly<Record<string, string | undefined>>;

export type SmtpConfig = { host: string; port: number; secure: boolean; user: string | null; pass: string | null; from: string; name: string };

const ADDRESS = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;
const loopback = (host: string) => host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);

/** The address in `PIM_EMAIL_FROM`, or why it is not one. */
export function emailFrom(env: Env): { address: string | null; problem: string | null } {
	const value = env.PIM_EMAIL_FROM?.trim();
	if (!value) return { address: null, problem: null };
	return ADDRESS.test(value) ? { address: value, problem: null } : { address: null, problem: "must be an email address, such as pim@example.com" };
}

/** The SMTP server in `PIM_SMTP_URL`, or why it cannot be used. */
export function smtpUrl(value: string): { host: string; port: number; secure: boolean; user: string | null; pass: string | null } | string {
	const url = URL.parse(value);
	if (!url || (url.protocol !== "smtp:" && url.protocol !== "smtps:") || !url.hostname) return "must be a URL such as smtps://user:password@smtp.example.com:465 or smtp://mail.internal:25";
	const secure = url.protocol === "smtps:";
	return {
		host: url.hostname.replace(/^\[|\]$/g, ""),
		port: url.port ? Number(url.port) : secure ? 465 : 25,
		secure,
		user: url.username ? decodeURIComponent(url.username) : null,
		pass: url.password ? decodeURIComponent(url.password) : null,
	};
}

/** `PIM_SMTP_URL` with its password hidden, for the admin's screens and the logs. */
export function hidePassword(value: string): string {
	const url = URL.parse(value);
	if (!url || !url.password) return value;
	url.password = "***";
	return url.toString();
}

/** The SMTP settings of a deployment, or null when it has none (both `PIM_SMTP_URL` and `PIM_EMAIL_FROM` are needed). */
export function smtpConfigFrom(env: Env): SmtpConfig | null {
	const value = env.PIM_SMTP_URL?.trim();
	const from = emailFrom(env).address;
	if (!value || !from) return null;
	const server = smtpUrl(value);
	return typeof server === "string" ? null : { ...server, from, name: "Pim" };
}

/** The deployment's mailer, or undefined when it can't send email. */
export function mailerFrom(env: Env): Mailer | undefined {
	const config = smtpConfigFrom(env);
	return config ? smtpMailer(config) : undefined;
}

/** A header value on one line, in ASCII, as an encoded word when it is not plain. */
function header(value: string): string {
	const line = value.replace(/[\r\n]+/g, " ").trim();
	// eslint-disable-next-line no-control-regex
	if (/^[\x20-\x7e]*$/.test(line)) return line;
	// Each encoded word is at most 75 characters: 45 bytes of text make 60 of base64, and a character is never split.
	const words: string[] = [];
	let chunk = "";
	for (const character of line) {
		if (Buffer.byteLength(chunk + character) > 45) (words.push(chunk), (chunk = ""));
		chunk += character;
	}
	if (chunk) words.push(chunk);
	return words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString("base64")}?=`).join("\r\n ");
}

/** The message as it goes over the wire: UTF-8 text in base64, so no line is long and no byte needs quoting. */
export function messageOf(config: Pick<SmtpConfig, "from" | "name">, mail: Mail, now = new Date()): string {
	const domain = config.from.slice(config.from.lastIndexOf("@") + 1);
	const body = Buffer.from(mail.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n");
	return [
		`From: ${header(config.name)} <${config.from}>`,
		`To: <${mail.to.replace(/[\r\n<>]/g, "")}>`,
		`Subject: ${header(mail.subject)}`,
		`Date: ${now.toUTCString().replace("GMT", "+0000")}`,
		`Message-ID: <${randomUUID()}@${domain}>`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"Content-Transfer-Encoding: base64",
		"",
		body,
	].join("\r\n");
}

type Reply = { code: number; lines: string[] };

/** One SMTP connection: commands go out, and each reply (possibly several lines) comes back whole. */
class Connection {
	#socket: net.Socket | tls.TLSSocket;
	#buffer = "";
	#replies: Reply[] = [];
	#lines: string[] = [];
	#waiting: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | undefined;
	#failed: Error | undefined;

	constructor(socket: net.Socket | tls.TLSSocket) {
		this.#socket = socket;
		this.#attach(socket);
	}

	#attach(socket: net.Socket | tls.TLSSocket): void {
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			this.#buffer += chunk;
			for (let end = this.#buffer.indexOf("\r\n"); end >= 0; end = this.#buffer.indexOf("\r\n")) {
				const line = this.#buffer.slice(0, end);
				this.#buffer = this.#buffer.slice(end + 2);
				this.#lines.push(line.slice(4));
				// "250-more" continues; "250 done" (or a bare code) ends the reply.
				if (/^\d{3}$/.test(line) || /^\d{3} /.test(line)) {
					this.#replies.push({ code: Number(line.slice(0, 3)), lines: this.#lines });
					this.#lines = [];
				}
			}
			this.#deliver();
		});
		const fail = (error: Error) => {
			this.#failed ??= error;
			this.#deliver();
		};
		socket.on("error", fail);
		socket.on("close", () => fail(new Error("The mail server closed the connection")));
	}

	#deliver(): void {
		const waiting = this.#waiting;
		if (!waiting) return;
		const reply = this.#replies.shift();
		if (reply) {
			this.#waiting = undefined;
			waiting.resolve(reply);
		} else if (this.#failed) {
			this.#waiting = undefined;
			waiting.reject(this.#failed);
		}
	}

	reply(): Promise<Reply> {
		return new Promise((resolve, reject) => {
			this.#waiting = { resolve, reject };
			this.#deliver();
		});
	}

	/** Sends a command and reads its reply, which must be one of `expect`. */
	async command(line: string, ...expect: number[]): Promise<Reply> {
		this.#socket.write(`${line}\r\n`);
		return this.expect(expect);
	}

	async expect(codes: number[]): Promise<Reply> {
		const reply = await this.reply();
		if (!codes.includes(reply.code)) throw new Error(`The mail server answered ${reply.code} ${reply.lines.join(" ")}`.trim());
		return reply;
	}

	write(data: string): void {
		this.#socket.write(data);
	}

	/** Continues over TLS on the same connection, after the server agreed to STARTTLS. */
	upgrade(host: string): Promise<void> {
		this.#socket.removeAllListeners();
		this.#buffer = "";
		this.#failed = undefined;
		return new Promise((resolve, reject) => {
			const secured = tls.connect({ socket: this.#socket as net.Socket, servername: net.isIP(host) ? undefined : host }, () => {
				this.#socket = secured;
				this.#attach(secured);
				resolve();
			});
			secured.once("error", reject);
		});
	}

	close(): void {
		this.#socket.destroy();
	}
}

/** The mailer over one SMTP server: a connection for each message, closed after it, giving up after `timeoutMs`. */
export function smtpMailer(config: SmtpConfig, options: { timeoutMs?: number; tls?: tls.ConnectionOptions } = {}): Mailer {
	return {
		async send(mail) {
			const timeoutMs = options.timeoutMs ?? 30_000;
			const socket = config.secure ? tls.connect({ host: config.host, port: config.port, servername: net.isIP(config.host) ? undefined : config.host, ...options.tls }) : net.connect({ host: config.host, port: config.port });
			const connection = new Connection(socket);
			let timer: NodeJS.Timeout | undefined;
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("The mail server took too long")), timeoutMs);
			});
			try {
				await Promise.race([deliver(connection, config, mail), deadline]);
			} finally {
				clearTimeout(timer);
				connection.close();
			}
		},
	};
}

async function deliver(connection: Connection, config: SmtpConfig, mail: Mail): Promise<void> {
	const hello = `EHLO ${hostname().replace(/[^\w.-]/g, "") || "pim"}`;
	await connection.expect([220]);
	let features = (await connection.command(hello, 250)).lines.join("\n").toUpperCase();
	let secured = config.secure;
	// A server that offers TLS is spoken to over it before anything is sent.
	if (!secured && /^STARTTLS$/m.test(features)) {
		await connection.command("STARTTLS", 220);
		await connection.upgrade(config.host);
		secured = true;
		features = (await connection.command(hello, 250)).lines.join("\n").toUpperCase();
	}
	if (config.user !== null) {
		if (!secured && !loopback(config.host)) throw new Error("The mail server offers no TLS, and Pim will not send a password without it");
		const credentials = Buffer.from(`\u0000${config.user}\u0000${config.pass ?? ""}`).toString("base64");
		if (/^AUTH\b.*\bPLAIN\b/m.test(features)) await connection.command(`AUTH PLAIN ${credentials}`, 235);
		else {
			await connection.command("AUTH LOGIN", 334);
			await connection.command(Buffer.from(config.user).toString("base64"), 334);
			await connection.command(Buffer.from(config.pass ?? "").toString("base64"), 235);
		}
	}
	await connection.command(`MAIL FROM:<${config.from}>`, 250);
	await connection.command(`RCPT TO:<${mail.to.replace(/[\r\n<>]/g, "")}>`, 250, 251);
	await connection.command("DATA", 354);
	// A line that starts with a dot has one more, so it is not the end of the message.
	connection.write(`${messageOf(config, mail).replace(/^\./gm, "..")}\r\n.\r\n`);
	await connection.expect([250]);
	connection.write("QUIT\r\n");
}
