/**
 * PF1 Bleed Effects — Deep Bleed (homebrew, off by default).
 *
 * A wound too deep to close on its own. An ordinary bleed stops the moment someone removes the
 * condition; a deep one keeps going until a set number of hit points of *dedicated healing* have
 * been poured into it — healing that would otherwise have gone to the character's own hit points.
 *
 * ── How it plugs in ──────────────────────────────────────────────────────────
 * The allocation dialog, the healing interception, and the whole notion of dedicated healing
 * belong to **pf1-critical-effects**. This module contributes nothing but a *provider*: a
 * synchronous function that reports which of an actor's bleeds are still owed healing, and a
 * callback that spends an allocation. Without that module the rule is not implemented at all —
 * no setting, no field on the prompt, no threshold accepted by the API.
 *
 * ── There is no Heal check ───────────────────────────────────────────────────
 * Unlike the injury buffs the dedicated-healing system was built for, a deep bleed has no
 * "treat it first" phase. It is eligible for healing from the instant it is inflicted. That also
 * means it needs no entry point to trigger a check, which is why this file has no UI of its own.
 *
 * ── Several deep bleeds are several wounds ───────────────────────────────────
 * Each carries its own threshold and its own running total, and each has to be paid off
 * separately — the allocation dialog lists them as separate rows. The tick engine still applies
 * only the highest roll of each kind, so two deep HP bleeds cost double to close while dealing
 * the damage of one. That is the intended reading: you are stitching two wounds, not one.
 */

import {
  MODULE_ID,
  SETTING_HOMEBREW,
  CRITICAL_EFFECTS_ID,
  criticalEffectsActive,
  dedicatedHealingApi,
  deepBleedAvailable,
  deepBleedEnabled,
  homebrewEnabled,
} from "./dot-common.mjs";
import { BleedAPI, getStoredEffects, writeEffects, deepStateOf, blockerOf } from "./bleed.mjs";

/** Provider id registered with pf1-critical-effects. */
const PROVIDER_ID = "pf1-bleed-effects.deep";

/**
 * The dedicated-healing participants an actor's deep bleeds represent.
 *
 * Must stay synchronous — pf1-critical-effects calls this from a sync hook that has to suppress
 * the incoming heal in the same tick.
 *
 * @param {Actor} actor
 * @returns {Array<object>}
 */
function deepParticipants(actor) {
  const out = [];
  // Stored effects only. Buff-supplied bleed is never deep — a wound that lasts exactly as long as
  // its buff has nothing for dedicated healing to close.
  for (const effect of getStoredEffects(actor)) {
    const deep = deepStateOf(effect);
    if (!deep) continue;

    // A blocked wound is still reported, marked rather than hidden: pf1-critical-effects lists it
    // greyed with the reason, so a healer can see there is a wound and what has to happen before
    // it will take stitches. Omitting it would just make the healing vanish unexplained.
    const blocker = blockerOf(actor, effect);

    out.push({
      id: `bleed:${effect.id}`,
      name: game.i18n.format("BLD.Deep.ParticipantName", {
        formula: effect.formula,
        kind: BleedAPI.kindLabel(effect.kind),
      }),
      required: deep.required,
      received: deep.received,
      blocked: !!blocker,
      blockedReason: blocker ? game.i18n.format("BLD.Deep.BlockedBy", { source: blocker.name }) : undefined,
      allocate: (amount) => allocate(actor, effect.id, amount),
    });
  }
  return out;
}

/**
 * Spend dedicated healing on one deep bleed.
 *
 * Reads and writes the whole effect array in one pass rather than per entry: two deep bleeds
 * allocated in the same dialog would otherwise race, and the second write would carry a stale
 * copy of the first.
 *
 * @param {Actor} actor
 * @param {string} effectId
 * @param {number} amount
 * @returns {Promise<boolean>} Whether that closed the wound.
 */
async function allocate(actor, effectId, amount) {
  const effects = getStoredEffects(actor);
  const index = effects.findIndex((e) => e.id === effectId);
  if (index === -1) return false;

  const deep = deepStateOf(effects[index]);
  if (!deep) return false;

  // The dialog renders no input for a blocked wound, so this shouldn't be reachable — but the
  // callback is handed out to another module and the block can lapse between enumeration and
  // allocation. Refuse rather than quietly accept healing the rule says can't be spent.
  if (blockerOf(actor, effects[index])) return false;

  const received = Math.min(deep.received + Math.max(0, amount), deep.required);
  const closed = received >= deep.required;

  if (closed) effects.splice(index, 1);
  else effects[index].deep = { required: deep.required, received };

  // writeEffects drops the condition marker too, once this was the last bleed on the actor.
  await writeEffects(actor, effects);
  return closed;
}

/* -------------------------------------------- *
 *  Registration
 * -------------------------------------------- */

Hooks.once("init", () => {
  // Always shown, unlike the Deep Bleed setting it replaces. That one was hidden when
  // pf1-critical-effects wasn't active, on the grounds that a setting doing nothing is worse than
  // no setting — sound while it governed exactly one rule that needed that module, but wrong for
  // a switch that stands for the module's homebrew as a whole and is meant to be found in the
  // same place, saying the same thing, as pf1-critical-effects' own. What Deep Bleed additionally
  // requires is stated in the hint, and enforced by deepBleedAvailable().
  game.settings.register(MODULE_ID, SETTING_HOMEBREW, {
    name: "BLD.Settings.Homebrew.Name",
    hint: "BLD.Settings.Homebrew.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });
});

Hooks.once("ready", () => {
  const api = dedicatedHealingApi();

  if (!api) {
    // Active but no integration surface means a version mismatch, not a missing module — the
    // setting is visible and possibly on, so this must not fail silently.
    if (criticalEffectsActive() && game.user.isGM) {
      ui.notifications.warn(
        `${MODULE_ID}: ${CRITICAL_EFFECTS_ID} is active but exposes no dedicated-healing API — Deep Bleed is inactive. Update it.`
      );
    }
    return;
  }

  // Registered whether or not either switch is on. Turning homebrew off stops *new* deep bleeds
  // (see deepBleedEnabled); anything already on an actor stays payable, so a mid-campaign toggle
  // doesn't strand a wound nobody can close.
  api.registerProvider(PROVIDER_ID, deepParticipants);

  // Homebrew on here but off in the module that supplies the healing: the GM has switched on a
  // rule that cannot run, and nothing else would say so. Every deep bleed would silently be
  // inflicted as an ordinary one.
  if (homebrewEnabled() && api.enabled?.() === false && game.user.isGM) {
    ui.notifications.warn(
      `${MODULE_ID}: Astora Homebrew is on here but off in ${CRITICAL_EFFECTS_ID}, which supplies the dedicated healing Deep Bleed needs — no new deep bleeds will be inflicted. Switch it on there too.`
    );
  }
});

export const DeepBleedAPI = {
  available: deepBleedAvailable,
  enabled: deepBleedEnabled,
  homebrew: homebrewEnabled,
};
