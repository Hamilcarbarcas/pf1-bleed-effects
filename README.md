# PF1 Bleed Effects

Adds automated, configurable damage-over-time to the Pathfinder 1e **bleed** and **burning** conditions, and lets any item carry recurring damage or healing of its own.

## What it does

- **[Damage over time on any item](#damage-over-time)** — a formula, a damage type and a timing, configured on the item's Advanced tab, applied to whoever carries it. Respects DR, energy resistance, hardness, immunity and vulnerability, and rolls animated dice.
- Adds an enricher to apply specific types and amounts of bleed damage.
- Prompts for an amount and type when the bleed condition is applied by hand.
- Adds a **burning** condition in two forms: catching fire (1d6 now and each round, a free Reflex save each turn) and configurable burns (damage, duration, DC). Fires stack, and a full-round Extinguish save puts out what it beats.
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
- **`deep`** — hit points of dedicated healing needed to close the wound. See [Deep Bleed](#deep-bleed); ignored unless that rule is switched on.

To apply it, **target** the creature(s) you want to bleed (or select their token) and click the button. Actor variables (such as `@abilities.str.mod`) are supported, using the source actor's values.

### By applying the condition

You can also bleed a creature without the enricher — just put the **bleed condition** on it the usual way (the token's status icons, the character sheet, etc.). A small dialog asks for the amount/formula and type, and that becomes the creature's bleed. Choose **Marker Only** to leave the condition inert, the same as vanilla bleed.

This prompt can be turned off under the module's **Prompt on manual bleed** setting (e.g. if you prefer to configure bleed only through the enricher or API). It never appears for bleed supplied by a buff — that has its own configuration, below.

### From a buff

A PF1 buff can list conditions under its **Conditions** field, and while the buff is active those conditions are on the creature. Put `Bleed` there and a **Bleed Damage** field appears beneath it on the buff sheet: an amount or formula, and whether it's hit points or ability damage/drain.

That's the whole configuration, because the buff already handles the rest — switch it on and the creature bleeds, switch it off (or let its duration run out) and the bleeding stops. This is the right shape for anything whose bleeding should last exactly as long as something else: a spell's duration, a lingering wound effect, a monster's grab.

Some things worth knowing:

- **Leave the field blank for an inert marker** — the vanilla behaviour of a bleed condition with no damage behind it.
- **The buff owns it.** Clicking the bleed condition off doesn't stop it; the buff re-supplies it. Switch the buff off.
- **It's never stored on the creature.** Nothing is written when the buff activates, so a buff's bleed can't be left behind and can't be cleared by `clear()`.
- **Formulas resolve against the buff, each round.** `@item.level` is the buff's level, so `1d6 + @item.level` scales as the buff does. Actor references such as `@abilities.str.mod` are the *bleeding creature's* — unlike `@Bleed`, there's no inflicting actor to read them from, so anything caster-derived has to be baked into the buff when it's handed out.
- It stacks with other bleed exactly as any two bleeds do: highest of each type per round.
- The bleed tooltips name the buff each effect came from.

#### Wounds that outlive the buff

The **Bleed Lasts** setting beneath the damage field chooses between the two:

- **While active** (the default) — everything above. The bleeding stops with the buff.
- **Persists after** — the buff inflicts the bleed *once*, when it activates, and that bleed stays when the buff is gone. Removing the cause isn't the same as closing the injury.

A persisting bleed is an ordinary stored bleed in every respect: it can be cleared, it counts against `clear()`, and — with the [Deep Bleed](#deep-bleed) rule on — it can carry a **Healing to Close** threshold. Its formula is locked against the buff at the moment it's inflicted rather than re-read each round, so a wound doesn't get worse because the buff later leveled up. Re-activating the same buff won't inflict a second wound while the first is still open.

Ticking **Blocks healing while active** on such a wound is the impaled case: an arrow still in the body, a parasite still burrowing. The wound can't be tended at all while that buff is on the creature — it appears in the healing allocation dialog greyed out, labelled with what's stopping it, and takes no healing until the buff is switched off or removed. That doesn't close it; it only makes it treatable. If the blocking buff is deleted, or vanishes for any other reason, the wound becomes healable rather than being left permanently stuck.

### Determining bleed damage

Roll based bleed damage is re-rolled each round. If multiple overlapping bleed effects are on a character, the highest damage effect is applied (determined after the rolls are resolved).

## Seeing what's bleeding

When a creature has bleed on it, hover its **bleed condition** to see a list of every active bleed and how much each deals:

- On the **character sheet**, in the Buffs tab.
- On the **token's** status icons.
- Supports **Koboldworks – Little Helper's** buff display (optional) - includes the bleed effects in the tooltip.

Bleed coming from a buff is labelled with the buff's name, since that's the one you can't stop by clicking the condition off.

## Stopping bleed

Just **remove the bleed condition** like any other — click it off on the token's status icons, the character sheet, or Little Helper's display. The stored bleed amounts are cleared right away, so if you apply bleed again later it starts fresh instead of piling onto the old wounds.

Two exceptions: a deep bleed, below, and bleed supplied by a buff, which ends when the buff does. Clicking the condition off with a bleeding buff still running clears everything else and leaves the buff's bleed going.

### Healing stops it

*"Bleed damage can be stopped with a DC 15 Heal check or through the application of any magical healing."*

**Restoring a bleeding creature's hit points ends its bleeding automatically** — a cure spell, a potion, channelled energy, the Apply Healing button on a chat card, another module's automation, any of it. A short chat card says so, and the condition comes off with the last effect. Controlled by the **Healing stops bleed** setting (world scope, on by default).

**Hand-edited hit points don't count.** Typing a number into the sheet's HP field, or into the token's health bar, leaves the bleeding exactly where it was. That's not a special case anyone had to guess at: every real healing effect in PF1 goes through the system's damage-application pipeline, and neither of those two do — the sheet writes the actor directly and the health bar has its own path. A GM correcting a number is book-keeping, not treatment.

Details worth knowing:

- **It stops all ordinary bleeding**, hit point and ability damage/drain alike. One cure spell, one clean creature.
- **Deep bleeds are unaffected**, which is the entire point of them — they close only through dedicated healing. See [Deep Bleed](#deep-bleed).
- **Bleed from a buff is unaffected**, for the same reason removing the condition doesn't stop it: the buff re-supplies it. Switch the buff off.
- **Healing that restores no hit points does nothing** — a creature already at full, or healing that only touches nonlethal damage. There has to be something to regain.

## Damage over time

Every item sheet has a **Damage Over Time** section on its **Advanced** tab. Add an instance and, while that item is live on a creature, it deals damage (or heals) on the turn boundary you choose. On an item with no instances the section is hidden: click **Show N more sections** at the foot of the tab to reveal it.

This is separate from bleed and burning in every respect — different storage, different engine, no interaction. A buff can carry all three.

### What "live" means

| Item | Ticks while |
| --- | --- |
| **Buff** | it's switched on |
| **Weapon, equipment, armor, loot** | it's equipped (and not destroyed, or buried in a container) |
| **Implant** | it's implanted |
| **Feat / feature** | it isn't disabled |
| **Anything else** | it's on the actor at all |

That's the system's own notion of an active item, so it matches what the rest of PF1 thinks. Note the last row is literal: a **spell** in a spellbook counts as present, so a DoT configured on a spell item ticks continuously. Put recurring effects on a buff, which is what buffs are for.

The damage always lands on the creature **carrying** the item. This is for cursed blades, burning armor, regeneration rings, parasites and poisons — not for hurting someone else.

### Configuring an instance

- **Name** — optional; only used to label the row on the chat card.
- **Formula** — anything PF1 can roll. Resolved against the *item*, so `@item.level` scales with a buff exactly as its other formulas do. A live preview shows the resolved value as you type.
- **Damage / Healing** — healing hides the type and bypass controls, since nothing resists healing.
- **Damage Type** — the system's own damage-type picker, the same one an action's damage parts use.
- **Counts As** — material and alignment penetration; only shown for physical damage. See below.
- **Ignores → Hardness** — skip the target's hardness entirely.
- **Every** — how often it fires: a number of rounds, minutes, hours or days. Defaults to every round. See [How often it fires](#how-often-it-fires).
- **Applies On** — turn start, turn end, or an initiative count.
- **Also when it goes live** — off by default; see [Ticking on activation](#ticking-on-activation).

Add as many instances as you like; each is configured and rolled independently. They're laid out as **tabs** — one per instance, plus a **+** to add another — the same as astora-mod's Buff Delivery section, so the two behave alike where they sit together on the Advanced tab. A tab is captioned by the instance's name (or *Instance 1*, *Instance 2*… until you give it one) and updates as you type. Untick **Enable** to park an instance without deleting it; its tab goes italic and greyed, and it stops firing.

### Damage reduction, resistance and hardness

Damage is run through the target's **damage reduction, energy resistance, hardness, damage immunity and vulnerability**, using PF1's own apply-damage machinery — the same code behind the dialog you get when you shift-click a damage card. What the dialog would have worked out is what gets applied.

The catch is that a damage-over-time effect has no weapon behind it, so it's material-less and non-magic. Left alone, **DR 5/magic absorbs a 1d6 slashing tick entirely**. The **Counts As** chips fix that:

- **Magic**, **cold iron**, **alchemical silver**, **adamantine**, **nexavaran steel**, **epic**
- **Lawful**, **chaotic**, **good**, **evil**

Tick whichever the effect should be treated as, and reduction that those overcome no longer applies. Adamantine also ignores hardness of 20 or less, exactly as it does for a weapon.

**Counts As only appears when a physical damage type is selected**, because damage reduction in PF1 is exclusively a physical-damage mechanic — even DR/— leaves an acid tick untouched. On an energy or untyped instance the chips would be dead controls, so they're hidden, and any that were already ticked stop counting (they come back if you switch the type back to something physical).

**Ignores → Hardness** is separate, and available on every damage instance. Hardness isn't like DR: objects and constructs reduce damage of *any* type by it, energy included, so an acid DoT against a construct meets hardness and sometimes needs a way past.

Two more things worth knowing:

- **Untyped damage bypasses everything.** Leave the damage type blank and the instance is untyped, which PF1 subjects to no DR, no energy resistance and no hardness. That's the escape hatch for effects that simply shouldn't be defended against.
- **Vulnerability is applied automatically** (+50%, rounded down). PF1's own dialog leaves that box unticked and waits for a human to notice; a tick has no human to ask.

Damage typed as **nonlethal** is applied as nonlethal damage.

### How often it fires

**Every** sets the interval: a count, and a unit of **rounds**, **minutes**, **hours** or **days**. Left alone it's every round, which is what every instance did before this existed.

The count takes a formula, so `@item.level` scales a schedule the way it scales damage, and a live preview shows the resolved value as you type. Dice aren't supported — a schedule that rerolls its own spacing isn't a useful thing — and anything unusable falls back to one round rather than leaving the instance unable to fire at all.

**The interval and Applies On are different questions.** The interval picks *which* round fires; Applies On picks *where in that round*. "Every 1 minute, at turn end" is the carrier's turn end, once every ten rounds.

**It counts from when the effect started.** A buff records the moment it was switched on, so an hourly tick on a buff switched on at 12:20 fires at 13:20. Items that record nothing — an equipped weapon, a feat — count from the world clock instead, so theirs land on the hour. Either way the first tick is a full interval in, not immediately; **Also when it goes live** is there for an opening hit.

**Long intervals need the clock to move, not the initiative tracker.** An hour is 600 rounds and a day is 14,400, so neither will ever come round in a real fight. They resolve when time passes outside combat — see [Passing time](#passing-time) — which needs **astora-mod** installed. Rounds and short minute intervals work in combat as you'd expect.

### When it fires

- **Turn start** — as the carrier's turn begins.
- **Turn end** — as the carrier's turn ends.
- **Initiative count** — once per round, at the point in the initiative order the buff was *switched on* at. PF1 already stamps that count onto a buff's effect for duration purposes, and this reads the same one.

**Initiative falls back to turn start** wherever there's no count to use — an equipped weapon, a feature, or a buff switched on outside combat, none of which have one. Rather than never firing, it behaves as turn start for that carrier.

Ticks need turn structure, so **nothing fires outside combat**. An item configured with a DoT sits dormant until a combat is running, the same as burning.

### Ticking on activation

**Also when it goes live** deals one immediate tick the moment the buff is switched on, the item equipped, or the item added to the actor — for effects that should bite on contact rather than waiting for the next boundary. It's off by default so that switching a buff on during the carrier's own turn doesn't hit twice.

Unlike the scheduled timings, this one **works out of combat**: it's an event rather than a schedule, and dropping it because no combat is running would just lose it.

### Several instances at once

Everything on one item sharing a timing is applied as a **single** damage application, so the target's DR is consumed once across all of it — the way an attack's several damage parts share a target's DR, not once per instance. Instances split apart only where they can't share: damage versus healing, lethal versus nonlethal, and differing **Counts As** sets.

Different items never share. Two items each dealing 1d6 are two separate applications, and each meets the target's DR in full.

### What you see

One chat card per creature per tick, listing each instance with its formula and roll, then what actually landed:

> **Kobold Sorcerer**
> *Acid Blood* — 1d6 — **4** — acid
> Takes 2 damage. *(2 resisted)*

The mitigation aside spells out immunity, DR, resistance, hardness and vulnerability, so a reduced number never looks like a miscalculation. One card rather than one per instance keeps the chat log manageable — a bloated log is a real source of UI lag.

The dice are real rolls animated through **Dice So Nice**, coloured by damage type wherever DSN is configured for it.

The card is public by default. Turn on **Owners-only chat cards** to whisper it to the creature's owners and the GM instead (see [Good to know](#good-to-know)).

### API

```js
// What's configured on an item
pf1DamageOverTime.list(item);

// Is it live on its actor right now?
pf1DamageOverTime.isLive(item);

// What each instance is scheduled to do: interval in rounds, what it counts from,
// when it next comes due, and whether it's due in this round
pf1DamageOverTime.schedule(item);

// Fire a timing on demand, without waiting for the turn to come round.
// The interval is ignored, so a daily instance resolves immediately
await pf1DamageOverTime.trigger(token, "turnEnd");
```

Also available at `game.modules.get("pf1-bleed-effects").api.dot`.

## Astora Homebrew rules

One setting, **off by default**, enables everything in this module that isn't RAW. Right now that means Deep Bleed, below; anything non-RAW added later sits behind the same switch. [pf1-critical-effects](https://github.com/Hamilcarbarcas/pf1-critical-effects) carries an identically-named setting for its own house rules, and the two are meant to be set together.

### Deep Bleed

**Also requires pf1-critical-effects, with its own Astora Homebrew setting on** — that module supplies the dedicated-healing allocation dialog this rule is built on. With it missing or its switch off, no deep bleeds are inflicted (you'll get a warning if only one of the two switches is on) and everything else here is unaffected.

A wound too deep to close on its own. Removing the bleed condition **does not stop it**; it closes only once a set number of hit points of **dedicated healing** have been spent on it — healing that would otherwise have gone to the character's own hit points.

Switch on **Astora Homebrew rules** in both modules, then give any bleed a threshold:

- `@Bleed[2d6;deep=20]` in a description or journal
- the **Healing to Close** field in the manual-application dialog
- `deepRequired` on the API

Once a creature has a deep bleed, any healing that lands on it opens pf1-critical-effects' **healing allocation dialog**, where you split the incoming hit points between the character's own HP and each open wound. Pour in enough and the wound closes and the bleed stops. The healing you spend that way does *not* heal hit points — that's the cost.

Some things worth knowing:

- **There's no Heal check.** Unlike the injury buffs dedicated healing was built for, a deep bleed is ready to absorb healing the moment it's inflicted. Nothing needs to be treated first.
- **Each deep bleed is its own wound.** Two of them means two thresholds, paid separately, listed as two rows in the allocation dialog. Note that the tick engine still applies only the highest roll of each type per round — so two deep hit point bleeds cost double to close while dealing the damage of one.
- **Clicking the condition off doesn't take.** The condition comes straight back and you get a notice saying how much healing is still owed. A GM who needs one gone regardless can force it: `pf1BleedEffects.clear(token, { force: true })`.
- **A wound can be blocked from healing** while something is still in it — see [Wounds that outlive the buff](#wounds-that-outlive-the-buff). It sits in the allocation dialog greyed out, with the reason, until the cause is gone.
- **Ordinary bleeds on the same creature clear normally.** Removing the condition drops those and keeps the deep ones.
- **Turning the homebrew setting back off** — in either module — stops new deep bleeds from being created but leaves existing ones payable, so nobody ends up with a wound that can't be closed.

## Burning

Burning is a separate condition that deals fire damage at the **end of the burning creature's turn**. It comes in two forms, and what you configure decides which one you get.

| | **Catching fire** | **A burn** |
| --- | --- | --- |
| What it models | Clothes or hair alight (the core rules) | A monster's Burn ability, a spell, a special attack |
| Damage | 1d6 fire | whatever you configure (default 1d6) |
| When it lands | 1d6 **immediately**, then each round | each round only |
| Free save | DC 15 Reflex at the start of each turn | none |
| Extinguish (full-round) | Reflex +4 vs. DC 15 | Reflex +4 vs. its DC |
| Lasts | until put out | a number of rounds, or until put out |

**No configuration means catching fire.** That covers applying the condition by hand (token status icons, the sheet), a bare `@Burning`, the API with no options, and anything else that just switches the condition on. Giving any of damage, duration, or DC makes it a burn.

### Applying burning

With the `@Burning` text button, the same way as `@Bleed`:

| You type | What it does |
| --- | --- |
| `@Burning` | Catching fire |
| `@Burning[damage=2d6;duration=1d4;dc=17]` | A burn: 2d6 fire a round for 1d4 rounds, DC 17 to put out |
| `@Burning[dc=18]` | A burn: 1d6 fire a round until put out, DC 18 |
| `@Burning[duration=0]` | A burn with every default: 1d6, DC 15, until put out |
| `@Burning{Immolate}` | Custom label |

Options (separated by `;`), any of which makes it a burn:

- **`damage`**: fire damage each round. Defaults to 1d6. `@` values lock to whoever posted the card, and dice roll fresh each round.
- **`duration`**: how many rounds it burns. A number, or dice rolled once when it lands. `0` or leaving it out means until put out.
- **`dc`**: the Reflex DC to put it out. Defaults to 15.

**Target** (or select) the creature(s) and click the button.

The condition's right-click duration on the actor sheet does nothing for burning: each burn carries its own duration, and a timer on the condition would end all of them at once.

### How a burning turn plays out

At the **start** of the burning creature's turn a card lists what's burning it, with an **Extinguish** button.

- **Catching fire gets a free save.** A DC 15 Reflex save, through a PF1 Roll Requests card when that module is installed, otherwise a **Reflex Save** button on the same card. Success puts that fire out.
- **Extinguish** is the creature dropping and rolling, or smothering the flames: a **full-round action**, Reflex at **+4**. It's a normal Reflex save, with the roll dialog (even for a GM rolling an NPC), the system's chat card and the dice. Usable once per turn, on the creature's own turn. It's a burn's only way out before its time runs down.
- **The save doesn't put anything out by itself.** A card follows it, listing which fires the roll beats and which still burn, with a **Put out** button. Click it to remove them, or don't if the GM rules otherwise.

At the **end** of the turn, whatever was burning at the start of it and is still burning deals its damage. A free save nobody rolled counts as failed, so burning never stalls waiting on a click. A fire that lands partway through a turn first burns at the end of the creature's next turn.

With **astora-mod's Action Tracker**, Extinguish asks before going ahead if the creature's full-round action is already gone, and marks the move and standard slots spent once the roll lands.

Outside combat, Extinguish works whenever it's clicked. It's also on the card posted when the creature is set alight.

### Stacking

Burning stacks like bleed: every fire stays on the creature, under one burning condition. Hover the condition (sheet or token HUD) to see them all.

- **Only the fiercest deals damage each round.** Among the rolled fires, the one with the highest average is rolled; if a fixed amount (say a flat 5) is higher than that roll, the fixed amount is used instead.
- **A save puts out only what it beats.** An Extinguish roll of 18 puts out a DC 15 and a DC 17, and leaves a DC 20 burning. To be rid of it entirely, beat the highest DC. A natural 20 puts out everything; a natural 1, nothing. The free save only ever puts out the caught fire.
- **Each burn counts its own rounds**, losing one at the end of each of the creature's turns.
- **Catching fire again** always deals its 1d6 immediately, but there's only ever one caught fire on a creature, so it doesn't double the damage or the saves afterward.

### Burning from a buff

Put `Burning` in a buff's Conditions list and the buff becomes a burn whose lifetime is the buff's own. This is for fire that only ends when the effect does, such as a spell whose flames can't be put out.

A **Burning Damage** field appears beneath the Conditions list once `Burning` is in it. Leave it blank for 1d6. The formula is resolved against the buff each round, so `@item.level` scales with it.

A buff's burn deals nothing when it switches on, offers no save, and Extinguish leaves it alone. **To end it, switch off (or delete) the buff.** If a fire should be put out by the usual means, apply it with `@Burning`, the API, or astora-mod's Buff Delivery instead of tying it to a buff.

### Fire resistance and vulnerability

Burning damage is run through the target's fire defenses:

- **Immune to fire**: it can't be set alight at all. The condition isn't applied and a chat card says so.
- **Fire resistance**: subtracted from each round's damage. Resistances of the same type don't stack, so the **highest** applicable resistance is used, not the sum. Resistance that soaks the whole roll leaves the creature burning but unharmed; resisting flames isn't the same as putting them out.
- **Vulnerable to fire**: the damage is increased by 50% (rounded down), then resistance is subtracted from that.

The chat card shows what happened, for example *"takes 4 fire damage"* followed by *"(vulnerable to fire; 5 resisted)"*, so a reduced number never looks like a miscalculation.

This reads the **Energy Resistance**, **Damage Immunity**, and **Damage Vulnerability** fields on the actor's Combat tab. PF1 doesn't roll resistance up from equipment automatically, so a ring of fire resistance only counts if it's reflected in the actor's own Energy Resistance entries. Free-text resistance entries aren't parsed, only the structured ones with a real damage type selected.

To apply burning flat instead, turn off the **Burning respects fire resistance** setting (world scope). Fire immunity is honored either way.

### Coexisting with Nevela's Automation Suite

Nevela's Automation Suite also ships a `burning` condition (as a visual marker, with no damage automation). If it's active, this module **defers to Nevela's condition** and drives the damage and saves on top of it, so you won't get a duplicate. If Nevela isn't present, this module registers its own `burning` condition.

### Stopping burning

Saves and running out of rounds put fires out one by one. Removing the **burning condition** by hand puts out every fire at once, except one supplied by a buff: switch the **buff** off for that.

## Passing time

Every engine here runs on the combat tracker, so outside combat none of them
tick. With **astora-mod** installed, advancing the world clock — Simple Calendar,
the core time controls, the Rest Manager — resolves **bleed** and **damage over
time** and **burning** across the elapsed rounds instead of skipping them.

- **A warning first.** Any actor with a live instance is listed before the clock
  moves, showing what it takes, what it heals, the components those came from,
  the final hit points, and the round it drops below 0 if it does. The advance
  blocks until answered, and cancelling moves nothing.
- **The preview is the result.** What the dialog shows is what gets applied —
  nothing is re-rolled afterwards.
- **Healing alone never raises the dialog.** It is listed when the dialog is open
  for some other reason, but fast healing topping someone up won't interrupt you.
- **Reduction is per round**, matching what those rounds would have done in
  combat, so DR 5 blunts each tick rather than the total.
- **Instances stop when their buff would have expired**, not when the advance
  ends, so a 2-minute effect over a 10-minute jump ticks for 2 minutes. Bleed has
  no duration, so it runs until the creature drops or the advance ends — which is
  usually the point of the warning.
- **Bleed keeps its own rules** across a jump: highest result per kind each round,
  no damage reduction, temporary hit points first. Ability damage and drain are
  totalled and reported, and applied in one write.
- **Long intervals are resolved properly.** The simulation steps from one tick to
  the next rather than round by round, so an instance set to fire once a day gets
  its seven ticks across a week instead of running out of simulation budget
  inside the first half hour. Anything firing every round behaves exactly as it
  did before.
- One `applyDamage` per instance and a single GM-only card for the whole advance,
  however many rounds elapsed.

**Burning is simulated as a creature with nothing better to do would play it.**
Each round it makes its free save if it caught fire, then spends the round on
Extinguish (Reflex +4) against whatever a save can put out, then takes the
round's damage from what's left, and burns count down. Those saves are rolled
without the roll dialog, from the creature's Reflex total, so situational bonuses
the dialog would offer aren't counted. The warning shows the fire damage and the
round the flames went out, or that they were still burning. Fire from a buff
burns until the buff would have expired.

## Good to know

- **Chat cards can be kept to the creature's owners.** Turn on **Owners-only chat cards** (world scope, off by default) and every bleed, burning, and damage over time card, including the burning Reflex save card, is whispered to the creature's owners and the GM. Everyone else sees no card, and no dice unless Dice So Nice's ghost dice are on. A creature with no player owner shows its cards to the GM only.
- **A GM needs to be logged in** for bleed and burning to be dealt — the GM's client handles it behind the scenes to avoid issues with duplicate applications. Players can still apply either to a target, but the back-end processing is done via the GM client.
- Bleed **ignores damage reduction and resistances** and pulls from temporary hit points first.
- **Healing hit points now ends ordinary bleeding automatically** (see [Healing stops it](#healing-stops-it)). The DC 15 Heal check half of the rule is still manual.
- Burning respects **fire immunity, resistance, and vulnerability** (see above). Both bleed and burning pull from temporary hit points first.
- Burning ticks only **in combat** (it needs turn structure for the saves); outside combat a creature set on fire takes only what lands immediately until combat begins or the clock is advanced (see [Passing time](#passing-time)).
- **Damage over time is the one that respects everything** — DR, energy resistance, hardness, immunity and vulnerability — because it goes through PF1's own damage pipeline rather than applying a flat number. If you want a recurring effect that a monster's DR can actually blunt, that's the one to reach for; bleed deliberately ignores all of it.
- **Nevela's Automation Suite composes with damage over time automatically.** Temporary hit point pools, damage absorption, fortification and on-struck reactive triggers all apply to these ticks, with no configuration on either side.
- **Astora's grouped initiative is understood.** When summons or companions share their leader's turn, each member bleeds, burns and takes damage over time at the start of the group's turn. A turn-end tick, or an unrolled burning save, lands when the group's turn ends, not while the group's turn is still starting. Nothing changes without astora-mod.


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

// ...that can't be tended until the arrow (a buff on the same actor) comes out
await pf1BleedEffects.apply(token, { formula: "2d6", deepRequired: 20, blockedBy: arrowBuff });

// Remove deep bleeds too, which every other clear leaves alone
await pf1BleedEffects.clear(token, { force: true });
```

`kind` is `"hp"` or `"<ability>.<damage|drain>"` (for example `"con.damage"` or `"str.drain"`).

`deepRequired` is ignored unless **Astora Homebrew rules** is on in both this module and pf1-critical-effects. `list()` and `describe()` report an effect's progress on its `deep` property (`{ required, received, remaining }`, or `null`/absent for an ordinary bleed).

`blockedBy` takes an `Item` on the same actor (or its id/uuid) and is only meaningful alongside `deepRequired`: while that item is present *and active*, the wound accepts no dedicated healing and is listed as blocked in the allocation dialog. `describe()` reports the blocker's name on `blockedBy`, or `null`.

`list()` and `describe()` include bleed supplied by buffs — those carry the buff on `source` (the `Item` from `list()`, its name from `describe()`) and cannot be removed by `clear()`. `listStored()` returns only what `clear()` can actually act on.

### Burning API

Burning has its own namespace on the same module API (also the global `pf1BurningEffects`):

```js
// Catching fire: 1d6 now, a free DC 15 save each turn
await pf1BurningEffects.apply(token);

// A burn: 2d6 a round for 1d4 rounds, DC 17 to put out
await pf1BurningEffects.apply(actor, { formula: "2d6", duration: "1d4", dc: 17 });

// A burn until put out
await pf1BurningEffects.apply(token, { formula: "3d6", duration: 0, dc: 20 });

// What's burning, and whether anything is
pf1BurningEffects.describe(token);
pf1BurningEffects.isBurning(token);

// Put every fire out (a buff's fire ends only with the buff)
await pf1BurningEffects.clear(token);
```

Passing any of `formula`, `dc` or `duration` makes it a burn; the others default to 1d6, DC 15, and until put out. `duration` is rounds, a number or a dice formula rolled once; `0` is until put out. `sourceRollData` locks `@` values in the formula to a source, as with bleed.

The same functions are available under `game.modules.get("pf1-bleed-effects").api.burning`.

## Requirements

- Pathfinder 1e system, version 11 or newer
- Foundry VTT v13

Optional:

- **[pf1-critical-effects](https://github.com/Hamilcarbarcas/pf1-critical-effects)** — supplies the dedicated-healing allocation dialog the **Deep Bleed** homebrew rule is built on, and carries the matching **Astora Homebrew rules** setting. Without it (or with its homebrew off) deep bleed isn't implemented; everything else is unaffected. (That module recommends this one in turn: much of its critical and fumble content inflicts bleed.)
- **Koboldworks – Little Helper** — bleed details are added to its buff-display tooltips.
