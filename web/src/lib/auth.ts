import { queryOptions } from "@tanstack/react-query";
import { followMove, SignInRequired } from "~/lib/pim-api";

/**
 * Signing in with passkeys, or with an account at Google, GitHub or the
 * single sign-on provider the admin set up. The Worker (src/auth) checks
 * them and keeps the session in a cookie; this side runs the browser's
 * WebAuthn ceremonies and hands their results over as base64url, and sends
 * the browser to a provider's sign-in page, which sends it back to the Worker.
 */

export type Role = "admin" | "member";

export type AuthSession = {
  signedIn: boolean;
  /** `identity` is an account at another provider; `dev` is the dev server, which signs every request in itself. */
  method: "passkey" | "identity" | "dev" | null;
  /** The passkey this browser signed in with. */
  passkey: string | null;
  /** The passkey or linked identity this browser signed in with. */
  credential?: string | null;
  /** The other accounts people can sign in with here, as the admin set them up. */
  providers?: SignInProvider[];
  /** Who is signed in. */
  account: { username: string; role: Role } | null;
  /** Signed in: what an account they linked at another provider calls them, if any. */
  name?: string | null;
  /** Signed out: whether this Pim has its admin yet. */
  claimed?: boolean;
  /** Signed out, with no admin yet: right after a deploy, whoever registers first becomes the admin. */
  canClaim?: boolean;
  /** Signed out: how people join once there is an admin. */
  registration?: "open" | "invite" | "closed";
};

export type ProviderId = "google" | "github" | "oidc";

export type SignInProvider = { id: ProviderId; name: string };

/** An account at another provider, linked to sign in with. */
export type LinkedIdentity = {
  id: string;
  provider: ProviderId;
  /** Its email or username there. */
  label: string;
  createdAt: number;
  lastUsedAt: number;
};

export type ApiToken = {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
};

/** An MCP client asking to be let in, for the `/authorize` page; or where to send the browser instead. */
export type AuthorizationRequest =
  | {
      handle: string;
      client: {
        /** What the client calls itself, unverified. */
        name: string;
        /** Where access goes if the person allows it. */
        redirectHost: string;
        /** Whether that is an app on this computer. */
        local: boolean;
      };
    }
  | { redirectTo: string };

/** An MCP client the person let in. */
export type McpConnection = {
  id: string;
  name: string;
  createdAt: number;
  /** When it is disconnected unless it is used before then. */
  expiresAt: number | null;
};

export type Registered = {
  username: string;
  role: Role;
  /** Makes the account's first passkey, once, within a day. */
  setup: string;
  setupExpiresAt: string;
  recoveryCodes: string[];
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
    | (T & { error?: string; url?: unknown })
    | null;
  if (!response.ok) {
    followMove(response, body);
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

export const identitiesQuery = () =>
  queryOptions({
    queryKey: ["auth", "identities"],
    queryFn: () =>
      call<{ identities: LinkedIdentity[] }>("/identities").then(
        (body) => body.identities,
      ),
  });

export const auth = {
  /**
   * Leaves for a provider's sign-in page, which sends the browser back signed
   * in. Signed in already, it links that account instead; with a setup
   * link's code, it adds the account's first way in.
   */
  async withProvider(provider: ProviderId, setup?: string) {
    // An MCP client's request to be let in waits on the other side.
    const returnTo =
      location.pathname === "/authorize"
        ? location.pathname + location.search
        : undefined;
    const { url } = await post<{ url: string }>(`/oauth/${provider}`, {
      ...(setup && { setup }),
      ...(returnTo && { returnTo }),
    });
    location.assign(url);
    // The page is leaving: stay pending until it does.
    await new Promise(() => {});
  },

  unlinkIdentity: (id: string) =>
    call(`/identities/${encodeURIComponent(id)}`, { method: "DELETE" }),

  async signIn() {
    const options = await post<RequestOptions>("/sign-in/options");
    // No allowCredentials: the browser offers whichever passkeys it has.
    const credential = (await navigator.credentials.get({
      publicKey: { ...options, challenge: decode(options.challenge) },
    })) as PublicKeyCredential | null;
    if (!credential) throw new Error("No passkey was chosen.");
    const response = credential.response as AuthenticatorAssertionResponse;
    // The passkey says whose it is: the account it was made for.
    if (!response.userHandle) {
      throw new Error("That passkey doesn't say whose it is. Use another.");
    }
    await post("/sign-in", {
      id: credential.id,
      clientDataJSON: encode(response.clientDataJSON),
      authenticatorData: encode(response.authenticatorData),
      signature: encode(response.signature),
      userHandle: encode(response.userHandle),
    });
  },

  /**
   * Needs a setup link's code, a device link's, or a recovery code with its
   * username, unless this browser is signed in.
   */
  async addPasskey(
    allowedBy: {
      setup?: string;
      recovery?: string;
      username?: string;
      device?: string;
    } = {},
  ) {
    const options = await post<CreationOptions>("/passkeys/options", allowedBy);
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

  /**
   * Has the Worker write a setup link to its logs, for whoever runs this Pim:
   * one that claims it while it has no admin, or adds the admin a passkey.
   */
  requestSetupLink: () => post<{ expiresAt: string }>("/setup-link"),

  removePasskey: (id: string) =>
    call(`/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" }),

  signOut: () => post("/sign-out"),

  /** A link that adds another device (a phone) to this Pim, once, for ten minutes. */
  deviceLink: () => post<{ url: string; expiresAt: string }>("/device-link"),
  /** Stops the link this browser made from working. */
  cancelDeviceLink: () => call("/device-link", { method: "DELETE" }),

  /** How many recovery codes are left, and a new set. */
  recoveryCodesLeft: () =>
    call<{ left: number }>("/recovery-codes").then((body) => body.left),
  newRecoveryCodes: () =>
    post<{ codes: string[] }>("/recovery-codes").then((body) => body.codes),

  /** API tokens, for clients other than this app. */
  tokens: () =>
    call<{ tokens: ApiToken[] }>("/tokens").then((body) => body.tokens),
  createToken: (name: string) =>
    post<ApiToken & { token: string }>("/tokens", { name }),
  revokeToken: (id: string) =>
    call(`/tokens/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** An MCP client's request to be let in (`search` is the `/authorize` page's), and the person's answer. */
  authorizationRequest: (search: string) =>
    call<AuthorizationRequest>(`/authorize${search}`),
  answerAuthorization: (handle: string, allow: boolean) =>
    post<{ redirectTo: string }>("/authorize", { handle, allow }),
  /** MCP clients the person let in, and disconnecting one. */
  connections: () =>
    call<{ connections: McpConnection[] }>("/connections").then(
      (body) => body.connections,
    ),
  disconnect: (id: string) =>
    call(`/connections/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** Joining this Pim, or claiming it. */
  usernameAvailable: (name: string) =>
    call<{ available: boolean; reason?: string }>(
      `/username?name=${encodeURIComponent(name)}`,
    ),
  register: (input: {
    username: string;
    invite?: string;
    claim?: string;
    timeZone?: string;
  }) => post<Registered>("/register", input),
};

export const tokensQuery = () =>
  queryOptions({ queryKey: ["auth", "tokens"], queryFn: auth.tokens });

export const connectionsQuery = () =>
  queryOptions({
    queryKey: ["auth", "connections"],
    queryFn: auth.connections,
  });

/** A code a link carries in its fragment, such as `/#setup=…`. */
const linkCode = (name: string) =>
  new URLSearchParams(location.hash.slice(1)).get(name);

/** The code in a setup link (`/#setup=…`), from the Worker's logs or from the admin. */
export const setupCode = () => linkCode("setup");

/** The code in a link from the Worker's logs that claims a Pim with no admin (`/#claim=…`). */
export const claimCode = () => linkCode("claim");

/** The code in an invite link the admin made (`/#invite=…`). */
export const inviteCode = () => linkCode("invite");

/**
 * The code in a link that adds another device (`/#device=…`). It is taken out
 * of the address bar as soon as the page reads it, before any request, so it
 * isn't left in history, bookmarks or a shared screenshot of the page.
 */
let pendingDeviceCode: string | null | undefined;
export function deviceCode(): string | null {
  const fresh = new URLSearchParams(location.hash.slice(1)).get("device");
  if (fresh) {
    pendingDeviceCode = fresh;
    history.replaceState(
      history.state,
      "",
      location.pathname + location.search,
    );
  }
  return pendingDeviceCode ?? null;
}

/** Forgets a device-link code once it's used, or found not to work. */
export function forgetDeviceCode() {
  pendingDeviceCode = null;
}

/**
 * Why signing in with a provider didn't work, as the Worker sent the browser
 * back (`#auth-error=…`). It leaves the address bar at once, and is kept
 * until `forgetAuthError`.
 */
let pendingAuthError: string | null = null;
export function authError(): string | null {
  const fresh = linkCode("auth-error");
  if (fresh) {
    pendingAuthError = fresh;
    history.replaceState(
      history.state,
      "",
      location.pathname + location.search,
    );
  }
  return pendingAuthError;
}

export function forgetAuthError() {
  pendingAuthError = null;
}

/** Drops a used setup, claim or invite code from the address bar and history. */
export function forgetSetupCode() {
  history.replaceState(history.state, "", location.pathname + location.search);
}

/** The browser refused because this device already has a passkey for this Pim. */
export function alreadyRegistered(error: unknown): boolean {
  return error instanceof DOMException && error.name === "InvalidStateError";
}

/** The browser's "you cancelled" or "timed out" isn't worth an error. */
export function cancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotAllowedError";
}
