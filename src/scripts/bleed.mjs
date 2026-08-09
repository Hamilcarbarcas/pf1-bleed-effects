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
 *
 * ── Buff-supplied bleed ──────────────────────────────────────────────────────
 * A PF1 buff can list `bleed` among its Conditions, in which case the buff governs the condition's
 * whole lifetime. Such bleed is **derived, never stored**: an entry is synthesized from the buff's
 * own configuration flag every time the effect list is read, and simply stops existing when the
 * buff switches off. Nothing is written on activation and nothing needs cleaning up afterwards, so
 * a buff's bleed can't outlive it, can't be orphaned by a duration expiring, and can't be clicked
 * off independently of the buff. Stored entries and derived entries meet only in the tick engine's
 * highest-of-kind grouping, which already knows how to reconcile overlapping bleed.
 */

import {
  MODULE_ID,
  SOCKET,
  resolveActor,
  isActiveGM,
  deepBleedEnabled,
  getConditionSourceItems,
  getActorConditionEffect,
} from "./dot-common.mjs";

export { MODULE_ID };

const FLAG_KEY = "effects";
const CONDITION_ID = "bleed";

/** Item flag holding a buff's bleed configuration: `{ formula, kind }`. */
export const BUFF_FLAG = "bleed";

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
 * Get a deep clone of the actor's *stored* bleed effects — the actor-flag array, and the only
 * thing any mutation path may touch. Buff-supplied bleed is derived rather than stored, so it
 * deliberately isn't here: writing it back would turn a borrowed entry into a permanent one.
 *
 * @param {Actor} actor
 * @returns {Array<{id:string,formula:string,kind:string,deep?:{required:number,received:number}}>}
 */
export function getStoredEffects(actor) {
  return foundry.utils.deepClone(actor.getFlag(MODULE_ID, FLAG_KEY) ?? []);
}

/**
 * A buff's bleed configuration, normalized, or null when it has none worth acting on.
 *
 * @param {Item} item
 * @returns {{formula:string,kind:string,persists:boolean,deep:number,blocks:boolean}|null}
 */
export function buffBleedConfig(item) {
  const config = item?.getFlag(MODULE_ID, BUFF_FLAG);
  const formula = String(config?.formula ?? "").trim();
  if (!formula) return null; // marker-only buff: the vanilla inert condition

  const persists = config.mode === "persist";
  return {
    formula,
    kind: canonicalKind(config.kind) ?? "hp",
    persists,
    // Deep and its healing block are the province of a wound that outlives its buff. A bleed that
    // ends when the buff does has nothing for dedicated healing to close.
    deep: persists ? Math.max(0, Math.floor(Number(config.deep) || 0)) : 0,
    blocks: persists && !!config.blocks,
  };
}

/**
 * Synthesize bleed entries from the buffs currently supplying the bleed condition.
 *
 * Only buffs whose bleed lasts *while active* appear here. A buff configured to leave a wound
 * behind stamps a stored entry when it activates instead (see the stamping hook below) — deriving
 * that one as well would double it while the buff ran and then lose it entirely.
 *
 * Derived entries carry a live `source` item and never a `deep` threshold.
 *
 * @param {Actor} actor
 * @returns {Array<{id:string,formula:string,kind:string,source:Item}>}
 */
export function getBuffEffects(actor) {
  const out = [];
  for (const item of getConditionSourceItems(actor, CONDITION_ID)) {
    const config = buffBleedConfig(item);
    if (!config || config.persists) continue;
    out.push({ id: `buff:${item.id}`, formula: config.formula, kind: config.kind, source: item });
  }
  return out;
}

/**
 * Every bleed effect on an actor, stored and buff-supplied alike. Read-only: the derived half has
 * no home to be written back to.
 *
 * @param {Actor} actor
 * @returns {Array<object>}
 */
export function getEffects(actor) {
  return [...getStoredEffects(actor), ...getBuffEffects(actor)];
}

/**
 * Write the stored effect array back, clearing the flag and the condition when nothing is left.
 * Every mutation path funnels through here so the condition marker can't drift.
 *
 * The marker test is deliberately for an *actor-level* effect rather than `actor.statuses`: a buff
 * supplying bleed already satisfies `statuses`, and treating that as "the marker is handled" would
 * mean never creating one of our own — so the moment the buff ended the condition would vanish
 * while the stored bleeds remained, and the next tick would read that as "cleared by hand" and
 * silently delete them. Two effects both carrying the status is harmless; the sheet shows one
 * condition either way.
 *
 * @param {Actor} actor
 * @param {Array} effects
 */
export async function writeEffects(actor, effects) {
  if (effects.length) await actor.setFlag(MODULE_ID, FLAG_KEY, effects);
  else await actor.unsetFlag(MODULE_ID, FLAG_KEY);

  const marker = getActorConditionEffect(actor, CONDITION_ID);
  if (effects.length && !marker) await actor.setCondition(CONDITION_ID, true);
  else if (!effects.length && marker) await actor.setCondition(CONDITION_ID, false);
  return effects;
}

/**
 * Reduce an item reference to the plain item id used in stored entries.
 *
 * An id rather than a uuid on purpose. The referenced item is always on the same actor as the
 * bleed, so an id is sufficient; uuids for items on unlinked token actors are long, scene-bound,
 * and break the moment anything is copied. It also fails in the safe direction — an item deleted
 * and re-added comes back with a new id, which reads as "gone", and a wound that has lost its
 * blocker becomes healable rather than permanently stuck.
 *
 * @param {Item|string} [ref] - An Item, its id, or its uuid.
 * @param {Actor} actor - The actor the item is expected to live on.
 * @returns {string|undefined}
 */
export function itemIdOf(ref, actor) {
  if (!ref) return undefined;
  if (ref instanceof Item) return ref.id;
  const value = String(ref);
  if (actor?.items.has(value)) return value; // already an id
  const doc = value.includes(".") ? fromUuidSync(value) : null;
  return doc instanceof Item ? doc.id : undefined;
}

/**
 * The item currently blocking an effect from receiving dedicated healing, if any.
 *
 * A blocker only counts while it is *on the actor and active*. Deleted or switched off, healing
 * flows again — the arrow has been pulled out. Never stranding a wound matters more here than
 * enforcing the block strictly: a blocker that has vanished for any reason at all resolves to
 * "not blocked" rather than to an unclosable bleed.
 *
 * @param {Actor} actor
 * @param {{blockedBy?:string}} effect
 * @returns {Item|null}
 */
export function blockerOf(actor, effect) {
  if (!effect?.blockedBy) return null;
  const item = actor?.items.get(effect.blockedBy);
  if (!item) return null;
  // `isActive` is the buff's on/off switch, and `true` on item types that have no such notion.
  // Anything falsy resolves to unblocked, keeping the failure direction consistent: a blocker we
  // can't confirm lets the healing through rather than sealing the wound shut forever.
  return item.isActive ? item : null;
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
 * @param {{formula:string,kind:string,deepRequired?:number,blockedBy?:string,origin?:string}} effect
 */
async function _applyLocal(actor, { formula, kind, deepRequired = 0, blockedBy, origin }) {
  const effects = getStoredEffects(actor);
  const entry = { id: foundry.utils.randomID(), formula: String(formula), kind };

  // Deep only when the homebrew rule is live: a threshold with no allocation dialog behind it
  // would be an unclearable bleed.
  const required = Math.max(0, Math.floor(Number(deepRequired) || 0));
  if (required > 0 && deepBleedEnabled()) {
    entry.deep = { required, received: 0 };
    // Only meaningful on a deep bleed: it gates the dedicated healing, and an ordinary bleed
    // receives none. Carrying it on one anyway would be dead data that looks load-bearing.
    if (blockedBy) entry.blockedBy = blockedBy;
  }

  // Which item stamped this, so re-activating the same buff doesn't inflict a second copy.
  if (origin) entry.origin = origin;

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
 * Buff-supplied bleed is out of reach here by construction — it isn't stored, so there is nothing
 * to remove. Switch the buff off instead.
 *
 * @param {Actor} actor
 * @param {{kind?:string,force?:boolean}} [options]
 */
async function _clearLocal(actor, { kind, force = false } = {}) {
  const canon = kind ? canonicalKind(kind) : null;
  // A kind that was given but doesn't parse matches nothing, rather than falling through to
  // "clear everything" — the same way it behaved before deep bleeds existed.
  if (kind && !canon) return getStoredEffects(actor);

  const effects = getStoredEffects(actor).filter((e) => {
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
 * @param {Item|string} [options.blockedBy] - An item on the same actor that must be gone (or
 *   switched off) before this wound will accept dedicated healing — the arrow still in it. Only
 *   meaningful alongside `deepRequired`. Accepts an Item, its id, or its uuid.
 * @param {Item|string} [options.origin] - The item that inflicted this bleed, recorded so the
 *   same one can't stamp a duplicate. Set by the buff configuration; rarely useful by hand.
 * @returns {Promise<Array|null>}
 */
async function apply(
  ref,
  { formula, kind = "hp", sourceRollData, deepRequired = 0, blockedBy, origin } = {}
) {
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

  const payload = {
    formula: resolved,
    kind: canon,
    deepRequired,
    blockedBy: itemIdOf(blockedBy, actor),
    origin: itemIdOf(origin, actor),
  };

  if (actor.isOwner) return _applyLocal(actor, payload);

  game.socket.emit(SOCKET, { action: "apply", actorUuid: actor.uuid, payload });
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
 * The stored bleed effects only — what `clear()` can actually remove. Buff-supplied bleed is
 * excluded; it ends with its buff.
 *
 * @param {Actor|Token|TokenDocument|string} ref
 * @returns {Array<object>}
 */
function listStored(ref) {
  const actor = resolveActor(ref);
  return actor ? getStoredEffects(actor) : [];
}

/**
 * Display-ready description of a target's bleed effects.
 *
 * @param {Actor|Token|TokenDocument|string} ref
 * @returns {Array<{kind:string,label:string,formula:string,deep:object|null,source:string|null,
 *   blockedBy:string|null}>}
 */
function describe(ref) {
  const actor = resolveActor(ref);
  if (!actor) return [];
  return getEffects(actor).map((e) => ({
    kind: e.kind,
    label: kindLabel(e.kind),
    formula: e.formula,
    deep: deepStateOf(e),
    source: e.source?.name ?? null,
    blockedBy: blockerOf(actor, e)?.name ?? null,
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
  // Our own marker being gone means the condition was removed by hand, which stops the stored
  // bleeds — except for deep ones, which _clearLocal keeps and writeEffects then re-marks. The
  // test is for the actor-level effect specifically: a buff supplying the condition keeps
  // `statuses` true, and reading that as "still marked" would leave stored bleeds ticking on
  // invisibly after someone clicked the icon off.
  if (getStoredEffects(actor).length && !getActorConditionEffect(actor, CONDITION_ID)) {
    await _clearLocal(actor);
  }

  const effects = getEffects(actor);
  if (!effects.length) return;

  const actorRollData = actor.getRollData();

  // Roll each effect; keep only the highest result of each kind.
  const byKind = new Map();
  for (const eff of effects) {
    // Stored bleed had its `@`-references locked to the inflicting actor when it was applied.
    // Buff-supplied bleed has no such moment, so it resolves against the buff each round — which
    // is what makes `@item.level` scaling work, and means `@cl` is the *carrier's*, not the
    // caster's. Anything caster-locked has to be stamped onto the buff when it is handed out.
    const rollData = eff.source?.getRollData() ?? actorRollData;
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

export const BleedAPI = {
  apply,
  clear,
  list,
  listStored,
  describe,
  tickActor,
  parseKind,
  canonicalKind,
  kindLabel,
};

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
 *
 * A buff switching off also fires this hook (its condition effect is deleted, and the delete
 * bubbles up to the actor), which must not take unrelated stored bleeds with it. It can't:
 * writeEffects keeps an actor-level marker of our own alongside the buff's, so while anything is
 * stored the status outlives the buff's effect and PF1 never reports the condition as having
 * turned off. If nothing is stored, the guard below returns anyway.
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

/**
 * Buffs configured to leave a wound behind: stamp a stored bleed when one activates.
 *
 * This is the one place the feature writes state on a hook, and it is unavoidable — the whole
 * point of the mode is a bleed that is still there after the buff has gone, which nothing derived
 * can express. A wound the arrow made doesn't close when the arrow comes out.
 *
 * Two guards keep it from misfiring. `pf1ToggleActorBuff` is called on *every* client, so only the
 * active GM writes; and the entry records which buff stamped it, so re-activating the same buff
 * doesn't inflict a second wound while the first is still open.
 *
 * @param {Actor} actor
 * @param {Item} item
 * @param {boolean} state
 */
Hooks.on("pf1ToggleActorBuff", async (actor, item, state) => {
  if (!state || !isActiveGM() || !actor) return;
  // Read the buff's own Conditions rather than the actor's statuses: this hook fires from the
  // buff's update, and whether its condition effect has been created yet is not ours to assume.
  if (!item?.system.conditions?.includes(CONDITION_ID)) return;

  const config = buffBleedConfig(item);
  if (!config?.persists) return;

  // Already stamped by this buff and not yet healed away — don't double it.
  if (getStoredEffects(actor).some((e) => e.origin === item.id)) return;

  await _applyLocal(actor, {
    // Locked now, against the buff, so the wound keeps dealing what it dealt at the moment it was
    // inflicted rather than drifting with the buff's level after the fact.
    formula: resolveFormula(config.formula, item.getRollData()),
    kind: config.kind,
    deepRequired: config.deep,
    blockedBy: config.blocks ? item.id : undefined,
    origin: item.id,
  });
});
