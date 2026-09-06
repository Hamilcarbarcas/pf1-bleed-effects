# README Edits — pending review

Log of changes to user-facing docs and to setting hint/tooltip prose. Delete an
entry once reviewed. Never rewritten wholesale — new entries append at the end.

---

## 2026-09-05 — Time jump support

### `README.md` — new "Passing time" section

Inserted between "Stopping burning" and "Good to know". Whole section is new.
Covers: that every engine runs on the combat tracker so nothing ticks outside
combat; that with astora-mod installed, advancing the world clock resolves damage
over time across the elapsed rounds; the blocking warning and what it lists; that
the preview is what gets applied; that healing alone never raises the dialog;
per-round reduction; instances stopping at their buff's expiry rather than at the
end of the advance; and one `applyDamage` per instance with a single GM-only
card. Ends with why burning is deliberately not simulated (the Reflex save puts
the fire out, so rolling it unattended decides how long the creature burned).

### `README.md` — "Good to know" bullet

Before:

> - Burning ticks only **in combat** (it needs turn structure for the saves); a creature set on fire outside combat takes only the initial 1d6 until combat begins.

After:

> - Burning ticks only **in combat** (it needs turn structure for the saves); a creature set on fire outside combat takes only the initial 1d6 until combat begins, and advancing the clock will warn rather than resolve it (see [Passing time](#passing-time)).

### `lang/en.json` — 11 new keys

All new, no existing text changed. `BLD.TimeJump.*`: the burning blocker's text
and detail, and the pieces of the summary line (heading, "takes {n}", "heals
{n}", the "{parts} over {rounds} rounds — {hp}/{max}" frame, the death-round and
truncated-walk suffixes, and the healing / damage / reduced component labels).

---

## 2026-09-05 — Bleed included in time jumps

### `README.md` — "Passing time" opening

Before:

> ...advancing the world clock — Simple Calendar, the core time controls, the Rest Manager — resolves damage over time across the elapsed rounds instead of skipping it.

After:

> ...advancing the world clock — Simple Calendar, the core time controls, the Rest Manager — resolves **bleed** and **damage over time** across the elapsed rounds instead of skipping them.

### `README.md` — "Passing time" bullet on durations

Before:

> - **Instances stop when their buff would have expired**, not when the advance ends, so a 2-minute effect over a 10-minute jump ticks for 2 minutes.

After (bullet extended, and one new bullet added after it):

> - **Instances stop when their buff would have expired**, not when the advance ends, so a 2-minute effect over a 10-minute jump ticks for 2 minutes. Bleed has no duration, so it runs until the creature drops or the advance ends — which is usually the point of the warning.
> - **Bleed keeps its own rules** across a jump: highest result per kind each round, no damage reduction, temporary hit points first. Ability damage and drain are totalled and reported, and applied in one write.

### `lang/en.json` — 1 new key

`BLD.TimeJump.Bleed` — "bleed: {n} {kind}", the component line for bleed in the
warning dialog and the summary card.

---

## 2026-09-05 — Warning line punctuation

### `lang/en.json` — `BLD.TimeJump.Over`

Before:

> `{parts} over {rounds} rounds — {hp}/{max}.`

After:

> `{parts} over {rounds} rounds: {hp}/{max}.`

An actor driven below zero renders its hit points with a leading minus, so the em
dash landed directly against it ("rounds — -12/74"). A colon reads cleanly either
way, and negative hit points are the case the warning exists for.
