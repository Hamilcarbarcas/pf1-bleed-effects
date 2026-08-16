/**
 * PF1 Bleed Effects — collapsible item-sheet sections.
 *
 * The damage-over-time block is tall, and the overwhelming majority of items configure nothing in
 * it. This turns the section's `h3.form-header` into the disclosure control: the topical icon
 * doubles as the toggle — full strength when open, dimmed when closed — so an expanded header looks
 * exactly as it did before, and a badge on the right keeps the configured count visible while
 * collapsed.
 *
 * Expanded state lives in memory for as long as the sheet is open, keyed by `appId`. Reopening the
 * item re-applies the default, which is "open only if this section is actually configured". Nothing
 * is written to the document.
 *
 * This is a deliberate copy of astora-mod's `sheet-section-collapse.mjs` rather than a shared
 * dependency — modules can't import across each other, and a hard dependency for eighty lines would
 * be worse than the duplication. The class names are prefixed for *this* module specifically: a
 * shared class name would make either module's "remove what we added last render" sweep delete the
 * other's rows.
 */

/** @type {Map<string, boolean>} `${appId}:${key}` → expanded */
const memo = new Map();

/**
 * Make a section collapsible by its header.
 *
 * @param {Application} app - The sheet the section was injected into.
 * @param {HTMLElement} section - Section root.
 * @param {object} opts
 * @param {string} opts.key - Distinguishes sections sharing one sheet.
 * @param {string} opts.header - Selector for the header inside `section`.
 * @param {string} opts.body - Selector for the collapsible body inside `section`.
 * @param {boolean} [opts.configured] - Default-open when true.
 * @param {number|string|null} [opts.badge] - Shown at the header's right edge. `null` omits the
 *   element entirely; a falsy count keeps it in the DOM but hidden, so the section's own code can
 *   update it in place.
 * @param {string} [opts.title] - Header tooltip.
 */
export function makeCollapsible(
  app,
  section,
  { key, header, body, configured = false, badge = null, title = "Click to expand / collapse" } = {}
) {
  const root = section;
  const headerEl = root?.querySelector(header);
  const bodyEl = root?.querySelector(body);
  if (!headerEl || !bodyEl) return;

  root.classList.add("bld-collapsible");
  headerEl.classList.add("bld-collapse-header");
  headerEl.setAttribute("title", title);

  if (badge !== null) {
    const el = document.createElement("span");
    el.className = "bld-collapse-badge";
    el.textContent = String(badge);
    if (!badge) el.style.display = "none";
    headerEl.append(el);
  }

  const memoKey = `${app.appId}:${key}`;
  let expanded = memo.get(memoKey) ?? !!configured;

  const apply = () => {
    root.classList.toggle("bld-collapsed", !expanded);
    bodyEl.style.display = expanded ? "" : "none";
  };
  apply();

  headerEl.addEventListener("click", (event) => {
    // Headers can carry their own controls; let those win.
    if (event.target.closest("a, button, input, select")) return;
    event.preventDefault();
    expanded = !expanded;
    memo.set(memoKey, expanded);
    apply();
  });
}

/** Drop a sheet's remembered state when it closes. */
function forget(app) {
  const prefix = `${app.appId}:`;
  for (const k of memo.keys()) if (k.startsWith(prefix)) memo.delete(k);
}

Hooks.on("closeItemSheetPF", forget);
