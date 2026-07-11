/**
 * PF1 Bleed Effects — manual-application prompt.
 *
 * When the bleed condition is toggled on by hand (token HUD, character sheet,
 * etc.) and no bleed is configured yet, ask the applier for an amount and type
 * and register it. Bleed applied via `@Bleed` or the API already carries its
 * amount, so it skips the prompt.
 */

import { MODULE_ID, BleedAPI } from "./bleed.mjs";

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
      </div>
      <p class="notes">${game.i18n.localize("BLD.Prompt.MarkerNote")}</p>
    </form>`;

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: game.i18n.format("BLD.Prompt.Title", { name: actor.name }) },
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
          };
        },
      },
      { action: "marker", label: game.i18n.localize("BLD.Prompt.MarkerOnly"), icon: "fa-regular fa-circle" },
    ],
    rejectClose: false,
  });

  if (!result || result === "marker" || !result.formula) return;

  const kind = result.type === "hp" ? "hp" : `${result.type}.${result.mode}`;
  await BleedAPI.apply(actor, { formula: result.formula, kind });
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
