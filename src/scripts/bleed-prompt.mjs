/**
 * PF1 Bleed Effects — manual-application prompt.
 *
 * When the bleed condition is toggled on by hand (token HUD, character sheet,
 * etc.) and no bleed is configured yet, ask the applier for an amount and type
 * and register it. Bleed applied via `@Bleed` or the API already carries its
 * amount, so it skips the prompt.
 */

import { MODULE_ID, BleedAPI } from "./bleed.mjs";
import { deepBleedEnabled } from "./dot-common.mjs";

const CONDITION_ID = "bleed";
const SETTING_PROMPT = "promptOnManualApply";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_PROMPT, {
    name: "BLD.Settings.PromptOnManual.Name",
    hint: "BLD.Settings.PromptOnManual.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });
});

/**
 * Build the <option> list for the type select: Hit Points plus each ability.
 *
 * @returns {string}
 */
function typeOptions() {
  const opts = [`<option value="hp" selected>${game.i18n.localize("BLD.Prompt.HitPoints")}</option>`];
  for (const [key, label] of Object.entries(pf1.config.abilities)) {
    opts.push(`<option value="${key}">${label}</option>`);
  }
  return opts.join("");
}

/**
 * Ask the applier how much bleed to register on an actor, then apply it.
 *
 * @param {Actor} actor
 */
async function promptBleed(actor) {
  // Only offered while the homebrew rule is live and pf1-critical-effects is there to run it.
  const deep = deepBleedEnabled();
  // The hint sits inside the form-group so it wraps under the field instead of adding to the
  // dialog's natural width. The full explanation of the rule lives in the setting's hint.
  const deepGroup = deep
    ? `
      <div class="form-group">
        <label>${game.i18n.localize("BLD.Prompt.DeepLabel")}</label>
        <input type="number" name="deep" min="0" step="1" value="0" />
        <p class="hint">${game.i18n.localize("BLD.Prompt.DeepNote")}</p>
      </div>`
    : "";

  const content = `
    <form class="pf1-bleed-dialog">
      <div class="form-group">
        <label>${game.i18n.localize("BLD.Prompt.AmountLabel")}</label>
        <input type="text" name="formula" value="1d6" autofocus />
      </div>
      <div class="form-group">
        <label>${game.i18n.localize("BLD.Prompt.TypeLabel")}</label>
        <select name="type">${typeOptions()}</select>
      </div>
      <div class="form-group">
        <label>${game.i18n.localize("BLD.Prompt.ModeLabel")}</label>
        <select name="mode">
          <option value="damage" selected>${game.i18n.localize("BLD.Kind.Damage")}</option>
          <option value="drain">${game.i18n.localize("BLD.Kind.Drain")}</option>
        </select>
      </div>${deepGroup}
      <p class="notes">${game.i18n.localize("BLD.Prompt.MarkerNote")}</p>
    </form>`;

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: game.i18n.format("BLD.Prompt.Title", { name: actor.name }) },
    // Pinned, because DialogV2 sizes to its content: the notes are the widest thing in here and
    // would otherwise stretch the window across the screen rather than wrapping.
    position: { width: 420 },
    content,
    buttons: [
      {
        action: "apply",
        label: game.i18n.localize("BLD.Prompt.Apply"),
        icon: "fa-solid fa-droplet",
        default: true,
        callback: (event, button, dialog) => {
          const form = dialog.element.querySelector("form");
          return {
            formula: form.querySelector('[name="formula"]').value.trim(),
            type: form.querySelector('[name="type"]').value,
            mode: form.querySelector('[name="mode"]').value,
            deep: Math.max(0, parseInt(form.querySelector('[name="deep"]')?.value) || 0),
          };
        },
      },
      { action: "marker", label: game.i18n.localize("BLD.Prompt.MarkerOnly"), icon: "fa-regular fa-circle" },
    ],
    rejectClose: false,
  });

  if (!result || result === "marker" || !result.formula) return;

  const kind = result.type === "hp" ? "hp" : `${result.type}.${result.mode}`;
  await BleedAPI.apply(actor, { formula: result.formula, kind, deepRequired: result.deep });
}

/**
 * On manual bleed application (condition turned on with nothing configured),
 * prompt for the amount. Fires only on the client that toggled it.
 */
Hooks.on("pf1ToggleActorCondition", (actor, conditionId, state) => {
  if (!state || conditionId !== CONDITION_ID) return; // only when bleed turns ON
  if (!actor?.isOwner) return;
  if (!game.settings.get(MODULE_ID, SETTING_PROMPT)) return;
  if (BleedAPI.list(actor).length) return; // already configured (e.g. via @Bleed / API)
  promptBleed(actor);
});
