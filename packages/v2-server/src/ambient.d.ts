// Some code the server reuses is written against Cloudflare's runtime types (`@pim/coding`'s vault store against the Durable Object's SQL storage, Forge's HTTP handlers against the
// Fetch types the Workers runtime declares). The v2 server runs on Node, whose own types cover the values; these stand in for the few names that only the Workers types declare,
// so the package typechecks without them (and without their clashes with Node's).
declare interface SqlStorage {
	exec<T = any>(query: string, ...bindings: any[]): { toArray(): T[]; one(): T; [Symbol.iterator](): Iterator<T> };
}
declare type BodyInit = NonNullable<RequestInit["body"]>;
declare type CryptoKey = import("node:crypto").webcrypto.CryptoKey;
declare type BufferSource = ArrayBufferView | ArrayBuffer;
