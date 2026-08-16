/**
 * PF1 Bleed Effects — damage-over-time configuration UI.
 *
 * A collapsible section on the Advanced tab of every item sheet, holding any number of independently
 * configured instances. See `dot.mjs` for what the values mean and when they fire.
 *
 * Two pieces of the system are borrowed rather than rebuilt:
 *
 *  - The damage type picker is PF1's own `DamageTypeSelector`, the one the action sheet's damage
 *    parts use. It takes `(object, path, types, { updateCallback })` and only uses `path` to build a
 *    unique application id, so it can be pointed at an item flag and told to write back through the
 *    callback. Same chips, same categories, same modifiers.
 *  - The chips themselves are rendered with the system's `damage-type-visual` partial, so a
 *    configured instance reads exactly like a damage part on an action.
 *
 * Values are written with explicit `item.update()` calls on change rather than by naming inputs
 * `flags.…` and letting the sheet's own submission carry them (which is what the buff bleed/burning
 * rows do). A keyed collection with add and delete buttons has no fixed set of inputs to declare, so
 * the sheet can't be left to serialize it.
 */

import { MODULE_ID } from "./dot-common.mjs";
import { DOT_FLAG, TIMINGS, readInstances, hasPhysicalType } from "./dot.mjs";
import { makeCollapsible } from "./dot-collapse.mjs";

/**
 * De-dup class. Deliberately specific to this feature: a generic name would make our "remove what we
 * added last render" sweep delete another module's section.
 */
const SECTION_CLASS = "bld-dot-section";

/** Path to one instance's stored data. */
const path = (id, key) => `flags.${MODULE_ID}.${DOT_FLAG}.instances.${id}${key ? `.${key}` : ""}`;

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
 * Escape a value for safe interpolation into an attribute or text node.
 *
 * @param {*} value
 * @returns {string}
 */
function esc(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

/**
 * The material and alignment ids a DoT can be declared to count as.
 *
 * The registry marks which materials are relevant to damage reduction at all (`dr`), which is
 * exactly this list — adamantine, cold iron, alchemical silver, nexavaran steel, magic and epic —
 * plus the four alignment resistances, which live in config rather than the registry.
 *
 * @returns {Array<{id:string, label:string}>}
 */
function bypassChoices() {
  const materials = [...pf1.registry.materials]
    .filter((m) => m.dr)
    .map((m) => ({ id: m.id, label: m.shortName || m.name }));

  const alignments = Object.entries(pf1.config.damageResistances).map(([id, label]) => ({
    id,
    label: game.i18n.localize(label),
  }));

  return [...materials, ...alignments];
}

/**
 * Render the system's damage-type chips for a set of type ids.
 *
 * @param {string[]} types
 * @returns {Promise<string>}
 */
async function typeChips(types) {
  const damage = new pf1.models.action.DamagePartModel({ types: types?.length ? types : [] });
  return renderTemplate("systems/pf1/templates/internal/damage-type-visual.hbs", { damage });
}

/**
 * The label an instance shows on its tab, falling back to its position.
 *
 * @param {object} inst
 * @param {number} index
 * @returns {string}
 */
function instanceLabel(inst, index) {
  return inst.label || game.i18n.format("BLD.DoT.InstanceN", { n: index + 1 });
}

/**
 * Build the panel for one instance. Only the active one is displayed; see `applyActive()`.
 *
 * @param {object} inst
 * @param {number} index
 * @returns {Promise<string>}
 */
async function instancePanel(inst, index) {
  const healing = inst.kind === "healing";
  const chips = healing ? "" : await typeChips(inst.types);

  const timingOptions = TIMINGS.map(
    (t) =>
      `<option value="${t}"${inst.timing === t ? " selected" : ""}>${game.i18n.localize(`BLD.DoT.Timing.${t}`)}</option>`
  ).join("");

  const bypass = bypassChoices()
    .map(
      (choice) => `<label class="checkbox bld-dot-chip">
        <input type="checkbox" data-dot-bypass="${esc(choice.id)}"${inst.bypass.includes(choice.id) ? " checked" : ""} />
        ${esc(choice.label)}
      </label>`
    )
    .join("");

  return `<div class="bld-dot-panel" data-instance-id="${esc(inst.id)}">
    <div class="form-group">
      <label>${game.i18n.localize("BLD.DoT.NameLabel")}</label>
      <div class="form-fields">
        <input type="text" data-dot="label" value="${esc(inst.label)}"
               placeholder="${esc(game.i18n.format("BLD.DoT.InstanceN", { n: index + 1 }))}" autocomplete="off" />
        <label class="checkbox bld-dot-enable">
          <input type="checkbox" data-dot="enabled"${inst.enabled ? " checked" : ""} />
          ${game.i18n.localize("BLD.DoT.Enable")}
        </label>
      </div>
    </div>

    <div class="form-group">
      <label>${game.i18n.localize("BLD.DoT.FormulaLabel")}</label>
      <div class="form-fields">
        <input type="text" data-dot="formula" value="${esc(inst.formula)}"
               placeholder="${esc(game.i18n.localize("BLD.Buff.FormulaPlaceholder"))}" autocomplete="off" />
        <span class="bld-dot-preview"></span>
        <select data-dot="kind">
          <option value="damage"${healing ? "" : " selected"}>${game.i18n.localize("BLD.DoT.KindDamage")}</option>
          <option value="healing"${healing ? " selected" : ""}>${game.i18n.localize("BLD.DoT.KindHealing")}</option>
        </select>
      </div>
    </div>

    ${
      healing
        ? ""
        : `<div class="form-group bld-dot-types-row">
      <label>${game.i18n.localize("BLD.DoT.TypeLabel")}</label>
      <div class="form-fields">
        <a class="bld-dot-types" title="${esc(game.i18n.localize("BLD.DoT.TypeTitle"))}">${chips}</a>
      </div>
    </div>`
    }

    ${
      // Damage reduction only ever acts on physical damage, so the chips are dead controls on an
      // energy or untyped instance. `normalize()` drops the stored values under the same test, so
      // hiding the row never leaves one quietly in effect.
      healing || !hasPhysicalType(inst.types)
        ? ""
        : `<div class="form-group bld-dot-bypass-row">
      <label>${game.i18n.localize("BLD.DoT.BypassLabel")}</label>
      <div class="form-fields bld-dot-bypass">${bypass}</div>
      <p class="hint">${game.i18n.localize("BLD.DoT.BypassHint")}</p>
    </div>`
    }

    ${
      // Hardness, unlike DR, reduces energy damage too, so this stays available on every damage
      // instance regardless of type.
      healing
        ? ""
        : `<div class="form-group bld-dot-ignore-row">
      <label>${game.i18n.localize("BLD.DoT.IgnoreLabel")}</label>
      <div class="form-fields">
        <label class="checkbox bld-dot-ignore-hardness">
          <input type="checkbox" data-dot="ignoreHardness"${inst.ignoreHardness ? " checked" : ""} />
          ${game.i18n.localize("BLD.DoT.IgnoreHardness")}
        </label>
      </div>
      <p class="hint">${game.i18n.localize("BLD.DoT.IgnoreHardnessHint")}</p>
    </div>`
    }

    <div class="form-group">
      <label>${game.i18n.localize("BLD.DoT.TimingLabel")}</label>
      <div class="form-fields">
        <select data-dot="timing">${timingOptions}</select>
        <label class="checkbox bld-dot-onactivate">
          <input type="checkbox" data-dot="onActivate"${inst.onActivate ? " checked" : ""} />
          ${game.i18n.localize("BLD.DoT.OnActivate")}
        </label>
      </div>
      <p class="hint">${game.i18n.localize("BLD.DoT.TimingHint")}</p>
    </div>

    <div class="form-group bld-dot-panel-actions">
      <a class="bld-dot-delete"><i class="fas fa-trash"></i> ${game.i18n.localize("BLD.DoT.Delete")}</a>
    </div>
  </div>`;
}

/**
 * Build the whole section.
 *
 * @param {Item} item
 * @returns {Promise<string>}
 */
async function buildSection(item) {
  const instances = readInstances(item);
  const panels = await Promise.all(instances.map((inst, i) => instancePanel(inst, i)));

  // One tab per instance, plus a "+" tab that adds one — the same strip Buff Delivery uses, so the
  // two sections on the same Advanced tab read as one idiom rather than two.
  const tabs = instances
    .map(
      (inst, i) => `<a class="bld-dot-tab${inst.enabled ? "" : " bld-dot-tab-disabled"}"
           data-instance-id="${esc(inst.id)}">
        <span class="bld-dot-tab-label">${esc(instanceLabel(inst, i))}</span>
      </a>`
    )
    .join("");

  const empty = instances.length
    ? ""
    : `<p class="notes bld-dot-empty">${game.i18n.localize("BLD.DoT.Empty")}</p>`;

  // `data-tooltip-class` is inherited by every `data-tooltip` beneath it, which is how the tooltips
  // in here get a scoped class to be styled by — see the note in dot.css.
  return `<div class="${SECTION_CLASS}" data-tooltip-class="bld-tooltip">
    <h3 class="form-header bld-dot-header">
      <i class="fa-solid fa-hourglass-half"></i> ${game.i18n.localize("BLD.DoT.Heading")}
    </h3>
    <div class="bld-dot-body">
      <nav class="bld-dot-tabs">
        ${tabs}
        <a class="bld-dot-tab bld-dot-tab-add" title="${esc(game.i18n.localize("BLD.DoT.Add"))}"><i class="fas fa-plus"></i></a>
      </nav>
      ${empty}
      ${panels.join("")}
    </div>
  </div>`;
}

/* -------------------------------------------- *
 *  Wiring
 * -------------------------------------------- */

/**
 * Attach behaviour to a freshly-built section.
 *
 * @param {Application} app
 * @param {Item} item
 * @param {HTMLElement} section
 */
function wire(app, item, section) {
  const rollData = item.getRollData();
  const instances = readInstances(item);

  const save = (id, key, value) => item.update({ [path(id, key)]: value }, { render: false });

  // Which tab is open. Transient UI state parked on the sheet instance so it survives the sheet's
  // own re-renders, and never written to the document. Falls back to the first instance whenever
  // the remembered one has gone away.
  let activeId = app._bldDotActive;
  if (!instances.some((i) => i.id === activeId)) activeId = instances[0]?.id ?? null;
  app._bldDotActive = activeId;

  const applyActive = () => {
    for (const el of section.querySelectorAll(".bld-dot-tab, .bld-dot-panel")) el.classList.remove("active");
    if (!activeId) return;
    section.querySelector(`.bld-dot-tab[data-instance-id="${activeId}"]`)?.classList.add("active");
    section.querySelector(`.bld-dot-panel[data-instance-id="${activeId}"]`)?.classList.add("active");
  };

  // Tab strip — switching panels is pure UI, nothing is persisted.
  for (const tab of section.querySelectorAll(".bld-dot-tab:not(.bld-dot-tab-add)")) {
    tab.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      activeId = tab.dataset.instanceId;
      app._bldDotActive = activeId;
      applyActive();
    });
  }

  // "+" tab — add an instance and open it.
  section.querySelector(".bld-dot-tab-add")?.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const id = foundry.utils.randomID();
    await item.update(
      {
        [path(id)]: {
          enabled: true,
          label: "",
          kind: "damage",
          formula: "",
          types: [],
          bypass: [],
          timing: "turnEnd",
          onActivate: false,
        },
      },
      { render: false }
    );
    app._bldDotActive = id;
    app.render();
  });

  for (const row of section.querySelectorAll(".bld-dot-panel")) {
    const id = row.dataset.instanceId;
    const index = instances.findIndex((i) => i.id === id);
    const inst = instances[index];
    if (!inst) continue;

    const tab = section.querySelector(`.bld-dot-tab[data-instance-id="${id}"]`);

    for (const el of row.querySelectorAll("[data-dot]")) {
      const key = el.dataset.dot;
      el.addEventListener("change", async (event) => {
        event.stopPropagation();
        const value = el.type === "checkbox" ? el.checked : el.value;
        await save(id, key, value);

        // Kind decides which controls exist at all, so it has to redraw. Everything else updates
        // its own tab in place, which keeps the panel open and the caret where the user left it.
        if (key === "kind") app.render();
        else if (key === "enabled") tab?.classList.toggle("bld-dot-tab-disabled", !value);
      });
    }

    // Keep the tab caption in step with the name as it's typed.
    const labelInput = row.querySelector('[data-dot="label"]');
    const tabLabel = tab?.querySelector(".bld-dot-tab-label");
    if (labelInput && tabLabel) {
      labelInput.addEventListener("input", () => {
        tabLabel.textContent = labelInput.value.trim() || game.i18n.format("BLD.DoT.InstanceN", { n: index + 1 });
      });
    }

    // Damage types — the system's own selector, writing back to our flag.
    row.querySelector(".bld-dot-types")?.addEventListener("click", (event) => {
      event.preventDefault();
      const selector = new pf1.applications.DamageTypeSelector(item, path(id, "types"), new Set(inst.types), {
        updateCallback: async (types) => {
          await save(id, "types", types);
          app.render();
        },
      });
      selector.render(true);
    });

    // Bypass chips are individual checkboxes over one stored array.
    for (const box of row.querySelectorAll("[data-dot-bypass]")) {
      box.addEventListener("change", async (event) => {
        event.stopPropagation();
        const chosen = [...row.querySelectorAll("[data-dot-bypass]")]
          .filter((b) => b.checked)
          .map((b) => b.dataset.dotBypass);
        await save(id, "bypass", chosen);
      });
    }

    // Live formula preview, per keystroke.
    const input = row.querySelector('[data-dot="formula"]');
    const preview = row.querySelector(".bld-dot-preview");
    if (input && preview) {
      const refresh = () => {
        const formula = String(input.value ?? "").trim();
        if (!/@/.test(formula)) {
          preview.textContent = "";
          return;
        }
        let out = "?";
        try {
          const resolved = Roll.replaceFormulaData(formula, rollData, { missing: 0 });
          out = resolved;
          const value = Roll.safeEval(resolved);
          if (Number.isFinite(value)) out = String(value);
        } catch (_) {
          // Dice in the formula — the substituted form is the useful readout.
        }
        preview.textContent = `= ${out}`;
      };
      refresh();
      input.addEventListener("input", refresh);
    }

    // Delete.
    row.querySelector(".bld-dot-delete")?.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const label = inst.label || game.i18n.format("BLD.DoT.InstanceN", { n: index + 1 });
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: game.i18n.localize("BLD.DoT.Delete") },
        content: `<p>${game.i18n.format("BLD.DoT.DeleteConfirm", { name: esc(label) })}</p>`,
        rejectClose: false,
        modal: true,
      });
      if (!ok) return;
      await item.update({ [`flags.${MODULE_ID}.${DOT_FLAG}.instances.-=${id}`]: null }, { render: false });
      // Let the next pass fall back to the first surviving instance.
      if (app._bldDotActive === id) app._bldDotActive = null;
      app.render();
    });
  }

  applyActive();
}

/* -------------------------------------------- *
 *  Injection
 * -------------------------------------------- */

/**
 * Insert the section into an item sheet's Advanced tab.
 *
 * Appended to the end of the tab rather than anchored against a neighbour: buff-delivery and
 * pf1-defense-manager both position themselves relative to each other, and adding a third module to
 * that negotiation makes the resulting order depend on hook registration order. Last is predictable.
 *
 * @param {Application} app
 * @param {JQuery|HTMLElement} html
 */
async function onRenderItemSheet(app, html) {
  const root = rootOf(html);
  const item = app.item ?? app.document;
  if (!root || !item) return;

  // Our own section from a previous render of this sheet, if the DOM was reused.
  for (const stale of root.querySelectorAll(`.${SECTION_CLASS}`)) stale.remove();

  const tab = root.querySelector('.tab[data-tab="advanced"]');
  if (!tab) return; // this item type has no Advanced tab; nothing to hang it on

  const container = tab.querySelector(".flexcol") ?? tab;
  container.insertAdjacentHTML("beforeend", await buildSection(item));

  const section = container.querySelector(`:scope > .${SECTION_CLASS}`) ?? container.querySelector(`.${SECTION_CLASS}`);
  if (!section) return;

  wire(app, item, section);

  makeCollapsible(app, section, {
    key: "dot",
    header: ".bld-dot-header",
    body: ".bld-dot-body",
    configured: readInstances(item).length > 0,
    badge: readInstances(item).length || null,
  });
}

Hooks.on("renderItemSheetPF", onRenderItemSheet);
