# Changelog

<!--
  Release process: before tagging v<x.y.z>, rename the "Unreleased" heading
  below to "## [<x.y.z>] - <YYYY-MM-DD>". The release workflow extracts the
  section whose heading matches the pushed tag and uses it as the GitHub
  release body. If no matching section exists, the release fails.
-->

## [Unreleased]

### Added
- **Burning condition** — recurring 1d6 fire damage with a turn-start Reflex save (default DC 15) to put it out. A successful save extinguishes with no damage; a failure deals the 1d6 and burning persists; a turn that ends with the save unrolled applies the 1d6 automatically.
- Save prompt auto-detects **PF1 Roll Requests** (targeted request card) and otherwise posts a self-contained Reflex-save button card.
- **Reflex save vs. burning** setting to disable the save entirely — when off, burning creatures automatically take 1d6 fire at the end of each of their turns with no save prompt.
- `@Burning`, `@Burning[dc=18]`, and `@Burning{Label}` text enrichers.
- Burning API under `pf1BurningEffects` / `game.modules.get("pf1-bleed-effects").api.burning` (`apply`, `clear`, `isBurning`).
- Coexists with Nevela's Automation Suite: defers to its `burning` condition when present, otherwise registers its own.

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
