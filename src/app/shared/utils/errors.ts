/** What went wrong, as text: Rust errors already arrive in Vietnamese. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
