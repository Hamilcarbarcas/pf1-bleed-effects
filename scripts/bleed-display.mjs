/**
 * PF1 Bleed Effects — visual cues.
 *
 * Surfaces the bleed effects currently on an actor as a native Foundry tooltip
 * on the bleed condition, both in the actor sheet's Buffs tab and on the token
 * HUD's status menu — so you can see *what* and *how much* bleed is active.
 */

import { BleedAPI } from "./bleed.mjs";

/**
 * Inner HTML listing each bleed effect (shared by the data-tooltip string and
 * the little-helper HUD DOM injection).
 *
 * @param {Array<{label:string,formula:string}>} effects
 * @returns {string}
 */
function bleedListHTML(effects) {
  const items = effects.map((e) => `<li>${e.formula} ${e.label}</li>`).join("");
  const note =
    effects.length > 1
      ? `<em class="pf1-bleed-tooltip-note">Highest of each type applies each round.</em>`
      : "";
  return `<strong>Bleed</strong><ul>${items}</ul>${note}`;
}

/**
 * Build the full tooltip HTML for a set of bleed effects. PF1 already relies on
 * HTML inside `data-tooltip` (its enrichers join with `<br>`), so markup is safe.
 *
 * @param {Array<{label:string,formula:string}>} effects
 * @returns {string}
 */
function buildTooltip(effects) {
  return `<div class="pf1-bleed-tooltip">${bleedListHTML(effects)}</div>`;
}

/**
 * Normalize a render hook's html argument (jQuery or element) to an element.
 *
 * @param {JQuery|HTMLElement} html
 * @returns {HTMLElement|null}
 */
function rootOf(html) {
  if (html instanceof HTMLElement) return html;
  return html?.[0] ?? null;
}

/**
 * Append the bleed summary into a tooltip container node (once).
 *
 * @param {HTMLElement} container
 * @param {Array} effects
 */
function appendBleedSection(container, effects) {
  if (container.querySelector(".pf1-bleed-tooltip")) return;
  const section = document.createElement("div");
  section.classList.add("pf1-bleed-tooltip", "pf1-bleed-hud");
  section.innerHTML = bleedListHTML(effects);
  container.append(section);
}

/**
 * Actor sheet Buffs tab: show the bleed effects on the bleed condition.
 *
 * PF1's condition element carries no native tooltip, so the description tooltip
 * there comes from Koboldworks Little Helper's `condition-tooltips` feature,
 * which (unlike its HUD) offers no hook — it just appends a `.lil-tooltip` div
 * to the `.condition`. When that's present we inject into it so there's a single
 * merged tooltip; otherwise we fall back to our own native `data-tooltip`.
 *
 * @param {Application} app
 * @param {JQuery|HTMLElement} html
 */
function onRenderActorSheet(app, html) {
  const root = rootOf(html);
  const actor = app.actor ?? app.document;
  if (!root || !actor) return;

  const effects = BleedAPI.describe(actor);
  if (!effects.length) return;

  const el = root.querySelector('.buffs-conditions a.checkbox[data-condition-id="bleed"]');
  if (!el) return;
  const conditionDiv = el.closest(".condition");

  // Default: native tooltip (works immediately when Little Helper isn't tooltipping).
  el.dataset.tooltip = buildTooltip(effects);

  // Defer so Little Helper's render has had a chance to create its `.lil-tooltip`.
  requestAnimationFrame(() => {
    const lil = conditionDiv?.querySelector(":scope > .lil-tooltip");
    if (!lil) return; // No Little Helper tooltip; keep the native one.

    // Don't show a competing native tooltip on top of Little Helper's.
    delete el.dataset.tooltip;

    // Little Helper fills its tooltip's innerHTML on (first) hover; append after
    // that synchronous fill via rAF so our section isn't overwritten.
    conditionDiv.addEventListener("pointerenter", () => {
      requestAnimationFrame(() => appendBleedSection(lil, effects));
    });
  });
}

/**
 * Token HUD: tag the bleed status control with the effect tooltip.
 *
 * @param {Application} hud
 * @param {JQuery|HTMLElement} html
 */
function onRenderTokenHUD(hud, html) {
  const root = rootOf(html);
  const actor = hud.object?.actor;
  if (!root || !actor) return;

  const effects = BleedAPI.describe(actor);
  if (!effects.length) return;

  const tip = buildTooltip(effects);
  for (const el of root.querySelectorAll(".status-effects [data-status-id], .status-effects img.effect-control")) {
    const id = el.dataset.statusId ?? el.dataset.conditionId;
    const isBleed = id === "bleed" || /\/bleed\.svg/i.test(el.getAttribute("src") ?? "");
    if (isBleed) el.dataset.tooltip = tip;
  }
}

/**
 * Koboldworks Little Helper's "Active Buffs" HUD (top-right, on token select)
 * builds tooltips imperatively, so `data-tooltip` doesn't reach it. It exposes
 * this hook with the live tooltip node — append our bleed summary to it.
 *
 * @param {HTMLElement} tooltip
 * @param {{actor?:Actor,condition?:{id:string}}} info
 */
function onLittleHelperTooltip(tooltip, { actor, condition } = {}) {
  if (condition?.id !== "bleed" || !actor) return;
  const effects = BleedAPI.describe(actor);
  if (!effects.length) return;

  appendBleedSection(tooltip, effects);
}

Hooks.on("renderActorSheet", onRenderActorSheet);
Hooks.on("renderTokenHUD", onRenderTokenHUD);
Hooks.on("little-helper.hud.tooltip.active", onLittleHelperTooltip);
