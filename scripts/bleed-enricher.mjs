/**
 * PF1 Bleed Effects — `@Bleed[...]` text enricher.
 *
 * Syntax (follows PF1 enricher convention `@Verb[primary;opts]{label}`):
 *   @Bleed[1d6]                       hit point bleed
 *   @Bleed[@cl;type=con]              Constitution damage bleed (mode defaults to damage)
 *   @Bleed[2;type=str;mode=drain]     Strength drain bleed
 *   @Bleed[1d6]{Open Wound}           custom label
 *
 * The primary argument is the damage formula; `type`/`mode` are options.
 */

import { BleedAPI } from "./bleed.mjs";

const PATTERN =
  /@Bleed\[(?<formula>[^;\]]+?)(?:;(?<options>[^\]]*))?\](?:\{(?<label>[^}]*)\})?/g;

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
 * Derive a canonical kind string from enricher options.
 *
 * @param {Record<string,string>} opts
 * @returns {string}
 */
function kindFromOptions(opts) {
  const type = (opts.type ?? "hp").toLowerCase();
  if (type === "hp") return "hp";
  const mode = (opts.mode ?? "damage").toLowerCase();
  return `${type}.${mode}`;
}

/**
 * Build the enriched element for a match.
 *
 * @param {RegExpMatchArray} match
 * @returns {HTMLAnchorElement}
 */
function enrich(match) {
  const { formula, options, label } = match.groups;
  const kind = kindFromOptions(parseOptions(options));
  const f = formula.trim();

  const a = document.createElement("a");
  a.classList.add("pf1-bleed-link");
  a.dataset.formula = f;
  a.dataset.kind = kind;
  a.dataset.tooltip = `Apply bleed (${kind}): ${f}`;
  a.dataset.tooltipClass = "pf1";

  const i = document.createElement("i");
  i.classList.add("fa-solid", "fa-droplet");
  i.inert = true;
  a.append(i, " ", label?.trim() || `Bleed: ${f}`);

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
 * Get the roll data of the message's source actor, used to lock `@`-references
 * (e.g. `@cl`) to the inflicting actor at click time.
 *
 * @param {HTMLElement} el
 * @returns {object|null}
 */
function getSourceRollData(el) {
  const msgId = el.closest("[data-message-id]")?.dataset.messageId;
  const message = msgId ? game.messages.get(msgId) : null;
  const src =
    message?.actionSource ??
    message?.itemSource ??
    (message?.speaker ? ChatMessage.getSpeakerActor(message.speaker) : null);
  return src?.getRollData?.() ?? null;
}

/**
 * Click handler for `@Bleed` links.
 *
 * @param {MouseEvent} event
 */
async function onClick(event) {
  const a = event.target.closest?.("a.pf1-bleed-link");
  if (!a) return;
  event.preventDefault();
  event.stopPropagation();

  const { formula, kind } = a.dataset;
  const sourceRollData = getSourceRollData(a);

  const actors = getActors(a);
  if (!actors.length) {
    ui.notifications.warn("Bleed: no target. Select or target a token first.");
    return;
  }

  for (const actor of actors) {
    await BleedAPI.apply(actor, { formula, kind, sourceRollData });
  }
}

Hooks.once("setup", () => {
  CONFIG.TextEditor.enrichers.push({ pattern: PATTERN, enricher: enrich });
});

Hooks.once("ready", () => {
  document.body.addEventListener("click", onClick);
});
