/**
 * PF1 Bleed Effects — generic damage over time.
 *
 * Any item can carry a list of damage-over-time instances (see `dot-config.mjs` for the sheet).
 * While the item is live on an actor, each instance rolls its formula at a chosen turn boundary and
 * applies the result to the *carrying* actor — as typed damage run through that actor's damage
 * reduction, energy resistance, hardness and immunities, or as healing.
 *
 * This is independent of bleed and burning. It shares only `dot-common.mjs`'s actor resolution and
 * active-GM test; a buff can carry both without either engine knowing about the other.
 *
 * Three things are worth understanding before changing anything here.
 *
 * **Reduction comes from the system, not from us.** `actor.applyDamage()` explicitly does no DR/ER
 * ("Does not handle ER/DR or anything else special") — it takes a flat `reduction` number. All of
 * that math lives inside PF1's `ApplyDamage` *dialog*. So we construct that Application and never
 * render it: its constructor runs `_prepareInstances` → `_evaluateAttack` → `_prepareTargets`, which
 * computes immunities, DR, energy resistance and hardness, and then `_getTargetDamageOptions()`
 * hands back exactly the options the dialog itself would have applied. See `reductionFor()`.
 *
 * **Nevela's Automation Suite composes with this for free.** It libWraps both
 * `ActorPF.prototype.applyDamage` and `ApplyDamage.prototype._getTargetDamageOptions`, and uses this
 * same headless technique internally. Because we go through both, our ticks pick up its temporary-HP
 * pools, damage absorption, fortification and on-struck triggers with no integration code, and its
 * `_nasDamageDialog` marker (stamped by its own wrapper) tells it DR is already accounted for.
 * Passing a bare value and hoping it computes DR/ER for us does *not* work — its DR helpers all bail
 * unless `reduction` is already non-zero, or require a click context we don't have.
 *
 * **Dice animate because the message carries the rolls.** Attaching evaluated `DamageRoll`s to the
 * ChatMessage is the whole of the Dice So Nice integration: DSN animates any message with rolls, and
 * `DamageRoll`'s constructor already sets `options.appearance` from the damage type's registry entry,
 * so a `1d6` acid instance rolls a visibly acid d6. Foundry only substitutes its own roll markup when
 * the message content has no child elements, so our card renders instead of a dice tray.
 */

import { MODULE_ID, resolveActor, isActiveGM } from "./dot-common.mjs";

/** Item flag holding the DoT configuration: `{ instances: { <id>: {...} } }`. */
export const DOT_FLAG = "dot";

/** Timing choices, in the order they're offered on the sheet. */
export const TIMINGS = /** @type {const} */ (["turnStart", "turnEnd", "initiative"]);

/**
 * Per-combat cursor, so we can tell a forward turn change from a rewind and know who just finished.
 *
 * @type {Map<string, {round:number, turn:number, combatantId:string|null}>}
 */
const cursors = new Map();

/**
 * Per-combat once-per-round guard for initiative-timed instances. Reset when the round advances.
 *
 * @type {Map<string, {round:number, keys:Set<string>}>}
 */
const fired = new Map();

/* -------------------------------------------- *
 *  Model
 * -------------------------------------------- */

/**
 * Whether a set of damage types includes anything damage reduction can act on.
 *
 * DR is exclusively a physical-damage mechanic in PF1: `ApplyDamage._isReducedBy()` rejects any
 * instance that isn't physical *before* it looks at the reduction at all, so even DR/— leaves an
 * acid tick untouched. This is therefore the exact test for "are the bypass chips meaningful".
 *
 * @param {string[]} types
 * @returns {boolean}
 */
export function hasPhysicalType(types) {
  return (types ?? []).some((t) => pf1?.registry?.damageTypes?.get(t)?.isPhysical === true);
}

/**
 * Normalize one stored instance into the shape the rest of this module expects. Everything is
 * defensive: these are hand-editable flags, and a half-written entry should degrade rather than
 * throw during a combat tick.
 *
 * @param {string} id
 * @param {object} raw
 * @returns {object}
 */
function normalize(id, raw = {}) {
  const kind = raw.kind === "healing" ? "healing" : "damage";
  const timing = TIMINGS.includes(raw.timing) ? raw.timing : "turnEnd";
  const types = kind === "healing" ? [] : (Array.isArray(raw.types) ? raw.types.filter((t) => !!t) : []);

  // Bypass is dropped wherever it can't mean anything, which is also exactly when the sheet hides
  // the controls — so a chip can never be silently in effect with nowhere to see it. Dropped on
  // read rather than on write, so switching a type back to something physical restores the chips
  // the user had already picked instead of quietly discarding their work.
  const stored = kind === "healing" ? [] : (Array.isArray(raw.bypass) ? raw.bypass.filter((t) => !!t) : []);
  const bypass = hasPhysicalType(types) ? stored : [];

  // Hardness is deliberately *not* gated on damage type. Unlike DR it reduces any non-untyped
  // instance, energy included, so an acid tick against a construct meets it and needs a way past.
  const ignoreHardness = kind === "healing" ? false : raw.ignoreHardness === true;

  return {
    id,
    enabled: raw.enabled !== false,
    label: String(raw.label ?? "").trim(),
    kind,
    formula: String(raw.formula ?? "").trim(),
    types,
    bypass,
    ignoreHardness,
    timing,
    onActivate: raw.onActivate === true,
  };
}

/**
 * Every instance configured on an item, in stored order.
 *
 * @param {Item} item
 * @returns {object[]}
 */
export function readInstances(item) {
  const stored = item?.getFlag?.(MODULE_ID, DOT_FLAG)?.instances;
  if (!stored || typeof stored !== "object") return [];
  return Object.entries(stored)
    .filter(([, raw]) => raw && typeof raw === "object")
    .map(([id, raw]) => normalize(id, raw));
}

/**
 * Whether an item's DoT is live right now.
 *
 * `isActive` is the system's own answer to this and already encodes every per-type rule we'd
 * otherwise have to restate: a buff is active, a physical item is equipped and undestroyed and not
 * buried in a container, an implant is implanted, a feat isn't disabled, and anything without a
 * notion of state (a feature, a racial trait) is simply always on.
 *
 * @param {Item} item
 * @returns {boolean}
 */
export function isLive(item) {
  return item?.isActive !== false;
}

/**
 * The initiative count an item's effect was created on, or null.
 *
 * PF1 stamps this onto a buff's Active Effect at activation (`system.initiative`), which is the same
 * datum its own initiative-based duration expiry reads. Nothing else records one — an equipped
 * weapon has no effect to carry it, and a buff switched on outside combat has no count to record.
 *
 * @param {Item} item
 * @returns {number|null}
 */
function recordedInitiative(item) {
  for (const ae of item?.effects ?? []) {
    const init = ae.system?.initiative;
    if (Number.isFinite(init)) return init;
  }
  return null;
}

/**
 * The timing an instance actually fires on.
 *
 * `initiative` degrades to `turnStart` when there is no recorded count to compare against, which is
 * the common case for everything that isn't a buff activated mid-combat. Silently ticking on the
 * carrier's turn is a far better failure than an instance that never fires.
 *
 * @param {Item} item
 * @param {object} inst
 * @returns {string}
 */
function effectiveTiming(item, inst) {
  if (inst.timing !== "initiative") return inst.timing;
  return recordedInitiative(item) === null ? "turnStart" : "initiative";
}

/**
 * Every live, enabled, rollable instance on an actor matching a timing.
 *
 * @param {Actor} actor
 * @param {string} timing
 * @returns {Array<{item:Item, inst:object}>}
 */
function collect(actor, timing) {
  const out = [];
  for (const item of actor?.items ?? []) {
    if (!isLive(item)) continue;
    for (const inst of readInstances(item)) {
      if (!inst.enabled || !inst.formula) continue;
      if (effectiveTiming(item, inst) !== timing) continue;
      out.push({ item, inst });
    }
  }
  return out;
}

/* -------------------------------------------- *
 *  Rolling
 * -------------------------------------------- */

/**
 * Roll one instance.
 *
 * Roll data comes from the *item*, so `@item.level` scales with a buff exactly as burning's formula
 * does, and the carrier's own actor data is reachable through the item's roll data as usual.
 *
 * @param {Item} item
 * @param {object} inst
 * @returns {Promise<Roll|null>}
 */
async function rollInstance(item, inst) {
  const types = inst.kind === "healing" ? ["untyped"] : (inst.types.length ? inst.types : ["untyped"]);
  try {
    const roll = new pf1.dice.DamageRoll(inst.formula, item.getRollData(), { damageType: types });
    await roll.evaluate();
    return roll;
  } catch (err) {
    console.error(`${MODULE_ID} | DoT: "${inst.formula}" failed to roll on ${item.name}`, err);
    return null;
  }
}

/**
 * Whether an actor is vulnerable to any of a set of damage types.
 *
 * PF1's own apply-damage dialog leaves vulnerability *off* by default and waits for a human to tick
 * the box. A tick has no human, and burning already auto-applies vulnerability, so we apply it here
 * too — as a multiplier on the rolled value before reduction, matching the order the dialog uses
 * (vulnerability increases what lands, resistance then subtracts from it).
 *
 * @param {Actor} actor
 * @param {string[]} types
 * @returns {boolean}
 */
function isVulnerable(actor, types) {
  const dv = actor?.system?.traits?.dv?.total;
  if (!dv?.has) return false;
  return types.some((t) => dv.has(t));
}

/* -------------------------------------------- *
 *  Reduction (the system's own math, headless)
 * -------------------------------------------- */

/**
 * A minimal stand-in for an `ItemAction`, carrying the instance's bypass chips.
 *
 * `ApplyDamage._evaluateAttack()` reads only a handful of properties off the action it's given and
 * returns immediately when given none at all, so this is enough to feed the material and alignment
 * penetration the real thing would. Note that "magic" rides in as a material rather than through
 * `isMagic`: the dialog's `isMagic` is derived solely from an enhancement bonus, but every place
 * that consults it also consults `materials`, so adding the id directly gets DR/magic penetrated
 * without pretending the DoT came from a +1 weapon (which would drag in the whole enhancement
 * material-penetration table).
 *
 * @param {string[]} bypass - Material and alignment ids.
 * @returns {object}
 */
function fakeAction(bypass) {
  const chosen = new Set(bypass ?? []);
  const alignments = {};
  for (const id of Object.keys(pf1.config.damageResistances)) alignments[id] = chosen.has(id);

  return {
    // Truthy so the alignment loop runs; its own `alignments` are the fallback ours take priority over.
    item: { alignments: {} },
    actor: null,
    enhancementBonus: 0,
    normalMaterial: null,
    addonMaterial: [...chosen].filter((id) => !(id in pf1.config.damageResistances)),
    alignments,
  };
}

/**
 * Options the system would apply for this damage against this actor, DR/ER/hardness/immunity
 * included — obtained by building the apply-damage dialog and never showing it.
 *
 * This is the single most version-fragile point in the feature, so failure is contained: a throw
 * here means the tick lands unreduced with an error in the console, rather than not landing at all.
 *
 * @param {Actor} actor
 * @param {number} value - Total damage before reduction.
 * @param {object[]} instances - `DamagePartModel`s carrying per-type values.
 * @param {string[]} bypass
 * @param {boolean} [ignoreHardness]
 * @returns {{options:object, reduction:object}|null}
 */
function reductionFor(actor, value, instances, bypass, ignoreHardness = false) {
  try {
    const app = new pf1.applications.ApplyDamage({
      value,
      instances,
      targets: [actor],
      action: fakeAction(bypass),
    });

    const target = app.targets.get(actor.uuid) ?? app.targets.first();
    if (!target) return null;

    // Switch hardness off the same way the dialog's own checkbox does, then recompute. Skipped
    // entirely if `_refreshTarget` ever goes away, so the worst case is hardness still applying
    // rather than a stale total that counted it twice.
    if (ignoreHardness && target.hardness?.active && typeof app._refreshTarget === "function") {
      target.hardness.active = false;
      app._refreshTarget(target.uuid);
    }

    // Strip the dialog's UI-context flags — nothing about this application was interactive, and
    // other modules key behaviour off them. Everything else (including Nevela's `_nasDamageDialog`
    // marker, stamped by its own wrapper on the call above) is passed through untouched.
    const { interactive, dialog, element, event, message, ...options } = app._getTargetDamageOptions(target);

    return { options, reduction: target.reduction ?? {} };
  } catch (err) {
    console.error(`${MODULE_ID} | DoT: reduction unavailable, applying unreduced`, err);
    return null;
  }
}

/* -------------------------------------------- *
 *  Resolution
 * -------------------------------------------- */

/**
 * Roll a set of instances and apply them, bucketed so that everything sharing one application is
 * applied as one call.
 *
 * A bucket is one `applyDamage()`, which means its damage reduction is consumed *once* across every
 * instance inside it — the same way an attack's several damage parts share the target's DR. Buckets
 * split on the things that can't share an application: the source item, damage versus healing,
 * lethal versus nonlethal (a whole-application flag), and the bypass set (materials are a property
 * of the application, not of an instance).
 *
 * @param {Actor} actor
 * @param {Array<{item:Item, inst:object}>} entries
 * @returns {Promise<object[]>} - Per-bucket results, for the chat card.
 */
async function resolve(actor, entries) {
  /** @type {Map<string, object>} */
  const buckets = new Map();

  for (const { item, inst } of entries) {
    const roll = await rollInstance(item, inst);
    if (!roll) continue;

    const rolled = Math.max(0, Math.floor(roll.total || 0));
    const vulnerable = inst.kind === "damage" && isVulnerable(actor, inst.types);
    const value = vulnerable ? Math.floor(rolled * 1.5) : rolled;

    const nonlethal = inst.types.includes("nonlethal");
    const key = [item.id, inst.kind, nonlethal, inst.ignoreHardness, [...inst.bypass].sort().join(",")].join("|");

    if (!buckets.has(key)) {
      buckets.set(key, {
        item,
        kind: inst.kind,
        nonlethal,
        bypass: inst.bypass,
        ignoreHardness: inst.ignoreHardness,
        rows: [],
        rolls: [],
        raw: 0,
      });
    }
    const bucket = buckets.get(key);
    bucket.rows.push({ inst, roll, rolled, value, vulnerable });
    bucket.rolls.push(roll);
    bucket.raw += value;
  }

  const results = [];
  for (const bucket of buckets.values()) {
    results.push(await applyBucket(actor, bucket));
  }
  return results;
}

/**
 * Apply one bucket and describe what happened.
 *
 * @param {Actor} actor
 * @param {object} bucket
 * @returns {Promise<object>}
 */
async function applyBucket(actor, bucket) {
  if (bucket.raw <= 0) return { ...bucket, applied: 0, reduction: {} };

  // Healing skips the reduction machinery entirely — PF1's own pipeline does no DR/ER on a negative
  // value, and there is nothing sensible for hardness or immunity to mean here.
  if (bucket.kind === "healing") {
    await actor.applyDamage(-bucket.raw);
    return { ...bucket, applied: bucket.raw, reduction: {} };
  }

  const instances = bucket.rows.map((row) => {
    const part = new pf1.models.action.DamagePartModel({
      types: row.inst.types.length ? row.inst.types : ["untyped"],
    });
    part.value = row.value;
    return part;
  });

  const computed = reductionFor(actor, bucket.raw, instances, bucket.bypass, bucket.ignoreHardness);
  const options = { ...(computed?.options ?? {}), asNonlethal: bucket.nonlethal };
  const reduction = computed?.reduction ?? {};

  const applied = Math.max(0, bucket.raw - (Number(options.reduction) || 0));
  if (applied > 0) await actor.applyDamage(bucket.raw, options);

  return { ...bucket, applied, reduction };
}

/* -------------------------------------------- *
 *  Chat card
 * -------------------------------------------- */

/**
 * Escape a value for interpolation into markup.
 *
 * @param {*} value
 * @returns {string}
 */
function esc(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

/**
 * Human-readable names for a set of damage type ids.
 *
 * @param {string[]} types
 * @returns {string}
 */
function typeLabel(types) {
  if (!types.length) return "";
  return types.map((t) => pf1.registry.damageTypes.get(t)?.name ?? t).join(", ");
}

/**
 * Summarize what the target's defences did to a bucket, so a reduced number never reads as a
 * miscalculation. Empty when everything landed.
 *
 * @param {object} result
 * @returns {string}
 */
function mitigationNote(result) {
  const parts = [];
  const r = result.reduction ?? {};

  if (result.rows.some((row) => row.vulnerable)) parts.push(game.i18n.localize("BLD.DoT.Note.Vulnerable"));
  if (r.immunized > 0) parts.push(game.i18n.format("BLD.DoT.Note.Immune", { amount: r.immunized }));
  if (r.physical > 0) parts.push(game.i18n.format("BLD.DoT.Note.DR", { amount: r.physical }));
  if (r.energy > 0) parts.push(game.i18n.format("BLD.DoT.Note.Resisted", { amount: r.energy }));
  if (r.hardness > 0) parts.push(game.i18n.format("BLD.DoT.Note.Hardness", { amount: r.hardness }));

  return parts.length ? `<span class="bld-dot-note">(${parts.join("; ")})</span>` : "";
}

/**
 * Post one consolidated card per actor per tick.
 *
 * One card rather than one per instance is a deliberate choice: a bloated chat log is a known cause
 * of UI lag, and a four-instance item across a six-round fight is the difference between six
 * messages and twenty-four.
 *
 * @param {Actor} actor
 * @param {object[]} results
 */
async function postCard(actor, results) {
  const live = results.filter((r) => r.rows.length);
  if (!live.length) return;

  const blocks = live.map((result) => {
    const rows = result.rows
      .map((row, index) => {
        const label = row.inst.label || game.i18n.format("BLD.DoT.InstanceN", { n: index + 1 });
        const types = typeLabel(row.inst.types);
        return `<li class="bld-dot-row">
          <span class="bld-dot-label">${esc(label)}</span>
          <span class="bld-dot-roll" data-tooltip="${esc(row.roll.formula)}">${esc(row.roll.formula)}</span>
          <span class="bld-dot-value">${row.value}</span>
          ${types ? `<span class="bld-dot-types">${esc(types)}</span>` : ""}
        </li>`;
      })
      .join("");

    const key = result.kind === "healing" ? "BLD.DoT.Healed" : "BLD.DoT.Damaged";
    const outcome =
      result.applied > 0
        ? game.i18n.format(key, { total: result.applied })
        : game.i18n.localize("BLD.DoT.Negated");

    return `<div class="bld-dot-bucket bld-dot-${result.kind}">
      <p class="bld-dot-source"><i class="fa-solid ${result.kind === "healing" ? "fa-heart-pulse" : "fa-hourglass-half"}"></i> ${esc(result.item.name)}</p>
      <ul class="bld-dot-rows">${rows}</ul>
      <p class="bld-dot-outcome">${outcome} ${mitigationNote(result)}</p>
    </div>`;
  });

  const content = `<div class="bld-dot-card" data-tooltip-class="bld-tooltip">
    <p class="bld-dot-title"><strong>${esc(actor.name)}</strong></p>
    ${blocks.join("")}
  </div>`;

  // The rolls are what make Dice So Nice animate; Foundry leaves our content alone because it has
  // child elements, so they don't render a second time as a dice tray.
  await ChatMessage.create({
    content,
    rolls: live.flatMap((r) => r.rolls),
    speaker: ChatMessage.getSpeaker({ actor }),
  });
}

/* -------------------------------------------- *
 *  Tick
 * -------------------------------------------- */

/**
 * Roll, apply and report a set of instances for one actor.
 *
 * @param {Actor} actor
 * @param {Array<{item:Item, inst:object}>} entries
 */
async function tick(actor, entries) {
  if (!entries.length) return;
  try {
    const results = await resolve(actor, entries);
    await postCard(actor, results);
  } catch (err) {
    console.error(`${MODULE_ID} | DoT: tick failed for ${actor?.name}`, err);
  }
}

/**
 * Tick one timing for one combatant, skipping the defeated.
 *
 * @param {Combatant|null} combatant
 * @param {string} timing
 */
async function tickCombatant(combatant, timing) {
  const actor = combatant?.actor;
  if (!actor || combatant.isDefeated) return;
  await tick(actor, collect(actor, timing));
}

/**
 * Initiative-timed instances, for every combatant carrying one whose recorded count the turn order
 * has now reached.
 *
 * PF1's own initiative-based expiry asks the same question — "is the current initiative at or below
 * the count this was created on" — but only needs to answer it once, because the effect it expires
 * then goes away. A recurring tick has to answer it once *per round*, since every combatant later in
 * the order also satisfies it, hence the guard.
 *
 * @param {Combat} combat
 */
async function tickInitiative(combat) {
  const current = combat.combatant?.initiative;
  if (!Number.isFinite(current)) return;

  let guard = fired.get(combat.id);
  if (!guard || guard.round !== combat.round) {
    guard = { round: combat.round, keys: new Set() };
    fired.set(combat.id, guard);
  }

  for (const combatant of combat.combatants) {
    const actor = combatant?.actor;
    if (!actor || combatant.isDefeated) continue;

    const due = [];
    for (const entry of collect(actor, "initiative")) {
      const recorded = recordedInitiative(entry.item);
      if (recorded === null || current > recorded) continue;

      const key = `${actor.id}:${entry.item.id}:${entry.inst.id}`;
      if (guard.keys.has(key)) continue;
      guard.keys.add(key);
      due.push(entry);
    }

    await tick(actor, due);
  }
}

/**
 * `updateCombat` handler — the only scheduled entry point.
 *
 * Turn boundaries are the only clock a DoT has, so nothing ticks outside combat. Order matches the
 * system's own turn processing: the turn that just ended, then the one starting, then initiative.
 *
 * @param {Combat} combat
 * @param {object} changed
 */
async function onUpdateCombat(combat, changed) {
  if (!isActiveGM()) return; // exactly one executor
  if (!combat.started) return;
  if (changed.round === undefined && changed.turn === undefined) return;

  const previous = cursors.get(combat.id);
  const position = { round: combat.round, turn: combat.turn, combatantId: combat.combatant?.id ?? null };
  cursors.set(combat.id, position);

  // Rewinding the tracker, or re-reading a position we already processed, must not deal damage.
  if (previous) {
    const forward =
      position.round > previous.round ||
      (position.round === previous.round && position.turn > previous.turn);
    if (!forward) return;

    await tickCombatant(combat.combatants.get(previous.combatantId) ?? null, "turnEnd");
  }

  await tickCombatant(combat.combatant ?? null, "turnStart");
  await tickInitiative(combat);
}

/** Forget a combat's bookkeeping when it ends. */
function onDeleteCombat(combat) {
  cursors.delete(combat.id);
  fired.delete(combat.id);
}

/* -------------------------------------------- *
 *  Tick on activation
 * -------------------------------------------- */

/**
 * Whether an update is the moment an item became live.
 *
 * Read from the diff rather than by comparing states, because `updateItem` is the only hook that
 * reaches every client — `preUpdateItem` fires solely on the client that made the change, so a
 * player toggling a buff would never reach the GM that has to act on it. Foundry only includes keys
 * that actually changed, so the presence of the flag in `changed` *is* the transition.
 *
 * @param {Item} item
 * @param {object} changed
 * @returns {boolean}
 */
function becameLive(item, changed) {
  const system = changed?.system ?? {};
  if (item.type === "buff") return system.active === true;
  if ("equipped" in system) return system.equipped === true;
  if ("implanted" in system) return system.implanted === true;
  if ("disabled" in system) return system.disabled === false;
  return false;
}

/**
 * Deal the opening tick for instances that asked for one.
 *
 * Unlike the scheduled timings this fires outside combat too. It's an event, not a schedule — the
 * thing happened, and refusing to resolve it because no combat is running would just lose it.
 *
 * @param {Item} item
 */
async function tickOnActivate(item) {
  const actor = item?.actor;
  if (!actor || !isLive(item)) return;

  const due = readInstances(item)
    .filter((inst) => inst.enabled && inst.formula && inst.onActivate)
    .map((inst) => ({ item, inst }));

  await tick(actor, due);
}

/* -------------------------------------------- *
 *  API
 * -------------------------------------------- */

/**
 * Resolve an Item from an Item or a UUID string.
 *
 * @param {Item|string} ref
 * @returns {Item|null}
 */
function resolveItem(ref) {
  if (ref instanceof Item) return ref;
  if (typeof ref === "string") {
    const doc = fromUuidSync(ref);
    return doc instanceof Item ? doc : null;
  }
  return null;
}

export const DotAPI = {
  /** Every instance configured on an item. */
  list: (ref) => readInstances(resolveItem(ref)),

  /** Whether an item's DoT is currently live. */
  isLive: (ref) => isLive(resolveItem(ref)),

  /**
   * Roll and apply every instance on an actor matching a timing, right now. Intended for macros and
   * for testing a configuration without waiting for the turn to come round.
   *
   * @param {Actor|Token|TokenDocument|string} target
   * @param {string} [timing]
   */
  trigger: async (target, timing = "turnStart") => {
    const actor = resolveActor(target);
    if (!actor) {
      ui.notifications.error(game.i18n.localize("BLD.DoT.Error.NoTarget"));
      return;
    }
    await tick(actor, collect(actor, timing));
  },
};

/* -------------------------------------------- *
 *  Registration
 * -------------------------------------------- */

Hooks.once("init", () => {
  const mod = game.modules.get(MODULE_ID);
  mod.api ??= {};
  mod.api.dot = DotAPI;
  globalThis.pf1DamageOverTime = DotAPI; // convenience for macros
});

Hooks.on("updateCombat", onUpdateCombat);
Hooks.on("deleteCombat", onDeleteCombat);

Hooks.on("updateItem", (item, changed) => {
  if (!isActiveGM()) return;
  if (!item.actor) return;
  if (!becameLive(item, changed)) return;
  tickOnActivate(item);
});

Hooks.on("createItem", (item) => {
  if (!isActiveGM()) return;
  if (!item.actor) return;
  tickOnActivate(item);
});
