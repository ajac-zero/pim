import { z } from "zod";

/** A person's tenancy key, `o_` followed by the opaque id the account was given. */
export const OwnerId = z.string().regex(/^o_[A-Za-z0-9_-]+$/).brand<"OwnerId">();
export type OwnerId = z.infer<typeof OwnerId>;

/**
 * A runtime partition's id: an opaque UUID, never the numeric id pi-durable gives a conversation.
 * One owner has one home partition, which holds the root conversation; see `ROOT_CONVERSATION_ID`.
 */
export const PartitionId = z.uuid().brand<"PartitionId">();
export type PartitionId = z.infer<typeof PartitionId>;

/** The pi conversation id of an owner's root conversation, which lives in the owner's home partition. */
export const ROOT_CONVERSATION_ID = 1;

/** A conversation's public id, the UUID clients and URLs use; `conversationId` (numeric) is internal to pi. */
export const PublicChatId = z.uuid().brand<"PublicChatId">();
export type PublicChatId = z.infer<typeof PublicChatId>;

export const ACCOUNT_STATUSES = ["pending", "active", "suspended", "deleting", "deleted"] as const;
export const AccountStatus = z.enum(ACCOUNT_STATUSES);
export type AccountStatus = z.infer<typeof AccountStatus>;

export const ACCOUNT_ROLES = ["admin", "member", "guest"] as const;
export const AccountRole = z.enum(ACCOUNT_ROLES);
export type AccountRole = z.infer<typeof AccountRole>;

/** What a request or a piece of work acts as. Every kind but `delegated` is a principal in its own right. */
export type Principal =
	| { readonly kind: "user"; readonly ownerId: OwnerId; readonly role: AccountRole; readonly sessionId: string }
	/** A `pim_` token: it carries at most the scopes it was minted with, never more than its owner holds. */
	| { readonly kind: "token"; readonly ownerId: OwnerId; readonly role: AccountRole; readonly tokenId: string; readonly scopes: readonly string[] }
	| { readonly kind: "agent"; readonly ownerId: OwnerId; readonly agentId: string }
	/**
	 * Acting on someone else's behalf. `originPrincipal` is whoever started the chain and stays the one whose
	 * grants are checked, so delegating never gives more than the origin holds.
	 */
	| { readonly kind: "delegated"; readonly ownerId: OwnerId; readonly delegateId: string; readonly originPrincipal: Principal };

/** The principal whose grants decide what is permitted: the origin of a delegation chain, otherwise the principal itself. */
export function effectivePrincipal(principal: Principal): Exclude<Principal, { kind: "delegated" }> {
	let current = principal;
	while (current.kind === "delegated") current = current.originPrincipal;
	return current;
}
