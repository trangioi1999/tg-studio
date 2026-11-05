/** About 60 characters a second when nothing is waiting. */
export const REVEAL_PER_MS = 0.06;
/** Text waiting to be shown is caught up in about this long. */
export const REVEAL_CATCHUP_MS = 600;
/** No message takes longer than about this to appear. */
export const REVEAL_MAX_MS = 3000;

/** Advance in UTF-16 code units without cutting a surrogate pair in half. */
export function nextReveal(shown: number, text: string, dtMs: number): number {
  const backlog = text.length - shown;
  const step = Math.max(
    1,
    Math.ceil(dtMs * REVEAL_PER_MS),
    Math.ceil(backlog * dtMs / REVEAL_CATCHUP_MS),
    Math.ceil(text.length * dtMs / REVEAL_MAX_MS),
  );
  let next = Math.max(0, Math.min(text.length, shown + step));
  const previous = text.charCodeAt(next - 1);
  if (previous >= 0xd800 && previous <= 0xdbff) next = Math.min(text.length, next + 1);
  return next;
}
