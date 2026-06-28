# PF1 Bleed Effects

Adds automated, configurable bleed damage to the Pathfinder 1e **bleed** condition.

## What it does

- Adds an enricher to apply specific types and amounts of bleed damage.
- Prompts for an amount and type when the bleed condition is applied by hand.
- An API function to apply bleed via scripts/macros.
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

## Good to know

- **A GM needs to be logged in** for bleed to be dealt — the GM's client handles it behind the scenes to avoid issues with duplicate applications. Players can still apply bleed to a target, but the back-end processing is done via the GM client.
- Bleed **ignores damage reduction and resistances** and pulls from temporary hit points first.
- Ending bleed effects are still manual, there is no support yet for automated clearing of bleed effects via heal checks or hit point healing.


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

## Requirements

- Pathfinder 1e system, version 11 or newer
- Foundry VTT v13
