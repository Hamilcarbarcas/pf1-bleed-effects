# PF1 Bleed Effects

A Pathfinder 1e (Foundry VTT) module that turns the **bleed** condition into automated, recurring damage.

While an actor is bleeding, registered bleed effects deal their damage **at the start of that actor's turn** in combat. Bleed can target hit points or any ability score's damage/drain.

## How it works

- Bleed effects are stored on the actor and the PF1 `bleed` condition is shown as the visual marker.
- Each round, every effect is rolled and grouped by **kind** (`hp`, or `<ability>.<damage|drain>`). Only the **highest rolled result of each kind** is applied — so two hit-point bleeds don't stack, but a hit-point bleed and a Constitution bleed both land in the same round.
- HP bleed is applied with the system's damage routine: it **ignores DR/ER**, never prompts a dialog, and draws from temporary HP first.
- Ability bleed is written straight to `system.abilities.<abl>.damage` / `.drain`, so it coexists cleanly with other automation (e.g. Nevela's Automation Suite, which reads/increments the same field).
- The active GM performs all damage application, so effects are applied exactly once regardless of how many clients are connected.

## Applying bleed

### Enricher

Use the `@Bleed[...]` enricher anywhere PF1 enriches text (item descriptions, journals, chat). It follows the standard PF1 `@Verb[primary;options]{label}` convention, where the primary argument is the **damage formula**:

| Example | Effect |
| --- | --- |
| `@Bleed[1d6]` | 1d6 hit point bleed |
| `@Bleed[@cl;type=con]` | Constitution **damage** bleed equal to caster level |
| `@Bleed[2;type=str;mode=drain]` | 2 Strength **drain** bleed |
| `@Bleed[1d4]{Open Wound}` | 1d4 HP bleed with a custom label |

Options:

- `type` — `hp` (default) or an ability key (`str`, `dex`, `con`, `int`, `wis`, `cha`).
- `mode` — `damage` (default) or `drain`. Ignored for `type=hp`.

`@`-references such as `@cl` are resolved **when the link is clicked**, using the roll data of the message's source actor (the one inflicting the bleed). Dice terms like `1d6` are left intact and rolled fresh each round.

Clicking the link applies the bleed to your current targets (falling back to controlled tokens / your assigned character), using PF1's standard target resolution.

### API

Exposed as `game.modules.get("pf1-bleed-effects").api` and the global `pf1BleedEffects`:

```js
// Register an ongoing bleed (accepts an Actor, Token, TokenDocument, or UUID)
await pf1BleedEffects.apply(token, { formula: "1d6", kind: "hp" });
await pf1BleedEffects.apply(actor, { formula: "1", kind: "con.damage" });

// Optionally lock @-references against a specific source actor
await pf1BleedEffects.apply(target, {
  formula: "@cl",
  kind: "con.damage",
  sourceRollData: casterActor.getRollData(),
});

// Inspect current effects
pf1BleedEffects.list(token); // -> [{ id, formula, kind }, ...]

// Remove one kind, or all bleed
await pf1BleedEffects.clear(token, { kind: "hp" });
await pf1BleedEffects.clear(token);
```

`kind` is `"hp"` or `"<ability>.<damage|drain>"` (e.g. `"con.damage"`, `"str.drain"`).

## Seeing what bleed is active

When an actor has registered bleed, the **bleed condition** gains a tooltip listing each active effect (formula + kind):

- **Actor sheet** — hover the bleed condition in the **Buffs** tab.
- **Token HUD** — hover the bleed status in the token's effects menu.
- **Little Helper Active Buffs HUD** — if [Koboldworks – Little Helper](https://gitlab.com/koboldworks/pf1/little-helper) is active, the bleed summary is appended to its top-right condition tooltip on token select.

If more than one effect is present, the tooltip notes that only the highest of each type applies per round.

Removing the bleed condition (token HUD, sheet, Little Helper, etc.) immediately clears its stored effects, so re-applying bleed starts fresh rather than stacking onto the old amounts.

## Stopping bleed

- Call `pf1BleedEffects.clear(...)`, **or**
- Remove the **bleed** condition from the token HUD. The next time that actor would tick, its stored bleed effects are cleared automatically.

## Notes & limitations

- A GM must be connected for bleed to be applied. The active GM (Foundry's `game.users.activeGM`) does the work.
- v1 intentionally omits save-to-end DCs, "healing ends bleed", and per-effect durations. Bleed persists until cleared or the condition is removed.

## Requirements

- Pathfinder 1e system (`pf1`) v11+.
- Foundry VTT v13.
