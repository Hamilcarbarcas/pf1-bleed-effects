/**
 * PF1 Bleed Effects — healing closes ordinary bleeds.
 *
 * "Bleed damage can be stopped with a DC 15 Heal check or through the application of any magical
 * healing." This is the second half: hit-point healing applied to a bleeding creature stops the
 * bleeding, without anyone having to remember to click the condition off.
 *
 * **What counts as healing, and why the distinction is exact rather than a guess.** Everything that
 * heals a creature in PF1 — a cure spell, a potion, channelled energy, the Apply Healing button on a
 * chat card, the apply-damage dialog in healing mode, another module's automation — arrives through
 * `ActorPF#applyDamage()` with a negative value, which fires `pf1ApplyDamage`. Typing a number into
 * the actor sheet's hit point field, or into the token HUD's health bar, does not: the sheet writes
 * `actor.update()` directly, and the HUD goes through `ActorPF#modifyTokenAttribute()`, which builds
 * its own update and calls `doc.update(updates)` without ever reaching `applyDamage`. So hooking
 * `pf1ApplyDamage` gives us "healed, but not hand-edited" precisely, rather than by heuristic — a
 * GM fixing up a number is book-keeping, not treatment, and it leaves the bleeding alone.
 *
 * **Which bleeds stop.** All stored ones, hit point and ability alike. Two are out of reach by
 * construction, and both are correct:
 *
 *  - **Deep bleeds** survive, because that is the entire point of them — they close only through
 *    dedicated healing, and `clear()` already leaves them alone unless forced.
 *  - **Buff-supplied bleed** survives, because it isn't stored anywhere to remove; the buff
 *    re-supplies it every time the effect list is read. Switch the buff off.
 */

import { MODULE_ID } from "./dot-common.mjs";
import { BleedAPI, deepStateOf } from "./bleed.mjs";

const SETTING_HEALING = "healingStopsBleed";

/**
 * Whether healing should stop bleeding in this world.
 *
 * @returns {boolean}
 */
function enabled() {
  try {
    return !!game.settings.get(MODULE_ID, SETTING_HEALING);
  } catch {
    return false; // setting not registered yet
  }
}

/**
 * The hit point pool `applyDamage` will actually adjust, mirroring how it picks one itself.
 *
 * @param {Actor} actor
 * @returns {{value:number, max:number}|null}
 */
function healthPool(actor) {
  try {
    const config = game.settings.get("pf1", "healthConfig");
    const useWoundsAndVigor = config?.getActorConfig?.(actor)?.rules?.useWoundsAndVigor ?? false;
    return (useWoundsAndVigor ? actor.system?.attributes?.vigor : actor.system?.attributes?.hp) ?? null;
  } catch {
    return actor?.system?.attributes?.hp ?? null;
  }
}

/**
 * Whether this application will actually restore hit points.
 *
 * Decided up front from the options rather than by watching for the update that follows, which
 * keeps the whole feature synchronous and free of any race between the hook and the write. The
 * arithmetic isn't duplicated — only the three conditions under which `applyDamage` moves no hit
 * points at all:
 *
 *  - `asNonlethal` healing reduces the nonlethal pool and leaves `hp.value` untouched.
 *  - `asWounds` healing goes to wounds under the Wounds & Vigor rules, not to the pool.
 *  - A creature already at full has nothing to regain.
 *
 * @param {Actor} actor
 * @param {object} options - The options `applyDamage` was called with.
 * @returns {boolean}
 */
function restoresHitPoints(actor, options) {
  if (!(Number(options?.value) < 0)) return false; // damage, or nothing
  if (options?.asNonlethal || options?.asWounds) return false;

  const pool = healthPool(actor);
  if (!pool) return false;
  return Number(pool.value) < Number(pool.max);
}

/**
 * Announce that the bleeding stopped, so an effect vanishing off the condition tooltip isn't
 * something the table has to notice for itself.
 *
 * @param {Actor} actor
 * @param {number} count
 */
async function postCard(actor, count) {
  const text = game.i18n.format("BLD.Healing.Stops", { name: `<strong>${actor.name}</strong>`, count });
  const content = `<div class="pf1-bleed-card pf1-bleed-healed">
    <p><i class="fa-solid fa-bandage"></i> ${text}</p>
  </div>`;
  await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }) });
}

/**
 * Stop a healed creature's ordinary bleeding.
 *
 * Runs on whichever client applied the healing, which `applyDamage` guarantees is an owner — so the
 * flag write is permitted without a socket round-trip. `clear()` still routes to the active GM by
 * itself in the case an owner somehow isn't present.
 *
 * @param {Actor} actor
 */
async function stopBleeding(actor) {
  // Only the non-deep entries are removable, so only those should trigger a card.
  const removable = BleedAPI.listStored(actor).filter((effect) => !deepStateOf(effect));
  if (!removable.length) return;

  await BleedAPI.clear(actor);
  await postCard(actor, removable.length);
}

/* -------------------------------------------- *
 *  Registration
 * -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_HEALING, {
    name: "BLD.Settings.HealingStops.Name",
    hint: "BLD.Settings.HealingStops.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });
});

/**
 * Fires from `ActorPF#applyDamage()` only — see the note at the top of this file for why that is
 * exactly the line between healing and hand-editing a hit point total.
 */
Hooks.on("pf1ApplyDamage", (actor, options) => {
  if (!enabled()) return;
  if (!(actor instanceof Actor)) return;

  // The applying client is an owner; anyone else seeing this hook would be racing it.
  if (!actor.isOwner) return;

  if (!restoresHitPoints(actor, options)) return;

  stopBleeding(actor).catch((err) => console.error(`${MODULE_ID} | Failed to stop bleeding on heal`, err));
});
