import { queryOptions } from "@tanstack/react-query";
import { SignInRequired } from "~/lib/pim-api";

/**
 * Signing in with passkeys. The Worker (worker/auth.ts) checks them and keeps
 * the session in a cookie; this side runs the browser's WebAuthn ceremonies
 * and hands their results over as base64url.
 */

export type AuthSession = {
  signedIn: boolean;
  /** `dev` is the dev server, which signs every request in itself. */
  method: "passkey" | "dev" | null;
  /** The passkey this browser signed in with. */
  passkey: string | null;
  hasPasskeys: boolean;
};

export type Passkey = {
  id: string;
  name: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  lastUsedAt: number;
};

function encode(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer))
    binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decode(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/auth${path}`, {
    ...init,
    // Behind Cloudflare Access, a lapsed session redirects to its sign-in.
    redirect: "manual",
    headers: { "content-type": "application/json", ...init.headers },
  });
  if (response.type === "opaqueredirect") throw new SignInRequired();
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!response.ok) {
    throw new Error(body?.error ?? `Sign-in answered ${response.status}`);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

/** A label for the passkey made on this device, such as "Chrome on macOS". */
function deviceName(): string {
  const agent = navigator.userAgent;
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "Browser";
  const system = /iPhone|iPad/.test(agent)
    ? "iOS"
    : /Android/.test(agent)
      ? "Android"
      : /Mac OS X/.test(agent)
        ? "macOS"
        : /Windows/.test(agent)
          ? "Windows"
          : /Linux/.test(agent)
            ? "Linux"
            : null;
  return system ? `${browser} on ${system}` : browser;
}

type CreationOptions = {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: PublicKeyCredentialParameters[];
  authenticatorSelection: AuthenticatorSelectionCriteria;
  attestation: AttestationConveyancePreference;
  timeout: number;
  excludeCredentials: { type: "public-key"; id: string }[];
};

type RequestOptions = {
  challenge: string;
  rpId: string;
  userVerification: UserVerificationRequirement;
  timeout: number;
};

export const authSessionQuery = () =>
  queryOptions({
    queryKey: ["auth", "session"],
    queryFn: () => call<AuthSession>("/session"),
  });

export const passkeysQuery = () =>
  queryOptions({
    queryKey: ["auth", "passkeys"],
    queryFn: () =>
      call<{ passkeys: Passkey[] }>("/passkeys").then((body) => body.passkeys),
  });

export const auth = {
  async signIn() {
    const options = await post<RequestOptions>("/sign-in/options");
    // No allowCredentials: the browser offers whichever passkeys it has.
    const credential = (await navigator.credentials.get({
      publicKey: { ...options, challenge: decode(options.challenge) },
    })) as PublicKeyCredential | null;
    if (!credential) throw new Error("No passkey was chosen.");
    const response = credential.response as AuthenticatorAssertionResponse;
    await post("/sign-in", {
      id: credential.id,
      clientDataJSON: encode(response.clientDataJSON),
      authenticatorData: encode(response.authenticatorData),
      signature: encode(response.signature),
    });
  },

  /** Needs a setup link's code unless this browser is signed in already. */
  async addPasskey(setup?: string) {
    const options = await post<CreationOptions>(
      "/passkeys/options",
      setup ? { setup } : {},
    );
    const credential = (await navigator.credentials.create({
      publicKey: {
        ...options,
        challenge: decode(options.challenge),
        user: { ...options.user, id: decode(options.user.id) },
        excludeCredentials: options.excludeCredentials.map((c) => ({
          ...c,
          id: decode(c.id),
        })),
      },
    })) as PublicKeyCredential | null;
    if (!credential) throw new Error("No passkey was created.");
    const response = credential.response as AuthenticatorAttestationResponse;
    const publicKey = response.getPublicKey();
    if (!publicKey) {
      throw new Error("This browser made a passkey Pim can't use.");
    }
    return post<Passkey>("/passkeys", {
      id: credential.id,
      clientDataJSON: encode(response.clientDataJSON),
      authenticatorData: encode(response.getAuthenticatorData()),
      publicKey: encode(publicKey),
      publicKeyAlgorithm: response.getPublicKeyAlgorithm(),
      name: deviceName(),
    });
  },

  /** Has the Worker write a setup link to its logs, for the account's owner. */
  requestSetupLink: () => post<{ expiresAt: string }>("/setup-link"),

  removePasskey: (id: string) =>
    call(`/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" }),

  signOut: () => post("/sign-out"),
};

/** The browser's "you cancelled" or "timed out" isn't worth an error. */
/** The code in a setup link (`/#setup=…`), from the Worker's logs. */
export function setupCode(): string | null {
  return new URLSearchParams(location.hash.slice(1)).get("setup");
}

/** Drops a used setup code from the address bar and history. */
export function forgetSetupCode() {
  history.replaceState(history.state, "", location.pathname + location.search);
}

export function cancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotAllowedError";
}
