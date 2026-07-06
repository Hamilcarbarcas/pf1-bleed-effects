# PF1 Bleed Effects

Adds automated, configurable damage-over-time to the Pathfinder 1e **bleed** and **burning** conditions.

## What it does

- Adds an enricher to apply specific types and amounts of bleed damage.
- Prompts for an amount and type when the bleed condition is applied by hand.
- Adds a **burning** condition (1d6 fire/round) with a turn-start Reflex save to put it out.
- API functions to apply bleed or burning via scripts/macros.
- Tool-tip display of active bleed effects.
- Multiple bleeds of the **same damage type don't stack** — only the highest damage is applied to each.

## Applying bleed

### With the `@Bleed` text button

`@Bleed` extends PF1's built-in text enrichers — the same system behind `@Damage`, `@Condition`, and the rest. Type `@Bleed[...]` into any description, journal, or chat message and it renders as a clickable button; the number or formula in the brackets is how much bleed it deals each round.

| You type | What it does |
| --- | --- |
| `@Bleed[1d6]` | 1d6 hit point bleed |
| `@Bleed[5]` | 5 hit point bleed |
| `@Bleed[@cl;type=con]` | Constitution **damage** bleed equal to caster level |
| `@Bleed[2;type=str;mode=drain]` | 2 Strength **drain** bleed |
| `@Bleed[1d4]{Open Wound}` | 1d4 hit point bleed, shown with a custom label |

Options after the formula (separated by `;`):

- **`type`** — `hp` (the default), or an ability: `str`, `dex`, `con`, `int`, `wis`, `cha`.
- **`mode`** — `damage` (the default) or `drain`. Only matters for ability bleed.

To apply it, **target** the creature(s) you want to bleed (or select their token) and click the button. Actor variables (such as `@abilities.str.mod`) are supported, using the source actor's values.

### By applying the condition

You can also bleed a creature without the enricher — just put the **bleed condition** on it the usual way (the token's status icons, the character sheet, etc.). A small dialog asks for the amount/formula and type, and that becomes the creature's bleed. Choose **Marker Only** to leave the condition inert, the same as vanilla bleed.

This prompt can be turned off under the module's **Prompt on manual bleed** setting (e.g. if you prefer to configure bleed only through the enricher or API).

### Determining bleed damage

Roll based bleed damage is re-rolled each round. If multiple overlapping bleed effects are on a character, the highest damage effect is applied (determined after the rolls are resolved).

## Seeing what's bleeding

When a creature has bleed on it, hover its **bleed condition** to see a list of every active bleed and how much each deals:

- On the **character sheet**, in the Buffs tab.
- On the **token's** status icons.
- Supports **Koboldworks – Little Helper's** buff display (optional) - includes the bleed effects in the tooltip.

## Stopping bleed

Just **remove the bleed condition** like any other — click it off on the token's status icons, the character sheet, or Little Helper's display. The stored bleed amounts are cleared right away, so if you apply bleed again later it starts fresh instead of piling onto the old wounds.

## Burning

Burning is a separate condition that deals **1d6 fire damage per round**. Unlike bleed, the amount is fixed — the knobs are the **Reflex save DC** (default **15**) to put the fire out, and a world setting to disable that save entirely.

### Applying burning

With the `@Burning` text button, the same way as `@Bleed`:

| You type | What it does |
| --- | --- |
| `@Burning` | Set on fire; Reflex DC 15 to put out |
| `@Burning[dc=18]` | Set on fire; Reflex DC 18 to put out |
| `@Burning{Immolate}` | Custom label |
| `@Burning[dc=20]{Immolate}` | Both |

**Target** (or select) the creature(s) and click the button. Catching fire deals its first 1d6 immediately. You can also just apply the **burning condition** by hand (token status icons, sheet, etc.) — that uses the default DC 15 and no initial burst.

### How a burning turn plays out

At the start of a burning creature's turn it gets a chance to put the fire out with a **Reflex save**:

- **Success** → the fire goes out, no damage that round.
- **Failure** → 1d6 fire damage, still burning.
- **Turn ends with no save rolled** → it takes the 1d6 automatically (treated as no attempt). Burning never stalls waiting on a click.

The save prompt comes in one of two forms, chosen automatically:

- **With PF1 Roll Requests installed** → a targeted save-request card the player rolls from.
- **Without it** → a self-contained card with a **Reflex Save** button the creature's owner clicks (the GM clicks it for NPCs).

Either way the result is applied by the GM's client, the same as bleed.

### Turning the save off

If you'd rather burning just deal its damage with no save, turn off the **Reflex save vs. burning** setting (world scope). With it disabled, no save card is posted — a burning creature simply takes its 1d6 fire damage at the end of each of its turns until you remove the burning condition.

### Coexisting with Nevela's Automation Suite

Nevela's Automation Suite also ships a `burning` condition (as a visual marker, with no damage automation). If it's active, this module **defers to Nevela's condition** and drives the damage/save automation on top of it — you won't get a duplicate. If Nevela isn't present, this module registers its own `burning` condition.

### Stopping burning

Remove the **burning condition** like any other, or let a successful Reflex save do it. The stored save DC is cleared right away.

## Good to know

- **A GM needs to be logged in** for bleed and burning to be dealt — the GM's client handles it behind the scenes to avoid issues with duplicate applications. Players can still apply either to a target, but the back-end processing is done via the GM client.
- Bleed **ignores damage reduction and resistances** and pulls from temporary hit points first.
- Ending bleed effects are still manual, there is no support yet for automated clearing of bleed effects via heal checks or hit point healing.
- Burning respects **fire immunity** (an immune creature won't burn or take burning damage), but its 1d6 does **not** currently subtract fire resistance — it's applied like bleed's flat damage.
- Burning ticks only **in combat** (it needs turn structure for the saves); a creature set on fire outside combat takes only the initial 1d6 until combat begins.


## API

If you want to apply or clear bleed from a macro or script, there's an API on `game.modules.get("pf1-bleed-effects").api` (also the global `pf1BleedEffects`):

```js
// Apply bleed to a token or actor
await pf1BleedEffects.apply(token, { formula: "1d6", kind: "hp" });
await pf1BleedEffects.apply(actor, { formula: "1", kind: "con.damage" });

// See what's on a creature
pf1BleedEffects.list(token);

// Remove one type, or all bleed
await pf1BleedEffects.clear(token, { kind: "hp" });
await pf1BleedEffects.clear(token);
```

`kind` is `"hp"` or `"<ability>.<damage|drain>"` (for example `"con.damage"` or `"str.drain"`).

### Burning API

Burning has its own namespace on the same module API (also the global `pf1BurningEffects`):

```js
// Set a token or actor on fire (default Reflex DC 15), or a custom DC
await pf1BurningEffects.apply(token);
await pf1BurningEffects.apply(actor, { dc: 20 });

// Check whether something is on fire
pf1BurningEffects.isBurning(token);

// Put the fire out
await pf1BurningEffects.clear(token);
```

The same functions are available under `game.modules.get("pf1-bleed-effects").api.burning`.

## Requirements

- Pathfinder 1e system, version 11 or newer
- Foundry VTT v13
