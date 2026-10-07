import { ApiError } from "./client";

/** Replaces only stable transport prose when a localized alternative is provided; retains the error object. */
export function apiErrorMessage(error: ApiError, networkMessage?: string): string {
  const network = error.status === 0 || error.problem?.type === "urn:moesegfault:problem:network";
  return network && networkMessage !== undefined ? networkMessage : error.message;
}
