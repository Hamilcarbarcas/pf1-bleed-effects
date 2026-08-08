# Changelog

<!--
  Release process: before tagging v<x.y.z>, rename the "Unreleased" heading
  below to "## [<x.y.z>] - <YYYY-MM-DD>". The release workflow extracts the
  section whose heading matches the pushed tag and uses it as the GitHub
  release body. If no matching section exists, the release fails.
-->

## [Unreleased]

### Added
- **Deep Bleed** (homebrew, off by default, requires **pf1-critical-effects**). A bleed can be inflicted as a deep wound: removing the bleed condition does not stop it, and it closes only once a set number of hit points of *dedicated healing* have been spent on it — healing that would otherwise have gone to the character's hit points. Set the threshold with `@Bleed[2d6;deep=20]`, the **Healing to Close** field in the manual-application dialog, or `deepRequired` on the API.
  - Implemented as a **provider** registered with pf1-critical-effects' dedicated-healing system, so a bleed (which lives in an actor flag, not an item) sits in the same allocation dialog as a broken arm. Neither module knows anything about the other's storage.
  - **No Heal check.** Unlike the injury buffs dedicated healing was built for, a deep bleed absorbs healing from the moment it is inflicted, so it needs no treatment step and no entry point to trigger one.
  - **Each deep bleed is its own wound** — separate threshold, separate running total, separate row in the allocation dialog. The tick engine still applies only the highest roll of each kind per round, so two deep hit point bleeds cost double to close while dealing the damage of one.
  - Clicking the condition off no longer takes: it is re-marked and a notice reports the healing still owed. `clear(ref, { force: true })` is the GM override. Ordinary bleeds on the same creature still clear normally.
  - The outstanding amount is shown on **every** bleed tooltip surface — the sheet's Buffs tab, the token HUD, and Little Helper's active-buff display — since that number is the only thing that will close the wound.
  - Turning the setting off stops new deep bleeds but leaves existing ones payable, rather than stranding a wound nobody can close.
- `kindLabel` added to the module API, and `describe()` now reports each effect's `deep` progress (`{ required, received, remaining }`).

### Fixed
- **Deep Bleed setting never appeared**, even with pf1-critical-effects installed and active. Its visibility was gated on that module's API surface, which is published from *its* `init` hook — and init listeners fire in module load order, which puts `pf1-bleed-effects` first alphabetically. The probe therefore always reported absent. Visibility now tests module activeness, which is known from world data before any module script runs; the API probe is kept for the `ready`-time provider registration, where load order no longer matters. A module that is active but exposes no dedicated-healing API (a version mismatch) now warns the GM instead of failing silently.
- **Burning condition** — recurring 1d6 fire damage with a turn-start Reflex save (default DC 15) to put it out. A successful save extinguishes with no damage; a failure deals the 1d6 and burning persists; a turn that ends with the save unrolled applies the 1d6 automatically.
- Save prompt auto-detects **PF1 Roll Requests** (targeted request card) and otherwise posts a self-contained Reflex-save button card.
- **Reflex save vs. burning** setting to disable the save entirely — when off, burning creatures automatically take 1d6 fire at the end of each of their turns with no save prompt.
- **Per-burning save opt-out** via `@Burning[nosave]` (or `save=false`) and `apply(ref, { save: false })`, for fires that can't simply be rolled out. Behaves exactly as a save that was never rolled: the 1d6 lands automatically at the end of each of the creature's turns. The world setting remains a master switch over both.
- **Burning supplied by a buff** (`Burning` in a buff's Conditions list) is now automatically saveless, and ends with the buff. A buff attaches its condition to an Active Effect on the *item*, and PF1's `setConditions` only removes condition effects living directly on the actor — so a successful save previously announced that the fire was out while the creature kept burning and got re-prompted every turn. Detected the same way PF1's own sheet marks a condition "inherited" (`appliedEffects` whose parent is an Item).
- **Burning damage now respects fire resistance and vulnerability.** Each 1d6 is increased by 50% against creatures vulnerable to fire, then reduced by the target's highest applicable fire resistance (resistances of the same type don't stack, so the largest applies rather than the sum). Damage fully soaked by resistance leaves the creature burning but unharmed. Chat cards show the mitigation so a reduced number doesn't read as a bug. Controlled by the new **Burning respects fire resistance** world setting, on by default; free-text energy-resistance entries are not parsed.
- `@Burning`, `@Burning[dc=18]`, and `@Burning{Label}` text enrichers.
- Burning API under `pf1BurningEffects` / `game.modules.get("pf1-bleed-effects").api.burning` (`apply`, `clear`, `isBurning`).
- Coexists with Nevela's Automation Suite: defers to its `burning` condition when present, otherwise registers its own.

### Fixed
- A successful save that couldn't actually extinguish the fire (a buff supplying the condition switched on after the prompt was posted) no longer reports it as put out — the card now says the flames are being sustained and keep burning.
- **Fire immunity was never actually detected.** The check read `traits.di.value` as an array, but PF1 v11 turned that into a deprecated getter returning a `Set` — so `.includes()` silently resolved to `undefined` and every creature was treated as non-immune. Now reads `traits.di.total`. Immune creatures can no longer be set alight at all (previously the condition was applied and then cleared on the next turn tick).

### Changed
- All user-facing text (settings, notifications, dialogs, chat cards, enricher labels, tooltips) is now localizable via `game.i18n` (English `lang/en.json` included).

## [0.9.2] - 2026-06-28

### Added
- Prompt for manual entry of bleed effects.

## [0.9.1] - 2026-06-28

### Added
- Automated GitHub Actions release workflow.

## [0.9.0] - 2026-06-28

### Added
- Initial release.
