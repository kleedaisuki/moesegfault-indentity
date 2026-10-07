import type { AccountPreferences, ProfilePatch } from "./api/types";
import { normalizeLocale, type MessageKey } from "./i18n";

/** A rejected field remains untouched in the form; numbers locate the offending list item. */
export interface ProfileInputIssue {
  field: "display_name" | "bio" | "status_message" | "pronouns" | "favorite_character" | "interests" | "links" | "profile_visibility" | "timezone";
  message: MessageKey;
  limit?: number;
  item?: number;
}

/** Both independent writes share one deterministic validation gate, not a new atomic API. */
export type ProfileInputResult =
  | { valid: false; issue: ProfileInputIssue }
  | { valid: true; profile: ProfilePatch; preferences: Pick<AccountPreferences, "locale" | "timezone"> };

/** Parses complete lists without truncation and mirrors account.rs profile/preference constraints. */
export function readProfileInput(data: FormData): ProfileInputResult {
  const read = (name: string) => String(data.get(name) ?? "");
  const displayName = read("display_name");
  const displayLength = Array.from(displayName.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "")).length;
  if (displayLength < 1 || displayLength > 80) return invalid("display_name", "profileDisplayNameInvalid");
  const details = { bio: read("bio").trim() || null, status_message: read("status_message").trim() || null, pronouns: read("pronouns").trim() || null, favorite_character: read("favorite_character").trim() || null };
  for (const [field, limit] of [["bio", 500], ["status_message", 100], ["pronouns", 40], ["favorite_character", 100]] as const) {
    if (Array.from(details[field] ?? "").length > limit) return invalid(field, "profileTextTooLong", limit);
  }
  const interests = read("interests").split(/[,，]/u).map((value) => value.trim()).filter(Boolean);
  const links = read("links").split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  const listIssue = validateLists(interests, links);
  if (listIssue) return { valid: false, issue: listIssue };
  const visibility = read("profile_visibility");
  if (visibility !== "private" && visibility !== "members" && visibility !== "public") return invalid("profile_visibility", "profileVisibilityInvalid");
  const timezone = read("timezone");
  // Rust String::len counts UTF-8 bytes here, unlike scalar-counted profile text. No IANA check exists.
  if (!timezone || new TextEncoder().encode(timezone).length > 64) return invalid("timezone", "profileTimezoneInvalid");
  const unicodeFields = { display_name: displayName, ...details, interests: interests.join(""), links: links.join(""), timezone };
  for (const [field, value] of Object.entries(unicodeFields)) {
    if (/[\p{Cs}]/u.test(value ?? "")) return invalid(field as ProfileInputIssue["field"], "profileInvalidUnicode");
  }
  return { valid: true, profile: { display_name: displayName, ...details, interests, links, profile_visibility: visibility }, preferences: { locale: normalizeLocale(read("locale")), timezone } };
}

/** Validates complete parsed lists, retaining exact-case interest uniqueness and every URL scheme. */
function validateLists(interests: string[], links: string[]): ProfileInputIssue | undefined {
  if (interests.length > 20) return { field: "interests", message: "profileInterestsCount" };
  if (links.length > 10) return { field: "links", message: "profileLinksCount" };
  const seen = new Set<string>();
  for (const [index, interest] of interests.entries()) {
    if (Array.from(interest).length > 40) return { field: "interests", message: "profileInterestLength", item: index + 1 };
    if (seen.has(interest)) return { field: "interests", message: "profileInterestDuplicate", item: index + 1 };
    seen.add(interest);
  }
  for (const [index, link] of links.entries()) {
    if (Array.from(link).length > 2048) return { field: "links", message: "profileLinkLength", item: index + 1 };
    try { new URL(link); } catch { return { field: "links", message: "profileLinkInvalid", item: index + 1 }; }
  }
  return undefined;
}

/** Constructs one focused failure without normalizing or discarding the user's live form values. */
function invalid(field: ProfileInputIssue["field"], message: MessageKey, limit?: number): ProfileInputResult {
  return { valid: false, issue: { field, message, limit } };
}
