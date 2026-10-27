/**
 * PF1 Burning Effects – recurring fire damage, in two forms.
 *
 *  - **Catching fire** (`catch`): 1d6 fire the moment it lands, then a free DC 15 Reflex save at the
 *    start of each turn to put it out. Applied by anything that carries no configuration: the
 *    token HUD or sheet, bare `@Burning`, `apply(actor)`.
 *  - **Burn** (`burn`): a configured formula, DC and duration, no damage on landing and no free
 *    save. Applied by `@Burning[damage=…;duration=…;dc=…]`, a configured `apply()`, or a buff.
 *
 * Both forms may attempt a full-round Reflex save at +4 (the Extinguish button), and both deal
 * their damage at the end of the burning creature's turn. Instances stack like bleed: every one is
 * kept, the single highest deals damage each round, a save removes only the instances it beats,
 * and each timed instance counts down on its own. One `burning` condition shows for all of them.
 *
 * Application is GM-authoritative, as before: the active GM owns the per-turn bookkeeping and
 * performs every write. See DESIGN-BURNING.md.
 */

import {
  MODULE_ID,
  SOCKET,
  resolveActor,
  isActiveGM,
  getConditionSourceItems,
  getActorConditionEffect,
  groupTurnKind,
  cardWhisper,
} from "./dot-common.mjs";
import { resolveFormula } from "./bleed.mjs";

const CONDITION_ID = "burning";
const FLAG_KEY = "burning"; // { instances: Instance[] }

/** Item flag holding a buff's burning configuration: `{ formula }`. */
export const BUFF_FLAG = "burning";
const NEVELA_ID = "nevelas-automation-suite";
const ROLL_REQUESTS_ID = "pf1-roll-requests";
const SETTING_RESISTANCE = "burningResistance";

export const FORM_CATCH = "catch";
export const FORM_BURN = "burn";

export const DAMAGE_FORMULA = "1d6";
const DAMAGE_TYPE = "fire";
export const DEFAULT_DC = 15;
export const EXTINGUISH_BONUS = 4;

/**
 * @typedef {object} Instance
 * @property {string} id
 * @property {"catch"|"burn"} form
 * @property {string} formula - `@`-references already locked; dice roll fresh each round.
 * @property {number|null} dc - Null on a buff instance, which no save can end.
 * @property {number|null} rounds - Turn ends left; null = until put out.
 * @property {number} [startTime]
 * @property {Item} [source] - The buff, on a derived instance only.
 */

/**
 * Turn-tick de-dupe guard (see the bleed engine). Only the active GM ticks.
 *
 * @type {string|null}
 */
let lastTickKey = null;

/**
 * Card buttons already used on this client, keyed `messageId:kind`, so a double-click can't
 * roll twice.
 *
 * @type {Set<string>}
 */
const usedButtons = new Set();

/**
 * Active GM only: the turn in progress for each burning actor, from its turn start to its turn
 * end. `armed` is the instance ids present at the start, the only ones its turn end may burn with.
 *
 * @type {Map<string, {armed:Set<string>, freeSave:"pending"|"done"|null}>}
 */
const turns = new Map();

/**
 * Actor UUIDs whose marker this client is setting itself, so the toggle hook doesn't read it as
 * a fresh catch. PF1 fires the hook synchronously inside `setConditions`.
 *
 * @type {Set<string>}
 */
const igniting = new Set();

/* -------------------------------------------- *
 *  Condition registration
 * -------------------------------------------- */

/**
 * Register a `burning` condition, but only when nothing else provides one.
 *
 * Nevela's Automation Suite registers its own `burning` unconditionally, so claiming the key first
 * would break its registration. Defer to it whenever it is active; otherwise register only if the
 * key is still free. The condition id is the bare string either way.
 */
Hooks.on("pf1RegisterConditions", (registry) => {
  if (game.modules.get(NEVELA_ID)?.active) return;
  if (registry.has(CONDITION_ID)) return;

  try {
    registry.register(MODULE_ID, CONDITION_ID, {
      name: "BLD.Condition.Burning",
      texture: "icons/svg/fire.svg",
      showInAction: true,
      showInDefense: true,
    });
  } catch (err) {
    console.error(`${MODULE_ID} | Failed to register the burning condition`, err);
  }
});

/* -------------------------------------------- *
 *  Instances
 * -------------------------------------------- */

/**
 * The stored instance list from a raw flag value.
 *
 * The pre-2026-10-27 flag held one burning as `{ dc, save, startTime }`. Read as a catch when it
 * was the default fire, otherwise as a burn at its DC.
 *
 * @param {object|undefined} flag
 * @returns {Instance[]}
 */
function normalize(flag) {
  if (!flag) return [];
  if (Array.isArray(flag.instances)) return flag.instances;

  const dc = Number.isFinite(flag.dc) ? flag.dc : DEFAULT_DC;
  const isCatch = flag.save !== false && dc === DEFAULT_DC;
  return [{
    id: "legacy",
    form: isCatch ? FORM_CATCH : FORM_BURN,
    formula: DAMAGE_FORMULA,
    dc,
    rounds: null,
    startTime: Number(flag.startTime) || 0,
  }];
}

/**
 * A copy of the actor's stored instances, the only ones a save or a countdown can touch.
 *
 * @param {Actor} actor
 * @returns {Instance[]}
 */
export function getStoredInstances(actor) {
  return foundry.utils.deepClone(normalize(actor?.getFlag(MODULE_ID, FLAG_KEY)));
}

/**
 * Instances derived from the buffs supplying the condition. Never stored: each lasts exactly as
 * long as its buff, and nothing but the buff ends it.
 *
 * @param {Actor} actor
 * @returns {Instance[]}
 */
export function getBuffInstances(actor) {
  const byId = new Map();
  for (const item of getConditionSourceItems(actor, CONDITION_ID)) {
    const configured = String(item.getFlag(MODULE_ID, BUFF_FLAG)?.formula ?? "").trim();
    byId.set(item.id, {
      id: `buff:${item.id}`,
      form: FORM_BURN,
      formula: configured || DAMAGE_FORMULA,
      dc: null,
      rounds: null,
      source: item,
    });
  }
  return [...byId.values()];
}

/**
 * Every instance on the actor, stored and buff-supplied.
 *
 * @param {Actor} actor
 * @returns {Instance[]}
 */
export function getInstances(actor) {
  return [...getStoredInstances(actor), ...getBuffInstances(actor)];
}

/**
 * Write the stored instances, keeping the actor-level marker in step: present exactly while
 * anything is stored. Every mutation funnels through here.
 *
 * The marker test is for the actor-level effect, not `statuses`, for bleed's reason: a buff
 * satisfies `statuses`, and the stored fire would lose its marker the moment the buff ended.
 *
 * @param {Actor} actor
 * @param {Instance[]} instances
 */
export async function writeStored(actor, instances) {
  const raw = actor.getFlag(MODULE_ID, FLAG_KEY);
  // The old single-burning keys would survive a merge alongside `instances`.
  if (raw && !Array.isArray(raw.instances)) await actor.unsetFlag(MODULE_ID, FLAG_KEY);

  const clean = instances.map(({ source, ...rest }) => rest);
  if (clean.length) await actor.setFlag(MODULE_ID, FLAG_KEY, { instances: clean });
  else if (actor.getFlag(MODULE_ID, FLAG_KEY)) await actor.unsetFlag(MODULE_ID, FLAG_KEY);

  const marker = getActorConditionEffect(actor, CONDITION_ID);
  if (clean.length && !marker) {
    igniting.add(actor.uuid);
    try {
      await actor.setCondition(CONDITION_ID, true);
    } finally {
      igniting.delete(actor.uuid);
    }
  } else if (!clean.length && marker) {
    await actor.setCondition(CONDITION_ID, false);
  }
}

/**
 * A new stored instance.
 *
 * @param {{form:string, formula?:string, dc?:number, rounds?:number|null}} data
 * @returns {Instance}
 */
function newInstance({ form, formula = DAMAGE_FORMULA, dc = DEFAULT_DC, rounds = null }) {
  return {
    id: foundry.utils.randomID(),
    form,
    formula: String(formula),
    dc: Number.isFinite(dc) ? dc : DEFAULT_DC,
    rounds: Number.isFinite(rounds) && rounds > 0 ? rounds : null,
    startTime: game.time.worldTime,
  };
}

/**
 * Whether a save result removes an instance. Natural 20 removes every instance and natural 1
 * none, as for any PF1 save. A buff instance has no DC and never goes.
 *
 * @param {Instance} inst
 * @param {number} total
 * @param {number|null} natural
 * @returns {boolean}
 */
export function saveBeats(inst, total, natural) {
  if (!Number.isFinite(inst.dc)) return false;
  if (natural === 20) return true;
  if (natural === 1) return false;
  return total >= inst.dc;
}

/**
 * One instance as a line of text for cards and tooltips.
 *
 * @param {Instance} inst
 * @returns {string}
 */
export function instanceLine(inst) {
  const formula = inst.formula;
  if (inst.source) {
    return game.i18n.format("BLD.Burning.Line.Buff", {
      formula,
      source: foundry.utils.escapeHTML(inst.source.name),
    });
  }
  if (inst.form === FORM_CATCH) return game.i18n.format("BLD.Burning.Line.Catch", { formula, dc: inst.dc });

  let left;
  if (inst.rounds === null) left = game.i18n.localize("BLD.Burning.Left.Until");
  else if (inst.rounds === 1) left = game.i18n.localize("BLD.Burning.Left.One");
  else left = game.i18n.format("BLD.Burning.Left.Rounds", { n: inst.rounds });
  return game.i18n.format("BLD.Burning.Line.Burn", { formula, dc: inst.dc, left });
}

/* -------------------------------------------- *
 *  Damage
 * -------------------------------------------- */

/**
 * Whether burning damage should be run through fire resistance and vulnerability.
 *
 * @returns {boolean}
 */
function resistanceEnabled() {
  return game.settings.get(MODULE_ID, SETTING_RESISTANCE);
}

/**
 * Whether an actor carries a damage-type trait. PF1 v11 keeps these as `{ standard, custom,
 * total }` Sets; the old `.value` array getter now returns a Set too.
 *
 * @param {Actor} actor
 * @param {"di"|"dv"} traitKey
 * @param {string} type
 * @returns {boolean}
 */
function hasDamageTrait(actor, traitKey, type) {
  return !!actor.system?.traits?.[traitKey]?.total?.has?.(type);
}

/**
 * @param {Actor} actor
 * @returns {boolean}
 */
export function isFireImmune(actor) {
  return hasDamageTrait(actor, "di", DAMAGE_TYPE);
}

/**
 * The actor's best fire resistance. Energy resistance is inclusive, as in PF1's own damage
 * application, and doesn't stack, so the largest applying entry wins. Free-text entries aren't
 * parsed.
 *
 * @param {Actor} actor
 * @returns {number}
 */
function getFireResistance(actor) {
  const entries = actor.system?.traits?.eres?.value;
  if (!Array.isArray(entries)) return 0;

  let best = 0;
  for (const entry of entries) {
    if (!entry?.types?.includes?.(DAMAGE_TYPE)) continue;
    const amount = Number(entry.amount);
    if (Number.isFinite(amount) && amount > best) best = amount;
  }
  return best;
}

/**
 * Run a rolled total through vulnerability, then resistance. Immunity is the callers' check.
 *
 * @param {Actor} actor
 * @param {number} raw
 * @returns {{total:number, raw:number, resisted:number, vulnerable:boolean}}
 */
export function adjustForResistance(actor, raw) {
  if (!resistanceEnabled()) return { total: raw, raw, resisted: 0, vulnerable: false };

  const vulnerable = hasDamageTrait(actor, "dv", DAMAGE_TYPE);
  const value = vulnerable ? Math.floor(raw * 1.5) : raw;

  const resisted = Math.min(value, getFireResistance(actor));
  return { total: value - resisted, raw, resisted, vulnerable };
}

/**
 * A formula's minimum and maximum, or null when it doesn't evaluate.
 *
 * @param {string} formula
 * @param {object} rollData
 * @returns {{min:number, max:number}|null}
 */
function formulaRange(formula, rollData) {
  const RollPF = pf1.dice.RollPF;
  const min = RollPF.safeRollSync(formula, rollData, undefined, { suppressError: true }, { minimize: true })?.total;
  const max = RollPF.safeRollSync(formula, rollData, undefined, { suppressError: true }, { maximize: true })?.total;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

/**
 * One round's damage from a set of instances, before resistance.
 *
 * The rolled instance with the highest average is rolled, and the larger of that and the highest
 * static value is the round's damage (DESIGN-BURNING.md §3). `(min + max) / 2` is the exact mean
 * for sums of dice and constants.
 *
 * @param {Actor} actor
 * @param {Instance[]} instances
 * @returns {Promise<number>}
 */
export async function rollRound(actor, instances) {
  let actorRollData = null;
  let fixed = null;
  let best = null;

  for (const inst of instances) {
    // A buff instance resolves against the buff each round, so `@item.level` scales.
    const rollData = inst.source?.getRollData() ?? (actorRollData ??= actor.getRollData());
    const range = formulaRange(inst.formula, rollData);
    if (!range) continue;

    if (range.min === range.max) {
      if (fixed === null || range.min > fixed) fixed = range.min;
      continue;
    }
    const mean = (range.min + range.max) / 2;
    if (!best || mean > best.mean) best = { inst, mean, rollData };
  }

  let rolled = null;
  if (best) {
    const roll = await pf1.dice.RollPF.safeRoll(best.inst.formula, best.rollData);
    rolled = Math.floor(roll?.total || 0);
  }

  return Math.max(0, rolled ?? 0, fixed ?? 0);
}

/**
 * Roll a formula once and apply it, honoring resistance.
 *
 * @param {Actor} actor
 * @param {string} formula
 * @returns {Promise<{total:number, raw:number, resisted:number, vulnerable:boolean}>}
 */
async function rollAndApplyFormula(actor, formula) {
  const roll = await pf1.dice.RollPF.safeRoll(formula, actor.getRollData());
  const result = adjustForResistance(actor, Math.max(0, Math.floor(roll?.total || 0)));
  if (result.total > 0) await actor.applyDamage(result.total);
  return result;
}

/* -------------------------------------------- *
 *  Owner-side mutations
 * -------------------------------------------- */

/**
 * Set an actor we own alight.
 *
 * A catch deals its 1d6 every time it lands, but at most one catch instance is kept, so the turn
 * end and the free save see one. A burn deals nothing on landing and is always added.
 *
 * @param {Actor} actor
 * @param {{form:string, formula?:string, dc?:number, rounds?:number|null}} payload
 */
async function _applyLocal(actor, payload) {
  const name = `<strong>${actor.name}</strong>`;

  if (isFireImmune(actor)) {
    // A marker someone put on by hand comes off again.
    if (!getStoredInstances(actor).length && getActorConditionEffect(actor, CONDITION_ID)) await writeStored(actor, []);
    await postCard(actor, game.i18n.format("BLD.Burning.Immune", { name }), "resist");
    return;
  }

  const stored = getStoredInstances(actor);

  if (payload.form === FORM_CATCH) {
    if (!stored.some((i) => i.form === FORM_CATCH)) stored.push(newInstance({ form: FORM_CATCH }));
    await writeStored(actor, stored);
    const result = await rollAndApplyFormula(actor, DAMAGE_FORMULA);
    await postResult(actor, result, "BLD.Burning.Ignite", "BLD.Burning.IgniteResisted", "ignite", { extinguish: true });
    return;
  }

  const inst = newInstance({ ...payload, form: FORM_BURN });
  stored.push(inst);
  await writeStored(actor, stored);
  await postCard(
    actor,
    game.i18n.format("BLD.Burning.SetAlight", { name, details: instanceLine(inst) }),
    "ignite",
    "",
    { extinguish: true }
  );
}

/**
 * Put out every stored instance on an actor we own. Buff instances stay with their buff.
 *
 * @param {Actor} actor
 */
async function _clearLocal(actor) {
  if (getStoredInstances(actor).length || getActorConditionEffect(actor, CONDITION_ID)) await writeStored(actor, []);
}

/**
 * What putting out some fires left burning, as a sentence and a card kind.
 *
 * @param {Actor} actor
 * @returns {{text:string, kind:"extinguish"|"burn"}}
 */
function putOutOutcome(actor) {
  const name = `<strong>${actor.name}</strong>`;
  const left = getInstances(actor).length;
  if (!left) return { text: game.i18n.format("BLD.Burning.Extinguish", { name }), kind: "extinguish" };
  return { text: game.i18n.format("BLD.Burning.PartlyOut", { name, n: left }), kind: "burn" };
}

/**
 * Remove stored instances by id, closing the free save once the caught fire is gone.
 *
 * @param {Actor} actor
 * @param {string[]} ids
 * @returns {Promise<number>} How many were still there to remove.
 */
async function removeInstances(actor, ids) {
  const stored = getStoredInstances(actor);
  const kept = stored.filter((i) => !ids.includes(i.id));
  if (kept.length === stored.length) return 0;
  await writeStored(actor, kept);

  const entry = turns.get(actor.uuid);
  if (entry && !kept.some((i) => i.form === FORM_CATCH)) entry.freeSave = "done";
  return stored.length - kept.length;
}

/* -------------------------------------------- *
 *  Public API (GM-routed)
 * -------------------------------------------- */

/**
 * Whether an option was actually given. Blank strings count as not given, so a form with empty
 * fields applies catching fire.
 *
 * @param {*} value
 * @returns {boolean}
 */
const given = (value) => value !== undefined && value !== null && String(value).trim() !== "";

/**
 * Evaluate a number-or-formula option.
 *
 * @param {*} value
 * @param {object} rollData
 * @returns {Promise<number|null>}
 */
async function evaluateNumber(value, rollData) {
  if (!given(value)) return null;
  const roll = await pf1.dice.RollPF.safeRoll(String(value), rollData);
  const n = Math.floor(Number(roll?.total));
  return Number.isFinite(n) ? n : null;
}

/**
 * Set a target alight.
 *
 * With no options this is catching fire. Any of `formula`, `dc` or `duration` makes it a burn,
 * with the others defaulting to 1d6, DC 15 and until put out.
 *
 * @param {Actor|Token|TokenDocument|string} ref
 * @param {object} [options]
 * @param {string} [options.formula] - Fire damage each round.
 * @param {number|string} [options.dc] - Reflex DC to put it out.
 * @param {number|string} [options.duration] - Rounds, or a dice formula rolled now. 0 = until
 *   put out.
 * @param {object} [options.sourceRollData] - Locks `@`-references to the source. Defaults to the
 *   target's.
 * @returns {Promise<void>}
 */
async function apply(ref, { formula, dc, duration, sourceRollData } = {}) {
  const actor = resolveActor(ref);
  if (!actor) {
    ui.notifications.error(game.i18n.localize("BLD.Burning.Error.NoTarget"));
    return;
  }

  let payload = { form: FORM_CATCH };
  if (given(formula) || given(dc) || given(duration)) {
    const rollData = sourceRollData ?? actor.getRollData();
    const rounds = await evaluateNumber(duration, rollData);
    payload = {
      form: FORM_BURN,
      formula: given(formula) ? resolveFormula(String(formula).trim(), rollData) : DAMAGE_FORMULA,
      dc: (await evaluateNumber(dc, rollData)) ?? DEFAULT_DC,
      rounds: rounds > 0 ? rounds : null,
    };
  }

  if (actor.isOwner) return _applyLocal(actor, payload);
  game.socket.emit(SOCKET, { action: "burn", actorUuid: actor.uuid, payload });
}

/**
 * Put out a target's fire. Buff-supplied burning ends only with its buff.
 *
 * @param {Actor|Token|TokenDocument|string} ref
 * @returns {Promise<void>}
 */
async function clear(ref) {
  const actor = resolveActor(ref);
  if (!actor) return;
  if (actor.isOwner) return _clearLocal(actor);
  game.socket.emit(SOCKET, { action: "extinguish", actorUuid: actor.uuid });
}

/**
 * @param {Actor|Token|TokenDocument|string} ref
 * @returns {boolean}
 */
function isBurning(ref) {
  return !!resolveActor(ref)?.statuses.has(CONDITION_ID);
}

/**
 * Every instance on a target, as plain data.
 *
 * @param {Actor|Token|TokenDocument|string} ref
 * @returns {Array<{id:string, form:string, formula:string, dc:number|null, rounds:number|null, source:string|null, text:string}>}
 */
function describe(ref) {
  const actor = resolveActor(ref);
  if (!actor) return [];
  return getInstances(actor).map((inst) => ({
    id: inst.id,
    form: inst.form,
    formula: inst.formula,
    dc: inst.dc,
    rounds: inst.rounds,
    source: inst.source?.name ?? null,
    text: instanceLine(inst),
  }));
}

/* -------------------------------------------- *
 *  Saves (applied on the active GM)
 * -------------------------------------------- */

/**
 * The free save's result. Only the catch instance is at stake.
 *
 * @param {Actor} actor
 * @param {boolean} passed
 */
async function resolveFreeSave(actor, passed) {
  if (!isActiveGM()) return;
  const entry = turns.get(actor.uuid);
  if (entry?.freeSave !== "pending") return; // nothing pending, or already handled
  entry.freeSave = "done";
  if (!passed) return; // the save card already says so

  const catches = getStoredInstances(actor).filter((i) => i.form === FORM_CATCH).map((i) => i.id);
  if (!(await removeInstances(actor, catches))) return; // put out by other means meanwhile
  const { text, kind } = putOutOutcome(actor);
  await postCard(actor, text, kind);
}

/**
 * The Put Out button's work: remove the fires an Extinguish card names, then rewrite the card to
 * say what happened. Ids already gone (another save, the countdown, a hand removal) are skipped.
 *
 * @param {ChatMessage} message
 */
async function putOut(message) {
  if (!isActiveGM()) return;
  const data = message?.getFlag(MODULE_ID, "extinguish");
  if (!data || data.done) return;

  const actor = resolveActor(data.actorUuid);
  if (!actor) return;

  const removed = await removeInstances(actor, data.ids ?? []);
  const { text, kind } = removed
    ? putOutOutcome(actor)
    : { text: game.i18n.format("BLD.Burning.ExtinguishCard.AlreadyOut", { name: `<strong>${actor.name}</strong>` }), kind: "burn" };

  const icon = CARD_ICONS[kind] ?? "fa-fire";
  await message.update({
    content: `<div class="pf1-burning-card pf1-burning-${kind}">
    <p><i class="fa-solid ${icon}"></i> ${text}</p>
  </div>`,
    [`flags.${MODULE_ID}.extinguish.done`]: true,
  });
}

/* -------------------------------------------- *
 *  Turn flow
 * -------------------------------------------- */

/**
 * The token to aim a roll request at, or null.
 *
 * @param {Actor} actor
 * @param {TokenDocument|null} token
 * @returns {TokenDocument|null}
 */
function requestToken(actor, token) {
  return token ?? actor.token ?? actor.getActiveTokens(false, true)[0] ?? null;
}

/**
 * Start a burning actor's turn: arm what is burning now, post the turn card, and ask for the free
 * save when a catch instance is present.
 *
 * @param {Actor} actor
 * @param {TokenDocument|null} token
 */
async function startTurn(actor, token) {
  let stored = getStoredInstances(actor);
  // Our marker clicked off while a buff kept the status on: the stored fire went with it.
  if (stored.length && !getActorConditionEffect(actor, CONDITION_ID)) {
    await writeStored(actor, []);
    stored = [];
  }

  const all = [...stored, ...getBuffInstances(actor)];
  if (!all.length) return;

  if (isFireImmune(actor)) {
    if (stored.length) await writeStored(actor, []);
    return;
  }

  const hasCatch = stored.some((i) => i.form === FORM_CATCH);
  turns.set(actor.uuid, {
    armed: new Set(all.map((i) => i.id)),
    freeSave: hasCatch ? "pending" : null,
  });

  const target = hasCatch ? requestToken(actor, token) : null;
  const viaRequests = !!target && !!game.modules.get(ROLL_REQUESTS_ID)?.active && !!game.pf1RollRequests?.createRequest;

  await postTurnCard(actor, all, {
    saveButton: hasCatch && !viaRequests,
    extinguish: stored.length > 0,
  });

  if (viaRequests) await requestFreeSave(actor, target);
}

/**
 * End a burning actor's turn: one round of damage from what was armed and still burns, then the
 * countdown. A free save never rolled counted as failed already, since damage needs no click.
 *
 * @param {Actor} actor
 * @param {{armed:Set<string>}} entry
 */
async function endTurn(actor, entry) {
  if (isFireImmune(actor)) return;

  const stored = getStoredInstances(actor);
  const live = [...stored, ...getBuffInstances(actor)].filter((i) => entry.armed.has(i.id));
  if (!live.length) return;

  const result = adjustForResistance(actor, await rollRound(actor, live));
  if (result.total > 0) await actor.applyDamage(result.total);

  let counted = false;
  const kept = [];
  for (const inst of stored) {
    if (entry.armed.has(inst.id) && inst.rounds !== null) {
      inst.rounds -= 1;
      counted = true;
      if (inst.rounds <= 0) continue;
    }
    kept.push(inst);
  }
  if (counted) await writeStored(actor, kept);

  const burnedOut = kept.length < stored.length && !getInstances(actor).length;
  await postResult(actor, result, "BLD.Burning.AutoDamage", "BLD.Burning.Resisted", "burn", { burnedOut });
}

/**
 * End every turn still open. Runs before the next turn starts, so it only sees elapsed turns.
 */
async function endTurns() {
  for (const [actorUuid, entry] of turns) {
    turns.delete(actorUuid);
    const actor = resolveActor(actorUuid);
    if (actor) await endTurn(actor, entry);
  }
}

/**
 * Ask for the free save through pf1-roll-requests, a GM-called check.
 *
 * @param {Actor} actor
 * @param {TokenDocument} tokenDoc
 */
async function requestFreeSave(actor, tokenDoc) {
  let done = false;
  await game.pf1RollRequests.createRequest({
    type: "save",
    key: "ref",
    dc: DEFAULT_DC,
    mode: "targeted",
    showDC: true,
    showResults: true,
    flavor: game.i18n.format("BLD.Burning.SaveFlavor", { name: actor.name, dc: DEFAULT_DC }),
    targetedActors: [
      {
        id: tokenDoc.id,
        tokenUUID: tokenDoc.uuid,
        name: tokenDoc.name,
        img: tokenDoc.texture?.src ?? actor.img,
        isHidden: !!tokenDoc.hidden,
      },
    ],
    onResult: (payload) => {
      if (done) return;
      if (payload?.rollType === "cancelled") return;
      const passed = payload?.result?.passed;
      if (passed === null || passed === undefined) return;
      done = true;
      resolveFreeSave(actor, passed);
    },
  });
}

/* -------------------------------------------- *
 *  Cards
 * -------------------------------------------- */

const CARD_ICONS = {
  extinguish: "fa-fire-extinguisher",
  resist: "fa-shield-halved",
};

/**
 * The Extinguish button's markup.
 *
 * @param {Actor} actor
 * @returns {string}
 */
function extinguishButton(actor) {
  const label = game.i18n.format("BLD.Burning.Card.ExtinguishButton", { bonus: EXTINGUISH_BONUS });
  return `<button type="button" class="pf1-burning-extinguish" data-actor-uuid="${actor.uuid}">
      <i class="fa-solid fa-fire-extinguisher"></i> ${label}
    </button>`;
}

/**
 * Post a one-line burning card.
 *
 * @param {Actor} actor
 * @param {string} text - Full localized sentence.
 * @param {"ignite"|"burn"|"extinguish"|"resist"} kind
 * @param {string} [note] - Optional mitigation aside.
 * @param {{extinguish?:boolean}} [options]
 */
async function postCard(actor, text, kind, note, { extinguish = false } = {}) {
  const icon = CARD_ICONS[kind] ?? "fa-fire";
  const aside = note ? ` <span class="pf1-burning-note">${note}</span>` : "";
  const content = `<div class="pf1-burning-card pf1-burning-${kind}">
    <p><i class="fa-solid ${icon}"></i> ${text}${aside}</p>
    ${extinguish ? extinguishButton(actor) : ""}
  </div>`;
  await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }), whisper: cardWhisper(actor) });
}

/**
 * The start-of-turn card: what is burning, and the buttons that can put it out.
 *
 * @param {Actor} actor
 * @param {Instance[]} instances
 * @param {{saveButton:boolean, extinguish:boolean}} options
 */
async function postTurnCard(actor, instances, { saveButton, extinguish }) {
  const onFire = game.i18n.format("BLD.Burning.Card.OnFire", { name: `<strong>${actor.name}</strong>` });
  const lines = instances.map((i) => `<li>${instanceLine(i)}</li>`).join("");
  const highest = instances.length > 1
    ? `<p class="pf1-burning-note">${game.i18n.localize("BLD.Burning.Card.HighestNote")}</p>`
    : "";
  const save = saveButton
    ? `<button type="button" class="pf1-burning-save" data-actor-uuid="${actor.uuid}" data-dc="${DEFAULT_DC}">
      <i class="fa-solid fa-person-running"></i> ${game.i18n.format("BLD.Burning.Card.SaveButton", { dc: DEFAULT_DC })}
    </button>`
    : "";

  const content = `<div class="pf1-burning-card" data-actor-uuid="${actor.uuid}">
    <p><i class="fa-solid fa-fire"></i> ${onFire}</p>
    <ul>${lines}</ul>
    ${highest}
    ${save}
    ${extinguish ? extinguishButton(actor) : ""}
  </div>`;
  await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }), whisper: cardWhisper(actor) });
}

/**
 * How resistance or vulnerability changed a roll. Empty when it landed unmodified.
 *
 * @param {{raw:number, resisted:number, vulnerable:boolean}} result
 * @returns {string}
 */
function damageNote({ raw, resisted, vulnerable }) {
  const parts = [];
  if (vulnerable) parts.push(game.i18n.localize("BLD.Burning.Note.Vulnerable"));
  if (resisted > 0) parts.push(game.i18n.format("BLD.Burning.Note.Resisted", { resisted, raw }));
  return parts.length ? `(${parts.join("; ")})` : "";
}

/**
 * Post a damage outcome, worded for whether anything got through.
 *
 * @param {Actor} actor
 * @param {{total:number, raw:number, resisted:number, vulnerable:boolean}} result
 * @param {string} dealtKey - Given `name` and `total`.
 * @param {string} resistedKey - Given `name`.
 * @param {"ignite"|"burn"} kind
 * @param {{extinguish?:boolean, burnedOut?:boolean}} [options]
 */
async function postResult(actor, result, dealtKey, resistedKey, kind, { extinguish = false, burnedOut = false } = {}) {
  const name = `<strong>${actor.name}</strong>`;
  const dealt = result.total > 0;
  let text = dealt
    ? game.i18n.format(dealtKey, { name, total: result.total })
    : game.i18n.format(resistedKey, { name });
  if (burnedOut) text += " " + game.i18n.localize("BLD.Burning.BurnsOut");
  await postCard(actor, text, dealt ? kind : "resist", damageNote(result), { extinguish });
}

/* -------------------------------------------- *
 *  Card buttons (clicking client)
 * -------------------------------------------- */

/**
 * Lock a card button on this client before anything is awaited.
 *
 * @param {HTMLButtonElement} button
 * @param {string} kind
 * @returns {string|null} The lock key, or null when already used.
 */
function lockButton(button, kind) {
  const messageId = button.closest("[data-message-id]")?.dataset.messageId;
  const key = messageId ? `${messageId}:${kind}` : null;
  if (key && usedButtons.has(key)) return null;
  if (key) usedButtons.add(key);
  button.disabled = true;
  return key ?? "";
}

/**
 * Release a lock after a cancelled roll, so the player can try again.
 *
 * @param {HTMLButtonElement} button
 * @param {string} key
 */
function unlockButton(button, key) {
  if (key) usedButtons.delete(key);
  button.disabled = false;
}

/**
 * The free save's button, on the turn card when pf1-roll-requests isn't handling it.
 *
 * @param {HTMLButtonElement} button
 */
async function onFreeSaveClick(button) {
  const actor = resolveActor(button.dataset.actorUuid);
  if (!actor) return;
  if (!actor.isOwner) {
    ui.notifications.warn(game.i18n.format("BLD.Burning.NoControl", { name: actor.name }));
    return;
  }

  const key = lockButton(button, "save");
  if (key === null) return;

  const dc = Number(button.dataset.dc) || DEFAULT_DC;
  let msg;
  try {
    msg = await actor.rollSavingThrow("ref", { dc, skipDialog: !actor.hasPlayerOwner });
  } catch (err) {
    console.error(`${MODULE_ID} | Reflex save failed to roll`, err);
  }

  const roll = msg?.rolls?.[0];
  if (!roll) return unlockButton(button, key);

  const passed = roll.isSuccess ?? roll.total >= dc;
  if (isActiveGM()) await resolveFreeSave(actor, passed);
  else game.socket.emit(SOCKET, { action: "burnSaveResult", actorUuid: actor.uuid, payload: { passed } });
}

/**
 * The actor's combat and token when it is fighting in a started combat, else null.
 *
 * @param {Actor} actor
 * @returns {{combat:Combat, token:TokenDocument|null}|null}
 */
function fighting(actor) {
  const combat = game.combat;
  if (!combat?.started) return null;
  const combatant = combat.combatants.find((c) => c.actor?.uuid === actor.uuid);
  return combatant ? { combat, token: combatant.token ?? null } : null;
}

/**
 * The Extinguish outcome card: what the roll beat and what still burns, with a Put Out button
 * when it beat anything. Nothing is removed until that button is clicked.
 *
 * @param {Actor} actor
 * @param {Roll} roll
 */
async function postExtinguishCard(actor, roll) {
  const name = `<strong>${actor.name}</strong>`;
  const total = roll.total;
  const natural = Number.isFinite(roll.natural) ? roll.natural : null;

  const stored = getStoredInstances(actor);
  const beaten = stored.filter((i) => saveBeats(i, total, natural));
  const remaining = [...stored.filter((i) => !beaten.includes(i)), ...getBuffInstances(actor)];
  const list = (insts) => `<ul>${insts.map((i) => `<li>${instanceLine(i)}</li>`).join("")}</ul>`;

  let body;
  if (!beaten.length) {
    body = `<p><i class="fa-solid fa-fire"></i> ${game.i18n.format("BLD.Burning.ExtinguishCard.Fails", { name, total })}</p>`;
  } else {
    body = `<p><i class="fa-solid fa-fire-extinguisher"></i> ${game.i18n.format("BLD.Burning.ExtinguishCard.Beats", { name, total })}</p>
    ${list(beaten)}`;
    if (remaining.length) body += `<p>${game.i18n.localize("BLD.Burning.ExtinguishCard.Remains")}</p>${list(remaining)}`;
    body += `<button type="button" class="pf1-burning-putout">
      <i class="fa-solid fa-fire-extinguisher"></i> ${game.i18n.format("BLD.Burning.Card.PutOutButton", { n: beaten.length })}
    </button>`;
  }

  await ChatMessage.create({
    content: `<div class="pf1-burning-card pf1-burning-extinguish">${body}</div>`,
    speaker: ChatMessage.getSpeaker({ actor }),
    whisper: cardWhisper(actor),
    flags: { [MODULE_ID]: { extinguish: { actorUuid: actor.uuid, ids: beaten.map((i) => i.id), done: !beaten.length } } },
  });
}

/**
 * The Put Out button, on an Extinguish card.
 *
 * @param {HTMLButtonElement} button
 */
async function onPutOutClick(button) {
  const message = game.messages.get(button.closest("[data-message-id]")?.dataset.messageId);
  const data = message?.getFlag(MODULE_ID, "extinguish");
  if (!data || data.done) return;

  const actor = resolveActor(data.actorUuid);
  if (!actor?.isOwner) {
    ui.notifications.warn(game.i18n.format("BLD.Burning.NoControl", { name: actor?.name ?? "" }));
    return;
  }
  if (lockButton(button, "putout") === null) return;

  if (isActiveGM()) await putOut(message);
  else game.socket.emit(SOCKET, { action: "burnPutOut", messageId: message.id });
}

/**
 * The Extinguish button: a full-round action, Reflex at +4, rolled through the system's save
 * with its dialog every time (a GM running an NPC included). In combat it waits for the actor's
 * turn, and astora-mod's Action Tracker gets its shortfall question first and its slots after the
 * roll lands. The roll only reports; the outcome card's Put Out button does the removing.
 *
 * @param {HTMLButtonElement} button
 */
async function onExtinguishClick(button) {
  const actor = resolveActor(button.dataset.actorUuid);
  if (!actor) return;
  if (!actor.isOwner) {
    ui.notifications.warn(game.i18n.format("BLD.Burning.NoControl", { name: actor.name }));
    return;
  }
  if (!getStoredInstances(actor).length) {
    ui.notifications.warn(game.i18n.format("BLD.Burning.NothingToPutOut", { name: actor.name }));
    return;
  }

  const fight = fighting(actor);
  const tracker = game.astoraMod?.actionTracker;
  const actionName = game.i18n.localize("BLD.Burning.ExtinguishAction");
  if (fight) {
    // The tracker knows grouped turns; without it, the current combatant is the test.
    const reading = fight.token ? tracker?.state?.(fight.token) : null;
    const acting = reading ? reading.acting : fight.combat.combatant?.actor?.uuid === actor.uuid;
    if (!acting) {
      ui.notifications.warn(game.i18n.format("BLD.Burning.NotYourTurn", { name: actor.name }));
      return;
    }
  }

  const key = lockButton(button, "extinguish");
  if (key === null) return;

  if (fight?.token && tracker?.confirm && !(await tracker.confirm(fight.token, "full", { name: actionName }))) {
    return unlockButton(button, key);
  }

  let msg;
  try {
    msg = await actor.rollSavingThrow("ref", { skipDialog: false, pf1BurningExtinguish: true });
  } catch (err) {
    console.error(`${MODULE_ID} | Extinguish save failed to roll`, err);
  }

  const roll = msg?.rolls?.[0];
  if (!roll) return unlockButton(button, key);

  if (fight?.token) await tracker?.charge?.(fight.token, "full");
  await postExtinguishCard(actor, roll);
}

/**
 * Delegated click handler for the card buttons.
 *
 * @param {MouseEvent} event
 */
function onCardClick(event) {
  const button = event.target.closest?.("button.pf1-burning-save, button.pf1-burning-extinguish, button.pf1-burning-putout");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  if (button.classList.contains("pf1-burning-save")) onFreeSaveClick(button);
  else if (button.classList.contains("pf1-burning-putout")) onPutOutClick(button);
  else onExtinguishClick(button);
}

/**
 * The Extinguish roll's +4, as a labeled part so it reads on the card like any other modifier.
 * The marker option is removed so it goes no further than this hook.
 */
Hooks.on("pf1PreActorRollSave", (actor, rollOptions) => {
  if (!rollOptions?.pf1BurningExtinguish) return;
  delete rollOptions.pf1BurningExtinguish;
  rollOptions.parts?.push(`${EXTINGUISH_BONUS}[${game.i18n.localize("BLD.Burning.ExtinguishAction")}]`);
  rollOptions.flavor = game.i18n.format("BLD.Burning.ExtinguishFlavor", { name: actor.name });
});

/* -------------------------------------------- *
 *  Combat hook
 * -------------------------------------------- */

/**
 * `updateCombat` handler: end the turn that just finished, then start the one beginning.
 *
 * @param {Combat} combat
 * @param {object} changed
 * @param {object} options
 */
async function onUpdateCombat(combat, changed, options) {
  if (!isActiveGM()) return;
  if (!combat.started) return;
  if (changed.round === undefined && changed.turn === undefined) return;

  const key = `${combat.id}:${combat.round}:${combat.turn}`;
  const groupKind = groupTurnKind(options);

  // A grouped-initiative reorder is not a turn change.
  if (groupKind === "reanchor") {
    lastTickKey = key;
    return;
  }

  if (key === lastTickKey) return;
  lastTickKey = key;

  // A walk step starts a member's turn without ending the one left behind; every member's turn
  // ends together on the ordinary change that ends the group's.
  if (groupKind !== "walk") await endTurns();

  const combatant = combat.combatant;
  const actor = combatant?.actor;
  if (!actor || combatant.isDefeated) return;
  if (!actor.statuses.has(CONDITION_ID)) return;

  startTurn(actor, combatant.token ?? null);
}

/* -------------------------------------------- *
 *  Socket handling
 * -------------------------------------------- */

/**
 * Requests routed from non-owning clients.
 *
 * @param {{action:string, actorUuid:string, payload:object}} data
 */
function onSocket(data) {
  if (!isActiveGM()) return;
  if (data.action === "burnPutOut") return void putOut(game.messages.get(data.messageId));
  const actor = resolveActor(data.actorUuid);
  if (!actor) return;
  if (data.action === "burn") _applyLocal(actor, data.payload ?? { form: FORM_CATCH });
  else if (data.action === "extinguish") _clearLocal(actor);
  else if (data.action === "burnSaveResult") resolveFreeSave(actor, !!data.payload?.passed);
}

/* -------------------------------------------- *
 *  Registration
 * -------------------------------------------- */

export const BurningAPI = { apply, clear, isBurning, describe, DEFAULT_DC };

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_RESISTANCE, {
    name: "BLD.Settings.Resistance.Name",
    hint: "BLD.Settings.Resistance.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  const mod = game.modules.get(MODULE_ID);
  mod.api ??= {};
  mod.api.burning = BurningAPI;
  globalThis.pf1BurningEffects = BurningAPI;
});

/**
 * No right-click duration on the sheet's burning condition: a timer on the shared marker would
 * end every instance at once, and a burn carries its own. Listeners bind per render, so patching
 * the prototype before any sheet opens covers them all.
 */
Hooks.once("setup", () => {
  const proto = pf1.applications?.actor?.ActorSheetPF?.prototype;
  const original = proto?._onEditCondition;
  if (typeof original !== "function") return;
  proto._onEditCondition = function (event) {
    if (event?.currentTarget?.dataset?.conditionId === CONDITION_ID) {
      event.preventDefault();
      return;
    }
    return original.call(this, event);
  };
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, onSocket);
  document.body.addEventListener("click", onCardClick);
});

Hooks.on("updateCombat", onUpdateCombat);

// A combat ended mid-turn: that turn never ends, and the next combat's first change mustn't end it.
Hooks.on("deleteCombat", () => turns.clear());

/**
 * Condition toggles. Fires only on the toggling client, an owner.
 *
 * ON with an actor-level marker this module didn't set: the HUD, the sheet, or another module,
 * so catching fire. ON from a buff alone: a burn, which deals nothing on landing.
 * OFF: the stored fire goes with the marker.
 */
Hooks.on("pf1ToggleActorCondition", (actor, conditionId, state) => {
  if (conditionId !== CONDITION_ID) return;
  if (!actor?.isOwner) return;

  if (state) {
    if (igniting.has(actor.uuid)) return;
    if (!getActorConditionEffect(actor, CONDITION_ID)) return;
    _applyLocal(actor, { form: FORM_CATCH });
    return;
  }

  if (actor.getFlag(MODULE_ID, FLAG_KEY)) actor.unsetFlag(MODULE_ID, FLAG_KEY);
});
