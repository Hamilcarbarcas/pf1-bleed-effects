/* ============================================================
 * Damage Over Time — time jump
 *
 * Every engine in this module is driven by `updateCombat`, so advancing the
 * clock outside combat ticks none of them. This walks an elapsed span round by
 * round, previews the result, and applies it as a single write per bucket.
 *
 * Contributes to astora-mod's `astoraTimeAdvance` gate rather than acting on
 * `updateWorldTime` directly: the gate collects before the advance, shows the
 * numbers, and calls the commit that produced them, so the dialog's figures are
 * the figures that land. See DESIGN-TIMEJUMP.md and, for the reasoning,
 * astora-mod/time-advance/DESIGN.md §6.
 *
 * Deliberately separate from dot.mjs's own tick path, which is unchanged.
 * ============================================================ */

import {
  collect,
  esc,
  isVulnerable,
  nextTickTime,
  reductionFor,
  rollInstance,
  roundSeconds,
  typeLabel,
} from "./dot.mjs";
import {
  applyBleedTotals,
  getEffects as getBleedEffects,
  kindLabel,
  parseKind,
  rollBleedRound,
} from "./bleed.mjs";
import { healingRefusedBy } from "./dot-common.mjs";

const MODULE_ID = "pf1-bleed-effects";

/** Timings that all collapse to "once per round" when there is no turn order. */
const TIMINGS = ["turnStart", "turnEnd", "initiative"];

/* -------------------------------------------- *
 *  Instance lifetime
 * -------------------------------------------- */

/**
 * Rounds an item's effect has left, or Infinity when it has no duration.
 *
 * Duration lives on the item's Active Effect, not on `system.duration` — a PF1
 * buff is a wrapper around an AE and only the AE carries `startTime`.
 *
 * @param {Item} item
 * @returns {number}
 */
function roundsRemaining(item) {
  let shortest = Infinity;

  for (const ae of item?.effects ?? []) {
    const { seconds, startTime } = ae.duration ?? {};
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    const elapsed = game.time.worldTime - (startTime ?? 0);
    const left = Math.ceil((seconds - elapsed) / (CONFIG.time.roundTime || 6));
    shortest = Math.min(shortest, Math.max(0, left));
  }

  return shortest;
}

/**
 * Every live instance on an actor, with how long each lasts.
 *
 * Out of combat there is no turn order, so all three timings mean "once this
 * round" and are gathered together.
 *
 * @param {Actor} actor
 * @returns {Array<{item:Item, inst:object, life:number}>}
 */
function gather(actor) {
  const out = [];
  for (const timing of TIMINGS) {
    for (const entry of collect(actor, timing)) {
      out.push({ ...entry, life: roundsRemaining(entry.item) });
    }
  }
  return out;
}

/* -------------------------------------------- *
 *  Reduction, memoized
 * -------------------------------------------- */

/**
 * Per-round reduction, cached by rolled value.
 *
 * `reductionFor` builds a whole ApplyDamage application, which is far too heavy
 * to run hundreds of times. It is a pure function of (actor, types, bypass,
 * hardness, value), and a dice formula only produces a handful of distinct
 * totals — 2d6 has eleven — so memoizing on the value bounds the cost at the
 * size of the formula's range no matter how many rounds elapse.
 *
 * @param {Actor} actor
 * @param {object} inst
 * @param {Map<number, object>} memo
 * @param {number} value
 * @returns {{options:object, reduction:object}|null}
 */
function reductionCached(actor, inst, memo, value) {
  if (memo.has(value)) return memo.get(value);

  const part = new pf1.models.action.DamagePartModel({
    types: inst.types.length ? inst.types : ["untyped"],
  });
  part.value = value;

  const computed = reductionFor(actor, value, [part], inst.bypass, inst.ignoreHardness);
  memo.set(value, computed);
  return computed;
}

/* -------------------------------------------- *
 *  The walk
 * -------------------------------------------- */

/**
 * Simulate an elapsed span against one actor without writing anything.
 *
 * Damage and healing interleave against a running hit point total, because
 * summing them separately answers both questions wrong: fast healing caps at
 * maximum, and the round someone crosses zero depends on the two alternating.
 *
 * The walk steps from one *tick* to the next rather than round by round, which
 * is what lets a coarse interval resolve at all: an instance firing once a day
 * costs seven steps across a week instead of exhausting the ceiling inside the
 * first half hour. Where everything fires every round — bleed always does — the
 * steps and the rounds are the same thing and this behaves exactly as it did
 * before intervals existed.
 *
 * The ceiling is therefore spent in steps, not rounds. That keeps its meaning
 * for the case it was written for (rounds of bleed) while letting a sparse
 * schedule reach the end of a long advance.
 *
 * @param {Actor} actor
 * @param {number} rounds
 * @param {number} ceiling
 * @returns {Promise<object|null>} Preview, or null when nothing applies.
 */
export async function previewSpan(actor, rounds, ceiling) {
  /* Healing an effect refuses never happens, so it must not be walked either. The walk is not a
   * summary of the damage — it interleaves, and both the hit point total it ends on and the round
   * it crosses zero depend on healing that will actually land. Dropped here rather than skipped
   * inside the loop so a refused regeneration also stops keeping the walk alive. */
  const entries = gather(actor).filter(
    (e) => e.inst.kind !== "healing" || !healingRefusedBy(actor, { item: e.item }).length
  );
  // Bleed is a separate engine with its own storage, and has no duration — it
  // runs until it is healed or cleared, so it never retires the walk on its own.
  const bleeds = getBleedEffects(actor);
  if (!entries.length && !bleeds.length) return null;

  const hp = actor.system?.attributes?.hp ?? {};
  const maxHp = Number(hp.max) || 0;
  let currentHp = Number(hp.value) || 0;

  const budget = Math.max(1, ceiling);

  /** Per-entry running totals, keyed by the bucket they will be applied through. */
  const totals = new Map();
  const memos = new Map();

  /** Bleed totals by kind, accumulated across rounds. */
  const bleedTotals = new Map();

  let damageTaken = 0;
  let healingDone = 0;
  let deathRound = null;
  let simulated = 0;
  let stoppedEarly = false;

  /* The advance hasn't happened yet — the gate collects before it moves the clock — so round `r`
   * of the walk is the slice ending at `start + r * rs`, and a tick at time `t` belongs to the
   * round `ceil((t - start) / rs)`. That is the same arithmetic `isDue` uses in combat, so a span
   * walked here and the same span played out at the table fire on the same rounds. */
  const rs = roundSeconds();
  const start = game.time.worldTime;
  const roundOf = (time) => Math.max(1, Math.ceil((time - start) / rs));

  /** One cursor per entry: when it next fires, and which round of the walk that is. */
  const schedules = entries.map((entry) => {
    const time = nextTickTime(entry.item, entry.inst, start);
    return { entry, time, round: roundOf(time) };
  });

  /** Bleed has no interval — it is every round, from the first. */
  let bleedRound = bleeds.length ? 1 : Infinity;

  for (let steps = 0; ; steps++) {
    // The next round at which anything at all happens, retiring whatever has outlived its effect.
    let round = bleedRound;
    for (const cursor of schedules) {
      if (cursor.round === null) continue;
      if (cursor.round > cursor.entry.life) {
        cursor.round = null; // expired before its next tick came round
        continue;
      }
      if (cursor.round < round) round = cursor.round;
    }

    if (!Number.isFinite(round)) break; // every instance expired

    if (round > rounds) {
      // The whole advance was covered, so that — not the round of the last tick — is what was
      // simulated. With a sparse schedule the two are a long way apart.
      simulated = rounds;
      break;
    }

    if (steps >= budget) {              // the ceiling, spent in ticks
      stoppedEarly = true;
      break;
    }

    simulated = round;

    if (round === bleedRound) {
      const byKind = await rollBleedRound(actor, bleeds);
      for (const [kind, total] of byKind) {
        if (!(total > 0)) continue;
        bleedTotals.set(kind, (bleedTotals.get(kind) ?? 0) + total);

        // Only hit point bleed moves the running total; ability damage and
        // drain are tracked and reported, but do not decide the death round.
        if (parseKind(kind)?.track === "hp") {
          currentHp -= total;
          damageTaken += total;
          if (currentHp < 0 && deathRound === null) deathRound = round;
        }
      }
      bleedRound = round + 1;
    }

    for (const cursor of schedules) {
      if (cursor.round !== round) continue;
      const { entry } = cursor;

      // Advance the cursor before anything can `continue` past it, so a formula that fails to roll
      // costs one tick rather than wedging the walk on the same round forever.
      cursor.time = nextTickTime(entry.item, entry.inst, cursor.time);
      cursor.round = Math.max(round + 1, roundOf(cursor.time));

      const roll = await rollInstance(entry.item, entry.inst);
      if (!roll) continue;

      const rolled = Math.max(0, Math.floor(roll.total || 0));
      const key = entry.item.id + "|" + entry.inst.id;
      if (!totals.has(key)) {
        totals.set(key, { entry, raw: 0, reduction: 0, applied: 0, options: null, rolls: [] });
      }
      const bucket = totals.get(key);

      if (entry.inst.kind === "healing") {
        bucket.raw += rolled;
        bucket.applied += rolled;
        bucket.rolls.push(roll);
        const room = Math.max(0, maxHp - currentHp);
        const healed = Math.min(rolled, room);
        currentHp += healed;
        healingDone += healed;
        continue;
      }

      const value = isVulnerable(actor, entry.inst.types) ? Math.floor(rolled * 1.5) : rolled;
      if (!memos.has(key)) memos.set(key, new Map());
      const computed = reductionCached(actor, entry.inst, memos.get(key), value);

      const cut = Number(computed?.options?.reduction) || 0;
      const applied = Math.max(0, value - cut);

      bucket.raw += value;
      bucket.reduction += Math.min(cut, value);
      bucket.applied += applied;
      bucket.rolls.push(roll);
      bucket.options ??= computed?.options ?? null;

      currentHp -= applied;
      damageTaken += applied;

      if (currentHp < 0 && deathRound === null) deathRound = round;
    }

    if (deathRound !== null) break;                     // stop at the crossing
    if (damageTaken === 0 && currentHp >= maxHp) break; // healed up, nothing hurting
  }

  const buckets = [...totals.values()].filter((b) => b.applied > 0);
  if (!buckets.length && !bleedTotals.size) return null;

  const healingOnly = !bleedTotals.size && buckets.every((b) => b.entry.inst.kind === "healing");

  return {
    actor,
    buckets,
    bleedTotals,
    rounds,
    simulated,
    truncated: stoppedEarly && simulated < rounds,
    damageTaken,
    healingDone,
    deathRound,
    finalHp: currentHp,
    maxHp,
    healingOnly,
  };
}

/* -------------------------------------------- *
 *  Reporting
 * -------------------------------------------- */

/**
 * One line naming each component, so the total can be checked against its parts.
 *
 * @param {object} preview
 * @returns {string}
 */
function describe(preview) {
  const bleed = [...(preview.bleedTotals ?? [])]
    .filter(([, total]) => total > 0)
    .map(([kind, total]) => game.i18n.format("BLD.TimeJump.Bleed", { n: total, kind: kindLabel(kind) }));

  return bleed.concat(preview.buckets.map((b) => {
    const { inst, item } = b.entry;
    if (inst.kind === "healing") {
      return game.i18n.format("BLD.TimeJump.Healing", { item: item.name, formula: inst.formula });
    }
    const cut = b.reduction > 0 ? game.i18n.format("BLD.TimeJump.Reduced", { n: b.reduction }) : "";
    return game.i18n.format("BLD.TimeJump.Damage", {
      item: item.name, formula: inst.formula, types: typeLabel(inst.types),
    }) + cut;
  })).join("; ");
}

/**
 * The gate's summary line for one actor.
 *
 * @param {object} preview
 * @returns {string}
 */
function summarize(preview) {
  const parts = [];
  if (preview.damageTaken > 0) parts.push(game.i18n.format("BLD.TimeJump.Takes", { n: preview.damageTaken }));
  if (preview.healingDone > 0) parts.push(game.i18n.format("BLD.TimeJump.Heals", { n: preview.healingDone }));

  let text = game.i18n.format("BLD.TimeJump.Over", {
    parts: parts.join(", "), rounds: preview.simulated, hp: preview.finalHp, max: preview.maxHp,
  });
  if (preview.deathRound !== null) {
    text += " " + game.i18n.format("BLD.TimeJump.Death", { round: preview.deathRound });
  }
  if (preview.truncated) {
    text += " " + game.i18n.format("BLD.TimeJump.Truncated", { rounds: preview.simulated });
  }
  return text;
}

/* -------------------------------------------- *
 *  Commit
 * -------------------------------------------- */

/**
 * Apply a preview. One `applyDamage` per bucket, carrying the summed reduction
 * the walk already computed, so what lands is what the dialog showed.
 *
 * @param {object} preview
 */
async function commit(preview) {
  const { actor } = preview;

  if (preview.bleedTotals?.size) {
    try {
      await applyBleedTotals(actor, preview.bleedTotals);
    } catch (err) {
      console.error(`${MODULE_ID} | time jump: could not apply bleed to ${actor?.name}`, err);
    }
  }

  for (const bucket of preview.buckets) {
    try {
      if (bucket.entry.inst.kind === "healing") {
        // Same source item the walk classified this by, so the intercept and the preview agree.
        await actor.applyDamage(-bucket.applied, { item: bucket.entry.item });
        continue;
      }
      const options = { ...(bucket.options ?? {}), reduction: bucket.reduction };
      await actor.applyDamage(bucket.raw, options);
    } catch (err) {
      console.error(`${MODULE_ID} | time jump: could not apply ${bucket.entry.item.name}`, err);
    }
  }
}

/**
 * A single GM-only card covering every actor resolved in one advance.
 *
 * @param {object[]} previews
 */
async function postSummary(previews) {
  const rows = previews.map((p) => `
    <li>
      <strong>${esc(p.actor.name)}</strong> — ${esc(summarize(p))}
      <div style="opacity:0.75;font-size:0.75rem;">${esc(describe(p))}</div>
    </li>`).join("");

  await ChatMessage.create({
    content: `<div><p><strong>${esc(game.i18n.localize("BLD.TimeJump.Heading"))}</strong></p><ul style="margin:0;padding-left:1.1rem;">${rows}</ul></div>`,
    whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id),
    flags: { [MODULE_ID]: { timeJump: true } },
  });
}

/* -------------------------------------------- *
 *  Gate contribution
 * -------------------------------------------- */

Hooks.once("init", () => {
  const mod = game.modules.get(MODULE_ID);
  mod.api ??= {};
  mod.api.timeJump = { previewSpan };   // write-free; for checking a span by hand
});

Hooks.on("astoraTimeAdvance", ({ rounds, ceiling, targets, warnings, promises }) => {
  const pending = (async () => {
    const previews = [];

    for (const { actor, name } of targets) {
      let preview;
      try {
        preview = await previewSpan(actor, rounds, ceiling ?? 300);
      } catch (err) {
        console.error(`${MODULE_ID} | time jump: preview failed for ${actor?.name}`, err);
        continue;
      }
      if (!preview) continue;

      previews.push(preview);
      warnings.push({
        name,
        // Healing alone has no decision attached, so it is shown when the dialog
        // is already open but never raises one.
        severity: preview.healingOnly ? "info" : "warn",
        text: summarize(preview),
        detail: describe(preview),
        actor,
      });
    }

    if (!previews.length) return;

    // One commit for the whole advance, so the card is a single message.
    warnings.push({
      name: "",
      severity: "info",
      text: "",
      silent: true,
      commit: async () => {
        for (const preview of previews) await commit(preview);
        await postSummary(previews);
      },
    });
  })();

  promises?.push(pending);
});
