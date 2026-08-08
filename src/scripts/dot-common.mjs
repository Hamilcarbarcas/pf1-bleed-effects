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

/* -------------------------------------------- *
 *  Deep Bleed availability
 *
 *  Lives here rather than in deep-bleed.mjs so the bleed engine can consult it without
 *  importing that module, which imports the engine in turn.
 * -------------------------------------------- */

/** Setting key for the Deep Bleed homebrew rule. */
export const SETTING_DEEP = "deepBleed";

/** The module that supplies the allocation dialog Deep Bleed depends on. */
export const CRITICAL_EFFECTS_ID = "pf1-critical-effects";

/**
 * Whether pf1-critical-effects is switched on for this world.
 *
 * The *only* availability check that is valid during `init`. `game.modules` is populated from
 * world data before any module script runs, whereas the module's API is published from its own
 * init hook — and init listeners fire in module load order, which puts `pf1-bleed-effects` ahead
 * of `pf1-critical-effects` alphabetically. Probing the API at init therefore always reports
 * absent, which is what previously hid the Deep Bleed setting on worlds that had both.
 *
 * @returns {boolean}
 */
export function criticalEffectsActive() {
  return !!game.modules.get(CRITICAL_EFFECTS_ID)?.active;
}

/**
 * The dedicated-healing integration surface, or null. Valid from `ready` onwards — by then the
 * whole init phase has completed, so load order no longer matters.
 *
 * Deep Bleed is not implemented without it: there is no half-measure worth shipping, since the
 * whole rule is "healing is consumed by the wound instead of the hit points".
 *
 * @returns {object|null}
 */
export function dedicatedHealingApi() {
  const api = game.modules.get(CRITICAL_EFFECTS_ID)?.api?.dedicatedHealing;
  return api?.registerProvider ? api : null;
}

/**
 * Whether the integration is live. Runtime callers only — never during init.
 *
 * @returns {boolean}
 */
export function deepBleedAvailable() {
  return !!dedicatedHealingApi();
}

/**
 * Whether Deep Bleed should apply to newly-inflicted bleed. Existing deep bleeds are read
 * straight off their entries, so turning the rule off mid-campaign lets what is already on an
 * actor clear normally rather than stranding it.
 *
 * @returns {boolean}
 */
export function deepBleedEnabled() {
  if (!deepBleedAvailable()) return false;
  try {
    return !!game.settings.get(MODULE_ID, SETTING_DEEP);
  } catch {
    return false; // setting not registered yet (pre-init callers)
  }
}
