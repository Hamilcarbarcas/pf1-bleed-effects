# PF1 Bleed Effects

Adds automated, configurable damage-over-time to the Pathfinder 1e **bleed** and **burning** conditions.

## What it does

- Adds an enricher to apply specific types and amounts of bleed damage.
- Prompts for an amount and type when the bleed condition is applied by hand.
- Adds a **burning** condition (1d6 fire/round) with a turn-start Reflex save to put it out, or no save at all.
- Burning damage respects the target's fire immunity, resistance, and vulnerability.
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
| `@Bleed[2d6;deep=20]` | 2d6 **deep** bleed — 20 HP of dedicated healing closes it |
| `@Bleed[1d4]{Open Wound}` | 1d4 hit point bleed, shown with a custom label |

Options after the formula (separated by `;`):

- **`type`** — `hp` (the default), or an ability: `str`, `dex`, `con`, `int`, `wis`, `cha`.
- **`mode`** — `damage` (the default) or `drain`. Only matters for ability bleed.
- **`deep`** — hit points of dedicated healing needed to close the wound. See [Deep Bleed](#deep-bleed-homebrew); ignored unless that rule is switched on.

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

The one exception is a deep bleed, below.

## Deep Bleed (homebrew)

**Off by default. Requires [pf1-critical-effects](https://github.com/Hamilcarbarcas/pf1-critical-effects)** — when that module isn't active, the setting doesn't appear and none of this exists.

A wound too deep to close on its own. Removing the bleed condition **does not stop it**; it closes only once a set number of hit points of **dedicated healing** have been spent on it — healing that would otherwise have gone to the character's own hit points.

Switch it on under the module's **Deep Bleed (homebrew)** setting, then give any bleed a threshold:

- `@Bleed[2d6;deep=20]` in a description or journal
- the **Healing to Close** field in the manual-application dialog
- `deepRequired` on the API

Once a creature has a deep bleed, any healing that lands on it opens pf1-critical-effects' **healing allocation dialog**, where you split the incoming hit points between the character's own HP and each open wound. Pour in enough and the wound closes and the bleed stops. The healing you spend that way does *not* heal hit points — that's the cost.

Some things worth knowing:

- **There's no Heal check.** Unlike the injury buffs dedicated healing was built for, a deep bleed is ready to absorb healing the moment it's inflicted. Nothing needs to be treated first.
- **Each deep bleed is its own wound.** Two of them means two thresholds, paid separately, listed as two rows in the allocation dialog. Note that the tick engine still applies only the highest roll of each type per round — so two deep hit point bleeds cost double to close while dealing the damage of one.
- **Clicking the condition off doesn't take.** The condition comes straight back and you get a notice saying how much healing is still owed. A GM who needs one gone regardless can force it: `pf1BleedEffects.clear(token, { force: true })`.
- **Ordinary bleeds on the same creature clear normally.** Removing the condition drops those and keeps the deep ones.
- **Turning the setting back off** stops new deep bleeds from being created but leaves existing ones payable, so nobody ends up with a wound that can't be closed.

## Burning

Burning is a separate condition that deals **1d6 fire damage per round**. Unlike bleed, the amount is fixed — the knobs are the **Reflex save DC** (default **15**) to put the fire out, and whether there's a save at all.

### Applying burning

With the `@Burning` text button, the same way as `@Bleed`:

| You type | What it does |
| --- | --- |
| `@Burning` | Set on fire; Reflex DC 15 to put out |
| `@Burning[dc=18]` | Set on fire; Reflex DC 18 to put out |
| `@Burning[nosave]` | Set on fire with **no save** to put it out |
| `@Burning{Immolate}` | Custom label |
| `@Burning[dc=20]{Immolate}` | Both |

Options after the brackets (separated by `;`):

- **`dc`** — the Reflex DC to put the fire out. Defaults to 15.
- **`nosave`** — this burning offers no save. `save=false` does the same thing; a `dc` given alongside it is ignored.

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

Two ways, depending on how broadly you want it:

- **Per burning** — apply it with `@Burning[nosave]`, or `{ save: false }` from the API. Only that fire is inescapable; everything else still gets its save.
- **Everywhere** — turn off the **Reflex save vs. burning** setting (world scope). This is a master switch: while it's off, *no* burning prompts a save, even one applied without `nosave`.

Either way the outcome is the same as a save that never got rolled: no save card is posted, and the creature simply takes its 1d6 fire damage at the end of each of its turns until you remove the burning condition.

### Burning from a buff

You can also drive burning from a **buff** — put `Burning` in the buff's Conditions list, and the damage automation picks it up like any other burning. This is a good fit when something else should govern how long the fire lasts (a spell's duration, a lingering effect), because the buff's own duration ends the burning.

Burning supplied this way is always **saveless**, regardless of the DC or the save setting: it deals its 1d6 at the end of each of the creature's turns and ends when the buff does.

That isn't a stylistic choice. A buff puts its condition on an Active Effect attached to the *item*, and PF1 can only remove condition effects that sit directly on the actor — so a save that "put the fire out" wouldn't actually remove anything, and the creature would be told it was safe while still burning. Rather than offer a save it can't honour, the module doesn't offer one. **To put out a buff-driven fire, switch off (or delete) the buff.**

### Fire resistance and vulnerability

Burning damage is run through the target's fire defences:

- **Immune to fire** → it can't be set alight at all. The condition isn't applied and a chat card says so.
- **Fire resistance** → subtracted from each 1d6. Resistances of the same type don't stack, so the **highest** applicable resistance is used, not the sum. Resistance that soaks the whole roll leaves the creature burning but unharmed — resisting flames isn't the same as putting them out.
- **Vulnerable to fire** → the 1d6 is increased by 50% (rounded down), then resistance is subtracted from that.

The chat card shows what happened — e.g. *"takes 4 fire damage"* followed by *"(vulnerable to fire; 5 resisted)"* — so a reduced number never looks like a miscalculation.

This reads the **Energy Resistance**, **Damage Immunity**, and **Damage Vulnerability** fields on the actor's Combat tab. Note that PF1 doesn't roll resistance up from equipment automatically, so a ring of fire resistance only counts if it's reflected in the actor's own Energy Resistance entries. Free-text resistance entries aren't parsed — only the structured ones with a real damage type selected.

To go back to flat, bleed-style application, turn off the **Burning respects fire resistance** setting (world scope). Fire immunity is honoured either way.

### Coexisting with Nevela's Automation Suite

Nevela's Automation Suite also ships a `burning` condition (as a visual marker, with no damage automation). If it's active, this module **defers to Nevela's condition** and drives the damage/save automation on top of it — you won't get a duplicate. If Nevela isn't present, this module registers its own `burning` condition.

### Stopping burning

Remove the **burning condition** like any other, or let a successful Reflex save do it. The stored save DC is cleared right away. If the burning came from a buff, switch the **buff** off instead — clearing the condition alone won't stick, since the buff just re-supplies it.

## Good to know

- **A GM needs to be logged in** for bleed and burning to be dealt — the GM's client handles it behind the scenes to avoid issues with duplicate applications. Players can still apply either to a target, but the back-end processing is done via the GM client.
- Bleed **ignores damage reduction and resistances** and pulls from temporary hit points first.
- Ending bleed effects are still manual, there is no support yet for automated clearing of bleed effects via heal checks or hit point healing.
- Burning respects **fire immunity, resistance, and vulnerability** (see above). Both bleed and burning pull from temporary hit points first.
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

// Deep Bleed: 20 HP of dedicated healing to close it
await pf1BleedEffects.apply(token, { formula: "2d6", deepRequired: 20 });

// Remove deep bleeds too, which every other clear leaves alone
await pf1BleedEffects.clear(token, { force: true });
```

`kind` is `"hp"` or `"<ability>.<damage|drain>"` (for example `"con.damage"` or `"str.drain"`).

`deepRequired` is ignored unless the **Deep Bleed** setting is on and pf1-critical-effects is active. `list()` and `describe()` report an effect's progress on its `deep` property (`{ required, received, remaining }`, or `null`/absent for an ordinary bleed).

### Burning API

Burning has its own namespace on the same module API (also the global `pf1BurningEffects`):

```js
// Set a token or actor on fire (default Reflex DC 15), or a custom DC
await pf1BurningEffects.apply(token);
await pf1BurningEffects.apply(actor, { dc: 20 });

// No save — 1d6 fire at the end of each of its turns until the condition is removed
await pf1BurningEffects.apply(token, { save: false });

// Check whether something is on fire
pf1BurningEffects.isBurning(token);

// Put the fire out
await pf1BurningEffects.clear(token);
```

`save` defaults to `true`; `dc` is ignored when it's `false`. The **Reflex save vs. burning** world setting still overrides `save: true` when that setting is off.

The same functions are available under `game.modules.get("pf1-bleed-effects").api.burning`.

## Requirements

- Pathfinder 1e system, version 11 or newer
- Foundry VTT v13

Optional:

- **[pf1-critical-effects](https://github.com/Hamilcarbarcas/pf1-critical-effects)** — supplies the dedicated-healing allocation dialog the **Deep Bleed** homebrew rule is built on. Without it that setting is hidden and deep bleed isn't implemented; everything else is unaffected. (That module recommends this one in turn: much of its critical and fumble content inflicts bleed.)
- **Koboldworks – Little Helper** — bleed details are added to its buff-display tooltips.
