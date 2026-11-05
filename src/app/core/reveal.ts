export const REVEAL_PER_MS = 0.12;
export const REVEAL_CATCHUP_MS = 250;
export const REVEAL_MAX_MS = 1500;

/** Advance in UTF-16 code units without cutting a surrogate pair in half. */
export function nextReveal(shown: number, text: string, dtMs: number): number {
  const backlog = text.length - shown;
  const step = Math.max(
    2,
    Math.ceil(dtMs * REVEAL_PER_MS),
    Math.ceil(backlog * dtMs / REVEAL_CATCHUP_MS),
    Math.ceil(text.length * dtMs / REVEAL_MAX_MS),
  );
  let next = Math.max(0, Math.min(text.length, shown + step));
  const previous = text.charCodeAt(next - 1);
  if (previous >= 0xd800 && previous <= 0xdbff) next = Math.min(text.length, next + 1);
  return next;
}
