/**
 * PF1 Burning Effects — `@Burning[...]` text enricher.
 *
 * Syntax (follows PF1 enricher convention `@Verb[opts]{label}`):
 *   @Burning                     set on fire, default DC 15
 *   @Burning[dc=18]              set on fire, Reflex DC 18 to put out
 *   @Burning{Immolate}          custom label
 *   @Burning[dc=20]{Immolate}   both
 *
 * Burning always deals 1d6 fire per round, so — unlike @Bleed — there is no
 * formula argument; the only option is the save DC.
 */

import { BurningAPI, DEFAULT_DC } from "./burning.mjs";

const PATTERN = /@Burning(?:\[(?<options>[^\]]*)\])?(?:\{(?<label>[^}]*)\})?/g;

/**
 * Parse a `key=value;key=value` option string into an object.
 *
 * @param {string} str
 * @returns {Record<string,string>}
 */
function parseOptions(str) {
  const opts = {};
  if (!str) return opts;
  for (const part of str.split(";")) {
    const [k, v] = part.split("=", 2);
    if (k) opts[k.trim()] = (v ?? "true").trim();
  }
  return opts;
}

/**
 * Build the enriched element for a match.
 *
 * @param {RegExpMatchArray} match
 * @returns {HTMLAnchorElement}
 */
function enrich(match) {
  const { options, label } = match.groups;
  const dcRaw = parseOptions(options).dc;
  const dc = Number.isFinite(Number(dcRaw)) ? Number(dcRaw) : DEFAULT_DC;

  const a = document.createElement("a");
  a.classList.add("pf1-burning-link");
  a.dataset.dc = String(dc);
  a.dataset.tooltip = game.i18n.format("BLD.Burning.Enricher.Tooltip", { dc });
  a.dataset.tooltipClass = "pf1";

  const i = document.createElement("i");
  i.classList.add("fa-solid", "fa-fire");
  i.inert = true;
  a.append(i, " ", label?.trim() || game.i18n.localize("BLD.Burning.Enricher.DefaultLabel"));

  return a;
}

/**
 * Resolve target actors for a clicked enricher, preferring PF1's own resolver
 * for parity with other enriched links.
 *
 * @param {HTMLElement} el
 * @returns {Actor[]}
 */
function getActors(el) {
  const resolver = pf1?.chat?.enrichers?.getRelevantActors;
  if (resolver) {
    try {
      return [...resolver(el, true)];
    } catch {
      return [];
    }
  }
  if (game.user.targets.size) return [...game.user.targets].map((t) => t.actor).filter(Boolean);
  if (canvas.tokens?.controlled.length) return canvas.tokens.controlled.map((t) => t.actor).filter(Boolean);
  return game.user.character ? [game.user.character] : [];
}

/**
 * Click handler for `@Burning` links.
 *
 * @param {MouseEvent} event
 */
async function onClick(event) {
  const a = event.target.closest?.("a.pf1-burning-link");
  if (!a) return;
  event.preventDefault();
  event.stopPropagation();

  const dc = Number(a.dataset.dc) || DEFAULT_DC;

  const actors = getActors(a);
  if (!actors.length) {
    ui.notifications.warn(game.i18n.localize("BLD.Burning.Enricher.NoTarget"));
    return;
  }

  for (const actor of actors) {
    await BurningAPI.apply(actor, { dc });
  }
}

Hooks.once("setup", () => {
  CONFIG.TextEditor.enrichers.push({ pattern: PATTERN, enricher: enrich });
});

Hooks.once("ready", () => {
  document.body.addEventListener("click", onClick);
});
