/**
 * PF1 Bleed Effects — shared damage-over-time primitives.
 *
 * Small, stateless helpers used by both the bleed engine and the burning
 * engine so the two recurring-damage features share one implementation of
 * actor resolution, the active-GM check, and the module's socket channel.
 */

export const MODULE_ID = "pf1-bleed-effects";

/** The module's socket channel, shared by every DoT feature. */
export const SOCKET = `module.${MODULE_ID}`;

/**
 * Resolve an Actor from an Actor, Token, TokenDocument, or UUID string.
 *
 * @param {Actor|Token|TokenDocument|string} ref
 * @returns {Actor|null}
 */
export function resolveActor(ref) {
  if (!ref) return null;
  if (ref instanceof Actor) return ref;
  if (ref.actor instanceof Actor) return ref.actor; // Token / TokenDocument / placeable
  if (typeof ref === "string") {
    const doc = fromUuidSync(ref);
    return doc instanceof Actor ? doc : (doc?.actor ?? null);
  }
  return null;
}

/**
 * Whether this client is the single GM responsible for executing writes.
 *
 * @returns {boolean}
 */
export function isActiveGM() {
  return game.user === game.users.activeGM;
}
