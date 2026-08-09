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
 *  Condition sourcing
 *
 *  A condition can reach an actor two ways, and the difference matters to every DoT feature here.
 *  Applied directly, it is an Active Effect on the *actor*, which PF1 can create and delete.
 *  Supplied by a buff (the condition ids in the buff's `system.conditions`), it is an AE on the
 *  *item*, created when the buff switches on and deleted when it switches off — PF1's
 *  `setConditions` cannot touch that one (it searches `actor.effects` only, flagged `// BUG:` in
 *  the system source), so the buff alone governs its lifetime.
 * -------------------------------------------- */

/**
 * The item-borne Active Effects currently supplying a condition to an actor.
 *
 * `appliedEffects` excludes disabled and suppressed effects, so a switched-off buff doesn't
 * appear — which is exactly the "is this condition live right now" question every caller is
 * asking. This is the same test PF1's own item sheet uses to mark a condition "inherited".
 *
 * @param {Actor} actor
 * @param {string} conditionId
 * @returns {ActiveEffect[]}
 */
export function getConditionSourceEffects(actor, conditionId) {
  return (actor?.appliedEffects ?? []).filter(
    (ae) => ae.parent instanceof Item && ae.statuses?.has(conditionId)
  );
}

/**
 * The item(s) supplying a condition to an actor — typically buffs listing it in their Conditions.
 *
 * @param {Actor} actor
 * @param {string} conditionId
 * @returns {Item[]}
 */
export function getConditionSourceItems(actor, conditionId) {
  return getConditionSourceEffects(actor, conditionId).map((ae) => ae.parent);
}

/**
 * The condition's Active Effect *on the actor itself*, if any.
 *
 * This — not `actor.statuses` — is the right test for "is our own marker present", because
 * `statuses` is true whenever anything supplies the condition, buffs included. Deciding whether to
 * create or drop the marker from `statuses` means never creating one while a buff is running, and
 * then losing the marker (and, on the next tick, the bleed) the moment that buff ends.
 *
 * @param {Actor} actor
 * @param {string} conditionId
 * @returns {ActiveEffect|null}
 */
export function getActorConditionEffect(actor, conditionId) {
  return actor?.effects.find((ae) => ae.statuses?.has(conditionId)) ?? null;
}

/* -------------------------------------------- *
 *  Deep Bleed availability
 *
 *  Lives here rather than in deep-bleed.mjs so the bleed engine can consult it without
 *  importing that module, which imports the engine in turn.
 * -------------------------------------------- */

/**
 * Setting key for the Astora Homebrew master switch — this module's non-RAW rules, of which Deep
 * Bleed is currently the only one.
 *
 * The stored key is still `deepBleed`, from when the setting was named for that one rule. Renaming
 * it would reset every existing world to the default and quietly switch the rule off, which is a
 * worse outcome than an internal name that no longer matches its label.
 */
export const SETTING_HOMEBREW = "deepBleed";

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
 * Both halves have to agree. pf1-critical-effects carries the same Astora Homebrew switch, and
 * dedicated healing is the mechanism this whole rule rests on — so with its switch off, a deep
 * bleed would be a wound with nothing in the game able to close it. The API stays registered
 * either way (existing wounds must remain payable); `enabled` is what says whether *new* ones may
 * be created. Its absence means an older build of that module, which had no switch to consult.
 *
 * @returns {boolean}
 */
export function deepBleedAvailable() {
  const api = dedicatedHealingApi();
  if (!api) return false;
  return api.enabled?.() !== false;
}

/**
 * Whether this world runs the Astora homebrew rules — and, since Deep Bleed is currently the only
 * one, whether a new bleed may be inflicted as a deep wound.
 *
 * Existing deep bleeds are read straight off their entries and never consult this, so turning the
 * rule off mid-campaign lets what is already on an actor be paid off and cleared normally rather
 * than stranding it.
 *
 * @returns {boolean}
 */
export function homebrewEnabled() {
  try {
    return !!game.settings.get(MODULE_ID, SETTING_HOMEBREW);
  } catch {
    return false; // setting not registered yet (pre-init callers)
  }
}

/**
 * Whether Deep Bleed should apply to newly-inflicted bleed: the house rule is on for this world
 * *and* the machinery behind it is available.
 *
 * @returns {boolean}
 */
export function deepBleedEnabled() {
  return homebrewEnabled() && deepBleedAvailable();
}
