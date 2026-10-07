/** Matches identity_domain::validate_password: 15–128 Unicode scalar values, no control characters. */
export function isValidNewPassword(value: string): boolean {
  const length = Array.from(value).length;
  // JavaScript can contain lone surrogates; JSON/Rust cannot accept them as Unicode scalar values.
  return length >= 15 && length <= 128 && !/[\p{Cc}\p{Cs}]/u.test(value);
}
