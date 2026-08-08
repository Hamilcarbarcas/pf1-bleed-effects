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
  SETTING_DEEP,
  CRITICAL_EFFECTS_ID,
  criticalEffectsActive,
  dedicatedHealingApi,
  deepBleedAvailable,
  deepBleedEnabled,
} from "./dot-common.mjs";
import { BleedAPI, getEffects, writeEffects, deepStateOf } from "./bleed.mjs";

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
  for (const effect of getEffects(actor)) {
    const deep = deepStateOf(effect);
    if (!deep) continue;
    out.push({
      id: `bleed:${effect.id}`,
      name: game.i18n.format("BLD.Deep.ParticipantName", {
        formula: effect.formula,
        kind: BleedAPI.kindLabel(effect.kind),
      }),
      required: deep.required,
      received: deep.received,
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
  const effects = getEffects(actor);
  const index = effects.findIndex((e) => e.id === effectId);
  if (index === -1) return false;

  const deep = deepStateOf(effects[index]);
  if (!deep) return false;

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
  // Hidden outright when pf1-critical-effects isn't switched on: a setting that silently does
  // nothing is worse than no setting.
  //
  // The test is module activeness, NOT the presence of its API — see criticalEffectsActive().
  // Init listeners run in module load order and this module sorts first, so the API is reliably
  // absent at this point even on a world where both are installed.
  game.settings.register(MODULE_ID, SETTING_DEEP, {
    name: "BLD.Settings.DeepBleed.Name",
    hint: "BLD.Settings.DeepBleed.Hint",
    scope: "world",
    config: criticalEffectsActive(),
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

  // Registered whether or not the setting is on. Turning the rule off stops *new* deep bleeds
  // (see deepBleedEnabled in bleed.mjs); anything already on an actor stays payable, so a mid-
  // campaign toggle doesn't strand a wound nobody can close.
  api.registerProvider(PROVIDER_ID, deepParticipants);
});

export const DeepBleedAPI = { available: deepBleedAvailable, enabled: deepBleedEnabled };
