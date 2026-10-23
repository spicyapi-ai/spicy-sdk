/** Trim a caller-supplied identifier and refuse values that cannot be sent as-is. */
export function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  if (normalized.includes("\r") || normalized.includes("\n")) {
    throw new TypeError(`${label} must not contain line breaks`);
  }
  return normalized;
}
