# Damage Over Time — Design

Status: **built**. This document is the source of truth for the feature; update it as decisions
change rather than letting the code drift away from it.

Three things landed differently from the plan below, all discovered during the build:

- **Buckets also split on the bypass set.** Materials are a property of the whole application, not of
  an instance, so two instances on one item with different "counts as" chips can't share one call.
- **Untyped damage bypasses everything.** PF1's `_isReducedBy` only reduces instances that are
  physical or energy, and hardness skips untyped outright — so an instance with no damage type set
  meets no DR, no ER and no hardness. Documented as a deliberate escape hatch rather than fixed.
- **`onActivate` fires out of combat.** It's an event, not a schedule; dropping it because no combat
  is running would simply lose it. The *scheduled* timings remain combat-only as designed.

Two later refinements:

- **Counts As is hidden unless a physical damage type is selected.** `_isReducedBy()` rejects any
  non-physical instance before it looks at the reduction at all, so DR — generic DR included — never
  touches energy or untyped damage, and the chips would be dead controls there. `normalize()` drops
  the stored values under the same test (`hasPhysicalType`), so the UI and the engine can't disagree
  and a hidden chip is never quietly in effect. Dropped on *read*, not on write, so switching the
  type back restores what the user had picked.
- **An explicit "Ignores → Hardness" checkbox**, shown on every damage instance regardless of type,
  because hardness is not DR: `_refreshTarget` applies it to any non-untyped instance, energy
  included. Implemented by switching `target.hardness.active` off and re-running `_refreshTarget()`
  — the same thing the dialog's own checkbox does — and skipped entirely if that method ever
  disappears, so the failure mode is hardness still applying rather than a stale double-count.
  Adamantine in Counts As continues to zero hardness ≤ 20 on its own, which is the system's rule.

## What it is

A generic, per-item **damage-over-time** configuration on the Advanced tab of any item. While the
item is live on an actor, each configured instance rolls its formula on a chosen turn boundary and
applies the result to the carrying actor — as damage (typed, and run through the actor's damage
reduction, energy resistance, hardness and immunities) or as healing.

It is *additive*. Bleed, burning, deep bleed and their buff configuration are untouched, and the two
systems don't consult each other. A buff can carry both.

## Locked decisions

| Question | Decision |
| --- | --- |
| DR that needs a material/alignment | Per-instance **bypass chips** ("counts as" magic / silver / adamantine / cold iron / alignments) |
| How damage reaches HP | **Auto-applied** by the active GM, with one consolidated chat card per actor per tick |
| Which item types | **Every** item type; live when active (buffs) or equipped (physical items), always live otherwise |
| Out of combat | **No ticks.** Combat only, like bleed and burning |
| Several instances, same timing | **One** `applyDamage` call carrying multiple damage instances — DR is consumed once across them |
| First tick on activation | **Per-instance "tick when it goes live" checkbox**, off by default |
| Relationship to bleed/burning | Additive; nothing migrated, nothing replaced |

## Data model

One item flag, `flags.pf1-bleed-effects.dot`, holding a keyed collection so entries survive reorder
and deletion cleanly (same shape as astora-mod's buff-delivery entries):

```jsonc
{
  "instances": {
    "<random id>": {
      "enabled": true,
      "label": "Acid blood",        // optional; falls back to "Instance N" in the UI and card
      "kind": "damage",             // "damage" | "healing"
      "formula": "1d6 + @item.level",
      "types": ["acid"],            // damage only; the action-sheet damage-type set
      "bypass": ["magic"],          // damage only; material/alignment ids, plus "magic"
      "timing": "turnEnd",          // "turnStart" | "turnEnd" | "initiative"
      "onActivate": false           // also tick once the moment it goes live
    }
  }
}
```

`kind: "healing"` hides the type and bypass controls entirely — they have no meaning for healing,
and PF1's own damage pipeline skips DR/ER/hardness/immunity when the value is negative.

### When is an instance live?

| Item type | Live when |
| --- | --- |
| `buff` | `system.active` |
| Physical items (weapon, equipment, armor, implant, container, loot) | `system.equipped` |
| Everything else (feat, class, race, spell, consumable, attack…) | Whenever the item is on the actor |

⚠️ **Noted caveat, implemented as chosen:** a spell in a spellbook is "known", not "active", so a DoT
configured on a spell item ticks continuously. That is the accepted consequence of covering every
item type. If it turns out to bite, the fix is a small exclusion list rather than a redesign.

## User interface

A collapsible **Damage Over Time** section appended to the Advanced tab of the item sheet
(`renderItemSheetPF`, `.tab[data-tab="advanced"]`), placed after Script Calls and before
pf1-defense-manager's Granted Defenses when those are present — the same anchoring logic
buff-delivery uses, so the three modules stack predictably instead of fighting.

- **Collapsible** via a copy of astora-mod's `makeCollapsible` helper (~80 lines + CSS). Cross-module
  imports aren't viable, so this is a deliberate duplication; the class names get a
  `bld-`/`pf1-bleed-` prefix rather than reusing `astora-collapsible`, so a de-dup sweep in either
  module can never delete the other's rows. Header carries a badge with the configured count.
- **Per instance:** enable toggle, label, formula input, damage-type chips, bypass chips, kind
  dropdown, timing dropdown, tick-on-activate checkbox, delete button. Plus an "add instance" button
  in the header.
- **Damage type picker is the real one.** `pf1.applications.DamageTypeSelector` takes
  `(object, path, typesSet, { updateCallback })` and only uses `path` to build its app id — so it can
  be pointed at our flag and given a callback that writes back to the item. Identical UI to the
  action sheet's damage parts, including the modifier categories.
- **Bypass chips** are our own small picker over `pf1.registry.materials` plus
  `pf1.config.damageResistances` (the alignment entries) plus `magic`.
- **Live formula preview** (`= 7` beside the input, per keystroke) using the item's roll data, matching
  the spell-capsule / buff-delivery precedent.

Writes go through explicit `item.update()` calls on change (`render: false` where the section doesn't
need to redraw), not the sheet's own form submission — the buff-config approach of naming inputs
`flags.…` doesn't extend to a collection with add/delete.

## Tick engine

A new `src/scripts/dot.mjs`, sharing `dot-common.mjs`'s actor resolution, active-GM test and socket
channel with the existing engines.

### Authority and execution

Exactly one executor: **the active GM**, same as bleed and burning. It owns the tick, the roll, the
application and the card. No socket round-trip is needed for the common case since the GM owns every
actor; the module socket stays as-is.

### Firing points

All driven from `updateCombat`, guarded by the existing `combat.id:round:turn` de-dupe key:

- **`turnStart`** — when the carrier becomes the current combatant.
- **`turnEnd`** — when the carrier stops being the current combatant (processed at the top of the
  next turn change, before that turn's start ticks, mirroring how burning finalizes pending saves).
- **`initiative`** — once per round, at the first turn whose `combatant.initiative` is **≤** the count
  recorded on the buff's Active Effect (`ae.system.initiative`, written by PF1 at activation —
  [item-buff.mjs:274](../foundryvtt-pathfinder1-v11.x/module/documents/item/item-buff.mjs#L274)).
  A per-round guard keyed by `combat.id:round:item.id:instanceId` keeps it to one tick even though
  every later combatant also satisfies `≤`. **With no recorded count** — a non-buff item, or a buff
  switched on outside combat — it silently behaves as `turnStart` for the carrier.

Defeated combatants are skipped, matching burning. Ticks fire regardless of the carrier's HP; a
healing DoT on a dying actor is exactly the case that should keep working.

### Ordering hazard

PF1 expires buffs from the *owning* client inside the same turn-change window, not from the GM, and
`expireActiveEffects` evaluates against `worldTime + advanceTime`. So whether a 1-round buff gets a
final tick on the turn it expires is a race we do not control. The engine reads live state at tick
time (`is the item still active right now`), which makes the behaviour consistent-but-unspecified at
that exact boundary. Worth knowing before someone reports it as a bug; not worth fighting.

## Damage resolution

Per actor, per firing point:

1. **Collect** every live instance across every item on the actor whose timing matches. Every item
   ticks independently — no "highest of each type" suppression like bleed. Two copies of the same
   item tick twice.
2. **Bucket** by `(item, kind, nonlethal-ness)`. One bucket becomes one application, so DR is
   consumed once across the instances inside it. Healing splits from damage; nonlethal splits from
   lethal, because `asNonlethal` is a whole-application flag.
3. **Roll** each instance as a `pf1.dice.DamageRoll(formula, item.getRollData(), { damageType: types })`.
   Roll data comes from the item, so `@item.level` scales with a buff exactly as burning's formula
   does today.
4. **Vulnerability** — instances whose type appears in the actor's `dv` are multiplied by 1.5 before
   the application is built (see *Defaults taken*).
5. **Reduce**, using the system's own math with no dialog:

   ```js
   const app = new pf1.applications.ApplyDamage({ value, instances, targets: [actor], action: fakeAction });
   const opts = app._getTargetDamageOptions(app.targets.get(actor.uuid));
   await actor.applyDamage(value, opts);
   ```

   The constructor runs `_prepareInstances` → `_evaluateAttack` → `_prepareTargets` → `_refreshTarget`,
   which computes immunities, DR, energy resistance and hardness. Nothing renders.

   `fakeAction` is a duck-typed object carrying the bypass chips —
   `{ item: { alignments: {} }, enhancementBonus: 0, normalMaterial: null, addonMaterial: [...bypass], alignments: {...} }`
   — because `_evaluateAttack` only reads those few properties and returns early when no action is
   given at all. This is the single most version-fragile point in the design; it is wrapped in a
   try/catch that falls back to unreduced application plus a console error, so a system update can
   degrade the feature but never break the tick.

6. **Apply** via `actor.applyDamage()`, positive for damage and negative for healing.

### Nevela's Automation Suite

No integration code needed, and none should be written. Nevela's libWraps
`ActorPF.prototype.applyDamage` and `ApplyDamage.prototype._getTargetDamageOptions`, and internally
uses this *exact* headless-`ApplyDamage` technique
([systemApplyDamage.js:1157](../nevelas-automation-suite/src/features/automation/damage/systemApplyDamage.js#L1157)).
Because we go through both of those, our ticks automatically pick up Nevela's temporary-HP pools,
damage absorption, fortification, stacked DR and on-struck reactive triggers — and its
`_nasDamageDialog` marker, stamped by its own wrapper on `_getTargetDamageOptions`, tells it DR has
already been accounted for, so nothing double-reduces. Its `applyNasHeadlessDamage()` is not on a
public API and must not be reached for.

### Nevela's cannot compute the reduction for us — checked, don't retry it

Handing Nevela's a bare `actor.applyDamage(value)` and letting it work out DR/ER **does not work**.
Its wrapper has three DR-touching paths and none of them fire for an automated tick:

- `normalizeStackedDamageReductionOptions` returns immediately unless `options.reduction` is already
  `> 0`. It corrects a reduction that stacked DR entries over-counted; it never derives one.
- `getMismatchedChatTargetHardnessFallback` requires a click context (`interactive` / `element` /
  `event`) plus chat-card targets. A tick has none, so it returns `null`.
- `nativeDamageReductionForApplyDamage` runs only inside `if (actorHasAbsorptionData(actor))`, and
  its first line returns zero when `reduction > 0` anyway.

With no `reduction` passed, the wrapper falls through to the system's `applyDamage`, which does no
DR/ER — so the result would be no DR, no energy resistance, no hardness and no immunities. Energy
resistance in particular is never computed on that path; Nevela's ER helper is only used for
absorption-*converted* damage.

The root reason is that Nevela's has no independent DR engine to defer to: its real handling comes
from wrapping `ApplyDamage.prototype._getTargetDamageOptions`, the same system math this design uses.
Computing the reduction ourselves also *improves* the interop, because
`nativeDamageReductionForApplyDamage` bails when `reduction > 0` — our value suppresses their
fallback rather than racing it.

## Dice and chat

One `ChatMessage` per actor per tick, with every instance's `DamageRoll` attached in `rolls`.

That single choice buys the animated dice: DSN's `renderRolls` stamps damage type and appearance on
every die of a message's rolls, and `pf1.dice.DamageRoll`'s constructor already sets
`options.appearance` from `pf1.registry.damageTypes[type].diceSoNice`. So a `1d6` acid instance rolls
a visibly acid d6 for every client, with no `showForRoll` plumbing and with working roll tooltips.

Card contents: the carrier's name, then a row per instance — label, formula, rolled total, type chips
— then the net applied, then a mitigation aside when anything was absorbed ("*12 resisted; immune to
cold*"), so a reduced number never reads as a miscalculation. Source item named per row, since a
character can be carrying several.

One card per actor per tick, not per instance: the chat log is a known source of UI lag in this world
and a four-instance item across a six-round fight is 24 cards versus 6.

## Defaults taken

Say the word on any of these and they flip; none of them change the architecture.

- **Vulnerability is auto-applied** (×1.5, rounded down, per matching instance). PF1's dialog leaves
  the `dv` checkboxes *off* by default and expects a human to tick them, but burning already
  auto-applies vulnerability, and a DoT with nobody at the keyboard has no one to tick the box.
- **Nonlethal is inferred** from the damage types, matching what `ActorPF.applyDamage` does for
  attacks. It drives the bucket split rather than being a separate control.
- **No ability damage/drain.** Bleed already covers `con.damage` and friends; adding it here would
  mean a second, parallel application path that the system's DR pipeline knows nothing about. Can be
  added later as a distinct `kind`.
- **No per-tick save.** Burning's Reflex-save machinery stays burning's. A DoT ticks unconditionally.
- **Healing is not capped or gated** beyond what `applyDamage` already does (clamps at max HP, heals
  nonlethal when `dualHeal` is on).

## Build order

1. **Flag model + read helpers** — `readInstances(item)`, `liveInstances(actor)`, the live-when rules.
   No UI, testable from the console.
2. **Resolution pipeline** — roll → bucket → headless `ApplyDamage` → `applyDamage`, plus the
   try/catch fallback. Driven by a temporary API function so it can be exercised before any tick
   engine exists.
3. **Tick engine** — `updateCombat` handling, the three timings, per-round guards, defeated skip.
4. **Chat card** — consolidated card, mitigation aside, rolls attached (DSN comes free here).
5. **Sheet UI** — collapsible section, instance rows, `DamageTypeSelector` reuse, bypass chips,
   formula preview, add/delete wiring.
6. **`onActivate`** — tick-on-activation, hung off the buff toggle / equip change.
7. **Docs** — README section, CHANGELOG entry, `lang/en.json` strings throughout.

## Files

New:
- `src/scripts/dot.mjs` — model, resolution, tick engine, API
- `src/scripts/dot-config.mjs` — sheet section
- `src/scripts/dot-collapse.mjs` — the `makeCollapsible` copy
- `src/styles/dot.css`

Changed:
- `module.json` — new `esmodules` and `styles` entries (**not** the version field; the release action
  sets that from the tag)
- `lang/en.json`, `README.md`, `CHANGELOG.md`
