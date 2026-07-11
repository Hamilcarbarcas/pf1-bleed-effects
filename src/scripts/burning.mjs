/**
 * PF1 Burning Effects — recurring fire damage gated by a Reflex save.
 *
 * Burning reuses the bleed module's damage-over-time plumbing (active-GM tick
 * on `updateCombat`, socket-routed application, condition-synced state) but is
 * simpler in one axis and richer in another:
 *
 *  - Damage is always `1d6` fire — there is no per-effect formula/stacking.
 *  - At the start of the burning creature's turn it may attempt a DC 15 Reflex
 *    save to put the fire out. A *success extinguishes and deals no damage*; a
 *    *failure deals 1d6 fire and burning persists*. If the turn ends with the
 *    save still unresolved (nobody rolled) and the creature is still on fire, it
 *    takes the 1d6 automatically — burning never stalls waiting for a click.
 *
 *    The save can be turned off entirely via the "Reflex save vs. burning"
 *    world setting. With it disabled, no save is prompted: a burning creature
 *    simply takes its 1d6 fire automatically at the end of each of its turns
 *    (via the same end-of-turn fallback below) until the condition is removed.
 *
 * The Reflex save is obtained one of two ways, auto-detected at tick time:
 *
 *  - roll-requests present → a targeted roll-request card; the active GM (which
 *    created it) applies the outcome from the `onResult` callback.
 *  - otherwise → a self-contained save-button card the module posts itself. The
 *    owner who clicks it rolls `actor.rollSavingThrow` on their own client and
 *    reports the pass/fail to the active GM over the module socket.
 *
 * Application is GM-authoritative: the active GM owns the per-turn "pending
 * save" bookkeeping and performs every damage/extinguish write, so it can tell
 * a resolved save from an ignored one and apply the end-of-turn fallback.
 *
 * The PF1 `burning` condition is the visual marker and the source of truth for
 * "is this actor on fire"; a small actor flag stores the save DC.
 */

import { MODULE_ID, SOCKET, resolveActor, isActiveGM } from "./dot-common.mjs";

const CONDITION_ID = "burning";
const FLAG_KEY = "burning"; // { dc:number }
const NEVELA_ID = "nevelas-automation-suite";
const ROLL_REQUESTS_ID = "pf1-roll-requests";
const SETTING_SAVE = "burningSavePrompt";

const DAMAGE_FORMULA = "1d6";
export const DEFAULT_DC = 15;

/**
 * Turn-tick de-dupe guard (see the bleed engine for the rationale). Only the
 * active GM ticks, so a module-level value is sufficient.
 *
 * @type {string|null}
 */
let lastTickKey = null;

/**
 * Message ids whose built-in save card has already been rolled on this client,
 * so a double-click can't roll twice.
 *
 * @type {Set<string>}
 */
const resolvedCards = new Set();

/**
 * Active GM only: per-turn "pending save" bookkeeping, keyed by actor UUID.
 * An entry exists from the moment a burning actor's turn prompts a save until
 * that save is resolved or the turn ends. `resolved` guards against double
 * application (a late roll after the end-of-turn fallback already fired).
 *
 * @type {Map<string, {resolved:boolean}>}
 */
const pendingSaves = new Map();

/* -------------------------------------------- *
 *  Condition registration
 * -------------------------------------------- */

/**
 * Register a `burning` condition, but only when nothing else provides one.
 *
 * Nevela's Automation Suite ships its own `burning` and registers it
 * *unconditionally* (no `has()` guard), so if we claimed the key first its
 * registration would throw and break its later conditions. We therefore defer
 * to Nevela whenever it is active — order-independently — and otherwise only
 * register if the key is still free (in case another module provides it).
 * Either way the condition id is the bare string `"burning"`, so the rest of
 * this engine is agnostic to who registered it.
 */
Hooks.on("pf1RegisterConditions", (registry) => {
  if (game.modules.get(NEVELA_ID)?.active) return; // Nevela owns "burning"
  if (registry.has(CONDITION_ID)) return; // some other module already provides it

  try {
    registry.register(MODULE_ID, CONDITION_ID, {
      name: "BLD.Condition.Burning",
      texture: "icons/svg/fire.svg",
      showInAction: true,
      showInDefense: true,
    });
  } catch (err) {
    console.error(`${MODULE_ID} | Failed to register the burning condition`, err);
  }
});

/* -------------------------------------------- *
 *  Helpers
 * -------------------------------------------- */

/**
 * The save DC configured on an actor's burning, or the default.
 *
 * @param {Actor} actor
 * @returns {number}
 */
function getDC(actor) {
  const dc = actor.getFlag(MODULE_ID, FLAG_KEY)?.dc;
  return Number.isFinite(dc) ? dc : DEFAULT_DC;
}

/**
 * Whether the per-turn Reflex save is enabled. When off, burning creatures take
 * the automatic end-of-turn 1d6 with no save prompt.
 *
 * @returns {boolean}
 */
function savePromptEnabled() {
  return game.settings.get(MODULE_ID, SETTING_SAVE);
}

/**
 * Roll one instance of burning fire damage.
 *
 * @param {Actor} actor
 * @returns {Promise<number>}
 */
async function rollDamage(actor) {
  const roll = await pf1.dice.RollPF.safeRoll(DAMAGE_FORMULA, actor.getRollData());
  return Math.max(0, Math.floor(roll.total || 0));
}

/**
 * Whether the actor is immune to fire (so burning does nothing to it).
 *
 * @param {Actor} actor
 * @returns {boolean}
 */
function isFireImmune(actor) {
  return !!actor.system?.traits?.di?.value?.includes?.("fire");
}

/* -------------------------------------------- *
 *  Owner-side mutations
 * -------------------------------------------- */

/**
 * Set an actor we own on fire: store the DC, show the condition, and deal the
 * initial 1d6 (catching fire deals damage immediately — no save).
 *
 * @param {Actor} actor
 * @param {{dc?:number}} [options]
 */
async function _applyLocal(actor, { dc = DEFAULT_DC } = {}) {
  await actor.setFlag(MODULE_ID, FLAG_KEY, { dc });
  if (!actor.statuses.has(CONDITION_ID)) await actor.setCondition(CONDITION_ID, true);

  if (isFireImmune(actor)) return;
  const total = await rollDamage(actor);
  if (total > 0) {
    await actor.applyDamage(total);
    await postCard(actor, game.i18n.format("BLD.Burning.Ignite", { name: `<strong>${actor.name}</strong>`, total }), "ignite");
  }
}

/**
 * Extinguish an actor we own: clear the condition and stored state.
 *
 * @param {Actor} actor
 */
async function _clearLocal(actor) {
  if (actor.getFlag(MODULE_ID, FLAG_KEY)) await actor.unsetFlag(MODULE_ID, FLAG_KEY);
  if (actor.statuses.has(CONDITION_ID)) await actor.setCondition(CONDITION_ID, false);
}

/* -------------------------------------------- *
 *  Public API (GM-routed)
 * -------------------------------------------- */

/**
 * Set a target on fire.
 *
 * If the caller doesn't own the target (e.g. a player torching an enemy), the
 * request is routed to the active GM via socket.
 *
 * @param {Actor|Token|TokenDocument|string} ref
 * @param {{dc?:number}} [options]
 * @returns {Promise<void>}
 */
async function apply(ref, { dc = DEFAULT_DC } = {}) {
  const actor = resolveActor(ref);
  if (!actor) {
    ui.notifications.error(game.i18n.localize("BLD.Burning.Error.NoTarget"));
    return;
  }
  const cleanDC = Number.isFinite(Number(dc)) ? Number(dc) : DEFAULT_DC;

  if (actor.isOwner) return _applyLocal(actor, { dc: cleanDC });

  game.socket.emit(SOCKET, { action: "burn", actorUuid: actor.uuid, payload: { dc: cleanDC } });
}

/**
 * Put out a target's fire.
 *
 * @param {Actor|Token|TokenDocument|string} ref
 * @returns {Promise<void>}
 */
async function clear(ref) {
  const actor = resolveActor(ref);
  if (!actor) return;

  if (actor.isOwner) return _clearLocal(actor);

  game.socket.emit(SOCKET, { action: "extinguish", actorUuid: actor.uuid });
}

/**
 * Whether a target is currently burning.
 *
 * @param {Actor|Token|TokenDocument|string} ref
 * @returns {boolean}
 */
function isBurning(ref) {
  const actor = resolveActor(ref);
  return !!actor?.statuses.has(CONDITION_ID);
}

/* -------------------------------------------- *
 *  Outcome application (shared by both branches)
 * -------------------------------------------- */

/**
 * Apply the result of a Reflex save on a burning actor: success extinguishes
 * with no damage; failure deals 1d6 fire and burning persists.
 *
 * Runs on the active GM (the authority for all burning writes). Only acts if an
 * unresolved pending save exists for this actor — a stray or late result (e.g.
 * a card clicked after its turn already ended and auto-resolved) is ignored.
 *
 * @param {Actor} actor
 * @param {boolean} passed
 */
async function resolveSave(actor, passed) {
  if (!isActiveGM()) return;
  const entry = pendingSaves.get(actor.uuid);
  if (!entry || entry.resolved) return; // nothing pending, or already handled
  entry.resolved = true;

  if (!actor.statuses.has(CONDITION_ID)) return; // put out by other means meanwhile

  if (passed) {
    await _clearLocal(actor);
    await postCard(actor, game.i18n.format("BLD.Burning.Extinguish", { name: `<strong>${actor.name}</strong>` }), "extinguish");
    return;
  }

  if (isFireImmune(actor)) return;
  const total = await rollDamage(actor);
  if (total > 0) await actor.applyDamage(total);
  await postCard(actor, game.i18n.format("BLD.Burning.Burn", { name: `<strong>${actor.name}</strong>`, total }), "burn");
}

/**
 * Active GM only: end-of-turn fallback. Any burning actor with a still-pending
 * save from a prior turn takes the 1d6 automatically (treated as no save
 * attempted), then its entry is cleared. Runs before the current combatant's
 * fresh prompt is created, so it only ever sees genuinely-elapsed saves — even
 * when the same actor is the only combatant.
 *
 * @param {Combat} _combat
 */
async function finalizePendingSaves(_combat) {
  for (const [actorUuid, entry] of pendingSaves) {
    if (!entry.resolved) {
      const actor = resolveActor(actorUuid);
      if (actor?.statuses.has(CONDITION_ID) && !isFireImmune(actor)) {
        const total = await rollDamage(actor);
        if (total > 0) await actor.applyDamage(total);
        const key = entry.noSave ? "BLD.Burning.AutoDamage" : "BLD.Burning.AutoNoSave";
        await postCard(actor, game.i18n.format(key, { name: `<strong>${actor.name}</strong>`, total }), "burn");
      }
    }
    pendingSaves.delete(actorUuid);
  }
}

/* -------------------------------------------- *
 *  Turn-start tick
 * -------------------------------------------- */

/**
 * At the burning actor's turn, prompt a Reflex save via whichever branch is
 * available. Fire-and-forget: resolution happens when the save is completed.
 *
 * @param {Actor} actor
 * @param {TokenDocument|null} token
 */
async function tickBurning(actor, token) {
  if (!actor.statuses.has(CONDITION_ID)) return;

  // Fire-immune creatures shouldn't be burning at all; clean up quietly.
  if (isFireImmune(actor)) {
    await _clearLocal(actor);
    return;
  }

  // Saves turned off: don't prompt. Register a "no save" pending entry so the
  // end-of-turn fallback deals the automatic 1d6 when this turn elapses.
  if (!savePromptEnabled()) {
    pendingSaves.set(actor.uuid, { resolved: false, noSave: true });
    return;
  }

  const dc = getDC(actor);

  // Track the save so we can apply the end-of-turn fallback if it's ignored.
  pendingSaves.set(actor.uuid, { resolved: false });

  if (game.modules.get(ROLL_REQUESTS_ID)?.active && game.pf1RollRequests?.createRequest) {
    return requestSaveViaRollRequests(actor, token, dc);
  }
  return postBuiltInSaveCard(actor, dc);
}

/**
 * roll-requests branch: create a targeted save request for just this actor and
 * apply the outcome from the streaming `onResult` callback (which runs on the
 * active GM that created the request).
 *
 * @param {Actor} actor
 * @param {TokenDocument|null} token
 * @param {number} dc
 */
async function requestSaveViaRollRequests(actor, token, dc) {
  const tokenDoc = token ?? actor.token ?? actor.getActiveTokens(false, true)[0] ?? null;
  if (!tokenDoc) return postBuiltInSaveCard(actor, dc); // no token to target → fall back

  let done = false;
  await game.pf1RollRequests.createRequest({
    type: "save",
    key: "ref",
    dc,
    mode: "targeted",
    showDC: true,
    showResults: true,
    flavor: game.i18n.format("BLD.Burning.SaveFlavor", { name: actor.name, dc }),
    targetedActors: [
      {
        id: tokenDoc.id,
        tokenUUID: tokenDoc.uuid,
        name: tokenDoc.name,
        img: tokenDoc.texture?.src ?? actor.img,
        isHidden: !!tokenDoc.hidden,
      },
    ],
    onResult: (payload) => {
      if (done) return;
      if (payload?.rollType === "cancelled") return;
      const passed = payload?.result?.passed;
      if (passed === null || passed === undefined) return;
      done = true;
      resolveSave(actor, passed);
    },
  });
}

/* -------------------------------------------- *
 *  Built-in save card
 * -------------------------------------------- */

/**
 * Post the module's own Reflex-save prompt card for a burning actor.
 *
 * @param {Actor} actor
 * @param {number} dc
 */
async function postBuiltInSaveCard(actor, dc) {
  const onFire = game.i18n.format("BLD.Burning.Card.OnFire", { name: `<strong>${actor.name}</strong>` });
  const saveLabel = game.i18n.format("BLD.Burning.Card.SaveButton", { dc });
  const content = `<div class="pf1-burning-card" data-burning-save data-actor-uuid="${actor.uuid}" data-dc="${dc}">
    <p><i class="fa-solid fa-fire"></i> ${onFire}</p>
    <button type="button" class="pf1-burning-save" data-actor-uuid="${actor.uuid}" data-dc="${dc}">
      <i class="fa-solid fa-person-running"></i> ${saveLabel}
    </button>
  </div>`;
  await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }) });
}

/**
 * Delegated click handler for built-in save-card buttons. Runs on the clicking
 * client; only an owner of the burning actor actually rolls & resolves.
 *
 * @param {MouseEvent} event
 */
async function onSaveButtonClick(event) {
  const button = event.target.closest?.("button.pf1-burning-save");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();

  const messageId = button.closest("[data-message-id]")?.dataset.messageId;
  if (messageId && resolvedCards.has(messageId)) return;

  const actor = resolveActor(button.dataset.actorUuid);
  if (!actor) return;
  if (!actor.isOwner) {
    ui.notifications.warn(game.i18n.format("BLD.Burning.NoControl", { name: actor.name }));
    return;
  }

  // Lock this card on this client before awaiting anything.
  if (messageId) resolvedCards.add(messageId);
  button.disabled = true;

  const dc = Number(button.dataset.dc) || DEFAULT_DC;
  const skipDialog = !actor.hasPlayerOwner; // NPCs (GM-driven) skip the situational dialog

  let msg;
  try {
    msg = await actor.rollSavingThrow("ref", { dc, skipDialog });
  } catch (err) {
    console.error(`${MODULE_ID} | Reflex save failed to roll`, err);
  }

  const roll = msg?.rolls?.[0];
  if (!roll) {
    // Roll was cancelled (dialog dismissed) — let the player try again.
    if (messageId) resolvedCards.delete(messageId);
    button.disabled = false;
    return;
  }

  const passed = roll.isSuccess ?? roll.total >= dc;

  // Application is GM-authoritative. If we are the GM, resolve directly;
  // otherwise report the result to the active GM over the module socket.
  if (isActiveGM()) await resolveSave(actor, passed);
  else game.socket.emit(SOCKET, { action: "burnSaveResult", actorUuid: actor.uuid, payload: { passed } });
}

/* -------------------------------------------- *
 *  Chat card
 * -------------------------------------------- */

/**
 * Post a one-line burning chat card.
 *
 * @param {Actor} actor
 * @param {string} text - Full localized sentence (already includes the actor name).
 * @param {"ignite"|"burn"|"extinguish"} kind
 */
async function postCard(actor, text, kind) {
  const icon = kind === "extinguish" ? "fa-fire-extinguisher" : "fa-fire";
  const content = `<div class="pf1-burning-card pf1-burning-${kind}">
    <p><i class="fa-solid ${icon}"></i> ${text}</p>
  </div>`;
  await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }) });
}

/* -------------------------------------------- *
 *  Combat hook
 * -------------------------------------------- */

/**
 * `updateCombat` handler: prompt the save for the actor whose turn just began.
 *
 * @param {Combat} combat
 * @param {object} changed
 */
async function onUpdateCombat(combat, changed) {
  if (!isActiveGM()) return; // exactly one executor
  if (!combat.started) return;
  if (changed.round === undefined && changed.turn === undefined) return;

  const key = `${combat.id}:${combat.round}:${combat.turn}`;
  if (key === lastTickKey) return;
  lastTickKey = key;

  // End-of-turn fallback for whoever was burning last turn, before we prompt
  // the actor whose turn is now starting.
  await finalizePendingSaves(combat);

  const combatant = combat.combatant;
  const actor = combatant?.actor;
  if (!actor) return;
  if (combatant.isDefeated) return;
  if (!actor.statuses.has(CONDITION_ID)) return;

  tickBurning(actor, combatant.token ?? null);
}

/* -------------------------------------------- *
 *  Socket handling
 * -------------------------------------------- */

/**
 * Execute burn/extinguish requests routed from non-owning clients.
 *
 * @param {{action:string,actorUuid:string,payload:object}} data
 */
function onSocket(data) {
  if (!isActiveGM()) return; // only the active GM performs the write
  const actor = resolveActor(data.actorUuid);
  if (!actor) return;
  if (data.action === "burn") _applyLocal(actor, data.payload ?? {});
  else if (data.action === "extinguish") _clearLocal(actor);
  else if (data.action === "burnSaveResult") resolveSave(actor, !!data.payload?.passed);
}

/* -------------------------------------------- *
 *  Registration
 * -------------------------------------------- */

export const BurningAPI = { apply, clear, isBurning, DEFAULT_DC };

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_SAVE, {
    name: "BLD.Settings.SavePrompt.Name",
    hint: "BLD.Settings.SavePrompt.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  const mod = game.modules.get(MODULE_ID);
  mod.api ??= {};
  mod.api.burning = BurningAPI;
  globalThis.pf1BurningEffects = BurningAPI; // convenience for macros
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, onSocket);
  document.body.addEventListener("click", onSaveButtonClick);
});

Hooks.on("updateCombat", onUpdateCombat);

/**
 * When the burning condition is removed by any means (token HUD, sheet, another
 * module), drop the stored DC flag so nothing lingers. Fires only on the client
 * that toggled it (an owner).
 */
Hooks.on("pf1ToggleActorCondition", (actor, conditionId, state) => {
  if (state || conditionId !== CONDITION_ID) return; // only when burning turns OFF
  if (!actor?.isOwner) return;
  if (actor.getFlag(MODULE_ID, FLAG_KEY)) actor.unsetFlag(MODULE_ID, FLAG_KEY);
});
