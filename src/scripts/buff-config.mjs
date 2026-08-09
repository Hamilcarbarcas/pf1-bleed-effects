/**
 * PF1 Bleed Effects — buff configuration.
 *
 * A PF1 buff can list conditions under its Conditions field; while the buff is active they are
 * supplied to the actor, and switching the buff off takes them away again. That already handles
 * the whole on/off lifetime of a bleed or a burn — the only thing missing is *how much* it deals.
 *
 * This adds that field, and only that field, to the buff sheet: a row appears beneath Conditions
 * for each of `bleed` and `burning` that the buff actually lists. Leaving it empty is meaningful —
 * that is the vanilla behaviour of an inert condition marker.
 *
 * The values are ordinary item flags written by the sheet's own form submission (PF1's item sheet
 * expands dotted `flags.*` input names straight into the update), so there is no listener here and
 * nothing to keep in sync. The engines read the flags off the buff when they tick.
 */

import { MODULE_ID, deepBleedEnabled } from "./dot-common.mjs";
import { BUFF_FLAG as BLEED_FLAG } from "./bleed.mjs";
import { BUFF_FLAG as BURNING_FLAG } from "./burning.mjs";

/**
 * De-dup class. Deliberately specific to this feature rather than something generic: a shared
 * class name would make our "remove what we added last render" sweep delete another module's rows.
 */
const MARKER_CLASS = "pf1-bleed-buff-config";

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
 * Escape a value for safe interpolation into an attribute.
 *
 * @param {string} value
 * @returns {string}
 */
function attr(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

/**
 * Build the `<option>` list for the bleed kind select, grouped by damage vs. drain so thirteen
 * choices read as three short lists.
 *
 * @param {string} selected - Canonical kind, e.g. "hp" or "con.damage".
 * @returns {string}
 */
function kindOptions(selected) {
  const option = (value, label) =>
    `<option value="${attr(value)}"${value === selected ? " selected" : ""}>${label}</option>`;

  const damage = [];
  const drain = [];
  for (const [key, label] of Object.entries(pf1.config.abilities)) {
    damage.push(option(`${key}.damage`, label));
    drain.push(option(`${key}.drain`, label));
  }

  return [
    option("hp", game.i18n.localize("BLD.Prompt.HitPoints")),
    `<optgroup label="${attr(game.i18n.localize("BLD.Kind.Damage"))}">${damage.join("")}</optgroup>`,
    `<optgroup label="${attr(game.i18n.localize("BLD.Kind.Drain"))}">${drain.join("")}</optgroup>`,
  ].join("");
}

/**
 * The bleed configuration rows: amount and type, how long it lasts, and — for a bleed that
 * outlives its buff — the optional deep-wound threshold and healing block.
 *
 * The deep fields are rendered only for the "persists" mode and only while the homebrew rule is
 * live, because they mean nothing otherwise: a bleed that ends with its buff has nothing for
 * dedicated healing to close, and a threshold with no allocation dialog behind it would be an
 * unclearable wound.
 *
 * @param {Item} item
 * @returns {string}
 */
function bleedRow(item) {
  const config = item.getFlag(MODULE_ID, BLEED_FLAG) ?? {};
  const persists = config.mode === "persist";

  const rows = [
    `
    <div class="form-group ${MARKER_CLASS}">
      <label>${game.i18n.localize("BLD.Buff.BleedLabel")}</label>
      <div class="form-fields">
        <input type="text" name="flags.${MODULE_ID}.${BLEED_FLAG}.formula"
               value="${attr(config.formula)}"
               placeholder="${attr(game.i18n.localize("BLD.Buff.FormulaPlaceholder"))}" />
        <select name="flags.${MODULE_ID}.${BLEED_FLAG}.kind">${kindOptions(config.kind || "hp")}</select>
      </div>
      <p class="hint">${game.i18n.localize("BLD.Buff.BleedHint")}</p>
    </div>`,
    `
    <div class="form-group ${MARKER_CLASS}">
      <label>${game.i18n.localize("BLD.Buff.ModeLabel")}</label>
      <div class="form-fields">
        <select name="flags.${MODULE_ID}.${BLEED_FLAG}.mode">
          <option value="active"${persists ? "" : " selected"}>${game.i18n.localize("BLD.Buff.ModeActive")}</option>
          <option value="persist"${persists ? " selected" : ""}>${game.i18n.localize("BLD.Buff.ModePersist")}</option>
        </select>
      </div>
      <p class="hint">${game.i18n.localize(persists ? "BLD.Buff.ModePersistHint" : "BLD.Buff.ModeActiveHint")}</p>
    </div>`,
  ];

  if (persists && deepBleedEnabled()) {
    const required = Math.max(0, Math.floor(Number(config.deep) || 0));
    rows.push(`
    <div class="form-group ${MARKER_CLASS}">
      <label>${game.i18n.localize("BLD.Prompt.DeepLabel")}</label>
      <div class="form-fields">
        <input type="number" name="flags.${MODULE_ID}.${BLEED_FLAG}.deep"
               min="0" step="1" value="${required}" />
        <label class="checkbox">
          <input type="checkbox" name="flags.${MODULE_ID}.${BLEED_FLAG}.blocks"
                 ${config.blocks ? "checked" : ""} />
          ${game.i18n.localize("BLD.Buff.BlocksLabel")}
        </label>
      </div>
      <p class="hint">${game.i18n.localize("BLD.Prompt.DeepNote")}</p>
    </div>`);
  }

  return rows.join("");
}

/**
 * The burning configuration row.
 *
 * @param {Item} item
 * @returns {string}
 */
function burningRow(item) {
  const config = item.getFlag(MODULE_ID, BURNING_FLAG) ?? {};
  return `
    <div class="form-group ${MARKER_CLASS}">
      <label>${game.i18n.localize("BLD.Buff.BurningLabel")}</label>
      <div class="form-fields">
        <input type="text" name="flags.${MODULE_ID}.${BURNING_FLAG}.formula"
               value="${attr(config.formula)}" placeholder="1d6" />
      </div>
      <p class="hint">${game.i18n.localize("BLD.Buff.BurningHint")}</p>
    </div>`;
}

/**
 * Insert the configuration rows into a buff sheet, directly beneath the Conditions field they
 * belong to.
 *
 * @param {ItemSheet} app
 * @param {JQuery|HTMLElement} html
 */
function onRenderItemSheet(app, html) {
  const root = rootOf(html);
  const item = app.item ?? app.document;
  if (!root || item?.type !== "buff") return;

  // Our own rows from a previous render of this sheet, if the DOM was reused.
  for (const stale of root.querySelectorAll(`.${MARKER_CLASS}`)) stale.remove();

  const conditions = item.system.conditions ?? [];
  const rows = [];
  if (conditions.includes("bleed")) rows.push(bleedRow(item));
  if (conditions.includes("burning")) rows.push(burningRow(item));
  if (!rows.length) return;

  const anchor = root.querySelector(".form-group.conditions");
  if (!anchor) return; // sheet layout changed out from under us; better nothing than misplaced

  anchor.insertAdjacentHTML("afterend", rows.join(""));
}

Hooks.on("renderItemSheet", onRenderItemSheet);
