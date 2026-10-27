/**
 * PF1 Burning Effects – `@Burning[...]` text enricher.
 *
 * Syntax (follows PF1 enricher convention `@Verb[opts]{label}`):
 *   @Burning                                  catching fire: 1d6 now, free DC 15 save each turn
 *   @Burning[damage=2d6;duration=1d4;dc=17]   a burn: configured damage, rounds and DC
 *   @Burning[duration=0]                      a burn that lasts until put out (1d6, DC 15)
 *   @Burning{Immolate}                        custom label
 *
 * Any of `damage`, `duration` or `dc` makes it a burn; the rest default. See DESIGN-BURNING.md §2.
 */

import { BurningAPI, DAMAGE_FORMULA, DEFAULT_DC } from "./burning.mjs";

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
    if (k?.trim()) opts[k.trim().toLowerCase()] = (v ?? "").trim();
  }
  return opts;
}

/**
 * The tooltip for a burn's options, with defaults filled in.
 *
 * @param {{damage:string, duration:string, dc:string}} opts
 * @returns {string}
 */
function burnTooltip({ damage, duration, dc }) {
  const rounds = duration && duration !== "0"
    ? game.i18n.format("BLD.Burning.Enricher.Rounds", { duration })
    : game.i18n.localize("BLD.Burning.Left.Until");
  return game.i18n.format("BLD.Burning.Enricher.TooltipBurn", {
    damage: damage || DAMAGE_FORMULA,
    dc: dc || DEFAULT_DC,
    rounds,
  });
}

/**
 * Build the enriched element for a match.
 *
 * @param {RegExpMatchArray} match
 * @returns {HTMLAnchorElement}
 */
function enrich(match) {
  const { options, label } = match.groups;
  const opts = parseOptions(options);
  const damage = opts.damage ?? "";
  const duration = opts.duration ?? "";
  const dc = opts.dc ?? "";
  const isBurn = "damage" in opts || "duration" in opts || "dc" in opts;

  const a = document.createElement("a");
  a.classList.add("pf1-burning-link");
  if (isBurn) {
    a.dataset.burn = "true";
    a.dataset.damage = damage;
    a.dataset.duration = duration;
    a.dataset.dc = dc;
  }
  a.dataset.tooltip = isBurn
    ? burnTooltip({ damage, duration, dc })
    : game.i18n.localize("BLD.Burning.Enricher.TooltipCatch");
  a.dataset.tooltipClass = "pf1";

  const i = document.createElement("i");
  i.classList.add("fa-solid", "fa-fire");
  i.inert = true;
  a.append(i, " ", label?.trim() || game.i18n.localize("BLD.Burning.Enricher.DefaultLabel"));

  return a;
}

/**
 * Resolve target actors for a clicked enricher, preferring PF1's own resolver for parity with
 * other enriched links.
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
 * Roll data of the message's source, so a burn's `@`-references lock to the inflicting creature.
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
 * Click handler for `@Burning` links.
 *
 * @param {MouseEvent} event
 */
async function onClick(event) {
  const a = event.target.closest?.("a.pf1-burning-link");
  if (!a) return;
  event.preventDefault();
  event.stopPropagation();

  const actors = getActors(a);
  if (!actors.length) {
    ui.notifications.warn(game.i18n.localize("BLD.Burning.Enricher.NoTarget"));
    return;
  }

  // A burn with every field blank still has to be a burn, so `duration=0` carries it.
  const options = a.dataset.burn === "true"
    ? {
        formula: a.dataset.damage,
        dc: a.dataset.dc,
        duration: a.dataset.duration || "0",
        sourceRollData: getSourceRollData(a) ?? undefined,
      }
    : {};

  for (const actor of actors) {
    await BurningAPI.apply(actor, options);
  }
}

Hooks.once("setup", () => {
  CONFIG.TextEditor.enrichers.push({ pattern: PATTERN, enricher: enrich });
});

Hooks.once("ready", () => {
  document.body.addEventListener("click", onClick);
});
