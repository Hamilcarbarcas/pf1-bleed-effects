/**
 * PF1 Bleed Effects — core engine.
 *
 * Bleed effects are stored as an array on a single actor flag. At the start of
 * each bleeding actor's turn the active GM rolls every effect, groups them by
 * "kind" (hp, or <ability>.<damage|drain>), and applies the *highest rolled
 * result* of each kind — so two HP bleeds don't stack, but an HP bleed and a
 * Con bleed both land in the same round.
 *
 * The PF1 `bleed` condition is kept in sync purely as the visual marker; this
 * flag array is the source of truth for how much damage it deals.
 *
 * An effect may additionally be *deep* (`entry.deep`), the optional homebrew rule wired up in
 * deep-bleed.mjs: it cannot be stopped by removing the condition, only by pouring a threshold of
 * dedicated healing into it. Nothing in the tick engine treats a deep effect differently — it
 * rolls and lands like any other. The difference is entirely in how it *ends*.
 */

import { MODULE_ID, SOCKET, resolveActor, isActiveGM, deepBleedEnabled } from "./dot-common.mjs";

export { MODULE_ID };

const FLAG_KEY = "effects";
const CONDITION_ID = "bleed";

const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"];
const MODES = ["damage", "drain"];

/**
 * In-memory guard so a single turn isn't ticked twice when `updateCombat`
 * fires more than once for the same advance. Only the active GM ticks, so a
 * module-level value is sufficient.
 *
 * @type {string|null}
 */
let lastTickKey = null;

/* -------------------------------------------- *
 *  Kind helpers
 * -------------------------------------------- */

/**
 * Parse and validate a bleed "kind".
 *
 * @param {string} kind - "hp" or "<abl>.<damage|drain>" (e.g. "con.damage").
 * @returns {{track:"hp"}|{track:"ability",ability:string,mode:string}|null}
 */
export function parseKind(kind) {
  if (!kind || kind === "hp") return { track: "hp" };
  const [ability, mode = "damage"] = String(kind).toLowerCase().split(".");
  if (!ABILITIES.includes(ability) || !MODES.includes(mode)) return null;
  return { track: "ability", ability, mode };
}

/**
 * Normalize a kind string to its canonical form, or null if invalid.
 *
 * @param {string} kind
 * @returns {string|null}
 */
export function canonicalKind(kind) {
  const parsed = parseKind(kind);
  if (!parsed) return null;
  return parsed.track === "hp" ? "hp" : `${parsed.ability}.${parsed.mode}`;
}

/**
 * Human-readable label for a kind, used in chat output and tooltips.
 *
 * @param {string} kind
 * @returns {string}
 */
export function kindLabel(kind) {
  const parsed = parseKind(kind);
  if (!parsed || parsed.track === "hp") return game.i18n.localize("BLD.Kind.HP");
  const ablName = pf1.config.abilities[parsed.ability] ?? parsed.ability.toUpperCase();
  return `${ablName} ${game.i18n.localize(parsed.mode === "drain" ? "BLD.Kind.Drain" : "BLD.Kind.Damage")}`;
}

/* -------------------------------------------- *
 *  Helpers
 * -------------------------------------------- */

/**
 * Get a deep clone of the actor's bleed effect array (safe to mutate).
 *
 * @param {Actor} actor
 * @returns {Array<{id:string,formula:string,kind:string,deep?:{required:number,received:number}}>}
 */
export function getEffects(actor) {
  return foundry.utils.deepClone(actor.getFlag(MODULE_ID, FLAG_KEY) ?? []);
}

/**
 * Write the effect array back, clearing the flag and the condition when nothing is left.
 * Every mutation path funnels through here so the condition marker can't drift.
 *
 * @param {Actor} actor
 * @param {Array} effects
 */
export async function writeEffects(actor, effects) {
  if (effects.length) await actor.setFlag(MODULE_ID, FLAG_KEY, effects);
  else await actor.unsetFlag(MODULE_ID, FLAG_KEY);

  const hasCondition = actor.statuses.has(CONDITION_ID);
  if (effects.length && !hasCondition) await actor.setCondition(CONDITION_ID, true);
  else if (!effects.length && hasCondition) await actor.setCondition(CONDITION_ID, false);
  return effects;
}

/**
 * Normalized deep-bleed state for an effect, or null when it isn't deep.
 *
 * @param {{deep?:{required:number,received:number}}} effect
 * @returns {{required:number,received:number,remaining:number}|null}
 */
export function deepStateOf(effect) {
  const required = Number(effect?.deep?.required) || 0;
  if (required <= 0) return null;
  const received = Math.min(Number(effect?.deep?.received) || 0, required);
  return { required, received, remaining: required - received };
}

/**
 * Substitute `@`-references (e.g. `@cl`) using the given roll data while
 * leaving dice terms intact, so `1d6` rolls fresh each round but `@cl` is
 * locked to the source's value at application time.
 *
 * @param {string} formula
 * @param {object} rollData
 * @returns {string}
 */
function resolveFormula(formula, rollData) {
  try {
    return pf1.dice.RollPF.replaceFormulaData(String(formula), rollData ?? {}, { missing: "0" });
  } catch (err) {
    console.error(`${MODULE_ID} | Failed to resolve formula`, formula, err);
    return String(formula);
  }
}

/* -------------------------------------------- *
 *  Owner-side mutations
 * -------------------------------------------- */

/**
 * Add a bleed effect to an actor we own and ensure the condition is shown.
 *
 * @param {Actor} actor
 * @param {{formula:string,kind:string,deepRequired?:number}} effect
 */
async function _applyLocal(actor, { formula, kind, deepRequired = 0 }) {
  const effects = getEffects(actor);
  const entry = { id: foundry.utils.randomID(), formula: String(formula), kind };

  // Deep only when the homebrew rule is live: a threshold with no allocation dialog behind it
  // would be an unclearable bleed.
  const required = Math.max(0, Math.floor(Number(deepRequired) || 0));
  if (required > 0 && deepBleedEnabled()) entry.deep = { required, received: 0 };

  effects.push(entry);
  return writeEffects(actor, effects);
}

/**
 * Remove some or all bleed effects from an actor we own; clears the condition
 * once nothing is left.
 *
 * Deep bleeds survive this unless `force` is set — that is the whole point of them. A GM who
 * needs one gone anyway calls `clear(actor, { force: true })`.
 *
 * @param {Actor} actor
 * @param {{kind?:string,force?:boolean}} [options]
 */
async function _clearLocal(actor, { kind, force = false } = {}) {
  const canon = kind ? canonicalKind(kind) : null;
  // A kind that was given but doesn't parse matches nothing, rather than falling through to
  // "clear everything" — the same way it behaved before deep bleeds existed.
  if (kind && !canon) return getEffects(actor);

  const effects = getEffects(actor).filter((e) => {
    if (canon && e.kind !== canon) return true; // out of scope for this clear
    return !force && !!deepStateOf(e);          // in scope: kept only if deep and not forced
  });

  return writeEffects(actor, effects);
}

/* -------------------------------------------- *
 *  Public API (GM-routed)
 * -------------------------------------------- */

/**
 * Register an ongoing bleed effect on a target.
 *
 * If the caller doesn't own the target (e.g. a player applying bleed to an
 * enemy), the request is routed to the active GM via socket.
 *
 * @param {Actor|Token|TokenDocument|string} ref - Target actor/token/uuid.
 * @param {object} options
 * @param {string} options.formula - Damage formula, e.g. "1d6" or "@cl".
 * @param {string} [options.kind="hp"] - "hp" or "<abl>.<damage|drain>".
 * @param {object} [options.sourceRollData] - Roll data used to resolve
 *   `@`-references at application time (the inflicting actor's data).
 * @param {number} [options.deepRequired=0] - Homebrew Deep Bleed: hit points of dedicated
 *   healing needed to close the wound. The bleed then cannot be removed by clearing the
 *   condition. Ignored unless the Deep Bleed setting is on and pf1-critical-effects is active.
 * @returns {Promise<Array|null>}
 */
async function apply(ref, { formula, kind = "hp", sourceRollData, deepRequired = 0 } = {}) {
  const actor = resolveActor(ref);
  if (!actor) {
    ui.notifications.error(game.i18n.localize("BLD.Error.NoTarget"));
    return null;
  }
  if (!formula) {
    ui.notifications.error(game.i18n.localize("BLD.Error.NoFormula"));
    return null;
  }
  const canon = canonicalKind(kind);
  if (!canon) {
    ui.notifications.error(game.i18n.format("BLD.Error.InvalidType", { kind }));
    return null;
  }

  // Lock @-references now (dice survive for per-round rolling).
  const resolved = resolveFormula(formula, sourceRollData ?? actor.getRollData());

  if (actor.isOwner) return _applyLocal(actor, { formula: resolved, kind: canon, deepRequired });

  game.socket.emit(SOCKET, {
    action: "apply",
    actorUuid: actor.uuid,
    payload: { formula: resolved, kind: canon, deepRequired },
  });
  return null;
}

/**
 * Remove bleed from a target (a single kind, or all of it).
 *
 * @param {Actor|Token|TokenDocument|string} ref
 * @param {{kind?:string,force?:boolean}} [options] - `force` also removes deep bleeds, which
 *   otherwise survive every clear until their dedicated healing is paid.
 * @returns {Promise<Array|null>}
 */
async function clear(ref, { kind, force = false } = {}) {
  const actor = resolveActor(ref);
  if (!actor) return null;

  if (actor.isOwner) return _clearLocal(actor, { kind, force });

  game.socket.emit(SOCKET, { action: "clear", actorUuid: actor.uuid, payload: { kind, force } });
  return null;
}

/**
 * Inspect the bleed effects currently on a target.
 *
 * @param {Actor|Token|TokenDocument|string} ref
 * @returns {Array<{id:string,formula:string,kind:string}>}
 */
function list(ref) {
  const actor = resolveActor(ref);
  return actor ? getEffects(actor) : [];
}

/**
 * Display-ready description of a target's bleed effects.
 *
 * @param {Actor|Token|TokenDocument|string} ref
 * @returns {Array<{kind:string,label:string,formula:string,deep:{required:number,received:number,remaining:number}|null}>}
 */
function describe(ref) {
  const actor = resolveActor(ref);
  if (!actor) return [];
  return getEffects(actor).map((e) => ({
    kind: e.kind,
    label: kindLabel(e.kind),
    formula: e.formula,
    deep: deepStateOf(e),
  }));
}

/* -------------------------------------------- *
 *  Tick engine
 * -------------------------------------------- */

/**
 * Roll and apply one round of bleed for a single actor.
 *
 * @param {Actor} actor
 */
async function tickActor(actor) {
  // If the condition was removed by hand, treat that as "bleeding stopped" — except for deep
  // bleeds, which _clearLocal keeps and writeEffects then re-marks. Those go on ticking.
  if (!actor.statuses.has(CONDITION_ID)) {
    if (!getEffects(actor).length) return;
    if (!(await _clearLocal(actor)).length) return;
  }

  const effects = getEffects(actor);
  if (!effects.length) return;

  const rollData = actor.getRollData();

  // Roll each effect; keep only the highest result of each kind.
  const byKind = new Map();
  for (const eff of effects) {
    const roll = await pf1.dice.RollPF.safeRoll(eff.formula, rollData);
    const total = Math.max(0, Math.floor(roll.total || 0));
    const prev = byKind.get(eff.kind);
    if (!prev || total > prev) byKind.set(eff.kind, total);
  }

  const lines = [];
  const abilityUpdates = {};

  for (const [kind, total] of byKind) {
    if (total <= 0) continue;
    const parsed = parseKind(kind);
    if (parsed.track === "hp") {
      // Instance applyDamage: no DR/ER, no dialog, temp-HP aware.
      await actor.applyDamage(total);
    } else {
      const path = `system.abilities.${parsed.ability}.${parsed.mode}`;
      const current = foundry.utils.getProperty(actor, path) ?? 0;
      abilityUpdates[path] = current + total;
    }
    lines.push(`${total} ${kindLabel(kind)}`);
  }

  if (Object.keys(abilityUpdates).length) await actor.update(abilityUpdates);
  if (lines.length) await postBleedCard(actor, lines);
}

/**
 * Post a chat card summarizing a round of bleed.
 *
 * @param {Actor} actor
 * @param {string[]} lines
 */
async function postBleedCard(actor, lines) {
  const suffers = game.i18n.format("BLD.Card.Suffers", { name: `<strong>${actor.name}</strong>` });
  const content = `<div class="pf1-bleed-card">
    <p><i class="fa-solid fa-droplet"></i> ${suffers}</p>
    <ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>
  </div>`;
  await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }) });
}

/**
 * `updateCombat` handler: tick the actor whose turn just started.
 *
 * @param {Combat} combat
 * @param {object} changed
 */
function onUpdateCombat(combat, changed) {
  if (!isActiveGM()) return; // exactly one executor
  if (!combat.started) return;
  if (changed.round === undefined && changed.turn === undefined) return;

  const combatant = combat.combatant;
  const actor = combatant?.actor;
  if (!actor) return;
  if (combatant.isDefeated) return;

  const key = `${combat.id}:${combat.round}:${combat.turn}`;
  if (key === lastTickKey) return;
  lastTickKey = key;

  tickActor(actor);
}

/* -------------------------------------------- *
 *  Socket handling
 * -------------------------------------------- */

/**
 * Execute apply/clear requests routed from non-owning clients.
 *
 * @param {{action:string,actorUuid:string,payload:object}} data
 */
function onSocket(data) {
  if (!isActiveGM()) return; // only the active GM performs the write
  const actor = resolveActor(data.actorUuid);
  if (!actor) return;
  if (data.action === "apply") _applyLocal(actor, data.payload);
  else if (data.action === "clear") _clearLocal(actor, data.payload ?? {});
}

/* -------------------------------------------- *
 *  Registration
 * -------------------------------------------- */

export const BleedAPI = { apply, clear, list, describe, tickActor, parseKind, canonicalKind, kindLabel };

Hooks.once("init", () => {
  // Merge (don't overwrite): the burning engine also contributes to `module.api`.
  const mod = game.modules.get(MODULE_ID);
  mod.api ??= {};
  Object.assign(mod.api, BleedAPI);
  globalThis.pf1BleedEffects = BleedAPI; // convenience for macros
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, onSocket);
});

Hooks.on("updateCombat", onUpdateCombat);

/**
 * When the bleed condition is removed by any means (token HUD, sheet, another
 * module), drop the stored effects so they don't linger and accumulate on the
 * next application. Fires only on the client that toggled it (an owner).
 *
 * Deep bleeds are the exception: _clearLocal keeps them and re-marks the condition, so clicking
 * the icon off simply doesn't take. Say so, or it reads as a bug rather than the rule.
 */
Hooks.on("pf1ToggleActorCondition", async (actor, conditionId, state) => {
  if (state || conditionId !== CONDITION_ID) return; // only when bleed turns OFF
  if (!actor?.isOwner) return;
  if (!actor.getFlag(MODULE_ID, FLAG_KEY)?.length) return;

  const survivors = await _clearLocal(actor);
  if (!survivors.length) return;

  const remaining = survivors.reduce((sum, e) => sum + (deepStateOf(e)?.remaining ?? 0), 0);
  ui.notifications.warn(
    game.i18n.format("BLD.Deep.CannotClear", { name: actor.name, remaining })
  );
});
