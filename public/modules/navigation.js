import { byId, notify } from "./ui.js?v=23";
import { routes } from "./shell.js?v=23";

export const routeParent = (route) => route.includes("/") ? route.split("/")[0] : "home";

function address(route) {
  return location.pathname + location.search + (route === "home" ? "" : "#" + route);
}

function formValues(element) {
  const values = [...element.querySelectorAll("input:not([type=hidden]),input[data-draft-value],select,textarea")].map((field) =>
    field.type === "checkbox" || field.type === "radio" ? field.checked : field.value);
  return JSON.stringify([values, element.querySelector("[data-volume][aria-pressed=true]")?.dataset.volume]);
}

export function createNavigation(render) {
  const dialog = byId("labDialog");
  const contents = byId("dialogContents");
  const heading = byId("dialogTitle");
  const scrollPositions = new Map();
  let current;
  let pending = false;
  let closeApproved = false;
  let overlay;
  let requested = false;
  let sequence = 0;

  function makeState(route, depth, previous, modal = null) {
    return { elab: true, route, depth, previous, modal };
  }

  function applyState(next, method) {
    try {
      history[method](next, "", address(next.route));
      const entry = history.state;
      if (entry?.elab && entry.route === next.route && entry.depth === next.depth && entry.modal === next.modal) {
        current = next;
        return true;
      }
    } catch (error) {
      if (error.name !== "SecurityError") throw error;
    }
    notify("Nawigacja jest chwilowo zajęta. Spróbuj ponownie.", true);
    return false;
  }

  function paint(route, focus = true) {
    render(route);
    requestAnimationFrame(() => {
      window.scrollTo({ top: scrollPositions.get(route) || 0, behavior: "instant" });
      if (focus) byId(route === "home" ? "homeTitle" : "viewTitle").focus({ preventScroll: true });
    });
  }

  function start() {
    if (current) return;
    const hash = location.hash.slice(1);
    const entry = history.state;
    if (entry?.elab && routes.has(entry.route)) {
      current = { ...entry, modal: null };
      history.replaceState(current, "", address(current.route));
    } else {
      current = makeState("home", 0, null);
      history.replaceState(current, "", address("home"));
      if (routes.has(hash) && hash !== "home") {
        const parent = routeParent(hash);
        if (parent !== "home") push(parent);
        push(hash);
      }
    }
    history.scrollRestoration = "manual";
    paint(current.route, false);
  }

  function push(route) {
    return applyState(makeState(route, current.depth + 1, current.route), "pushState");
  }

  function go(route) {
    if (!current || !routes.has(route) || route === current.route || overlay || pending) return;
    scrollPositions.set(current.route, scrollY);
    if (push(route)) paint(route);
  }

  function back() {
    if (overlay) return close();
    if (!current || current.route === "home" || pending) return;
    const parent = routeParent(current.route);
    if (current.previous === parent) {
      pending = true;
      history.back();
    } else {
      scrollPositions.set(current.route, scrollY);
      if (applyState(makeState(parent, current.depth, current.previous), "replaceState")) paint(parent);
    }
  }

  function hasChanges() {
    return overlay?.watch && overlay.initial !== formValues(overlay.element);
  }

  const isBusy = () => overlay?.busy?.() || overlay?.element.querySelector("[aria-busy=true]");

  function canClose() {
    if (isBusy()) return false;
    return !hasChanges() || window.confirm("Zamknąć formularz bez zapisania zmian?");
  }

  function restoreElement() {
    if (overlay?.place) overlay.place.replaceWith(overlay.element);
    contents.replaceChildren();
  }

  function finish() {
    const prior = overlay;
    restoreElement();
    overlay = null;
    dialog.close();
    prior?.onDismiss?.();
    if (prior?.trigger?.isConnected) prior.trigger.focus({ preventScroll: true });
    else byId(current?.route === "home" ? "homeTitle" : "viewTitle")?.focus({ preventScroll: true });
  }

  function show(element, title, { busy, watch = true, onDismiss, wide = false } = {}) {
    if (!current || pending) return;
    if (!overlay) {
      if (!applyState(makeState(current.route, current.depth + 1, current.route, ++sequence), "pushState")) return;
    }
    const same = overlay?.element === element;
    const trigger = overlay?.trigger || document.activeElement;
    const place = same ? overlay.place : element.parentNode ? document.createComment("lab-dialog") : null;
    if (!same && overlay) restoreElement();
    if (!same && place) element.before(place);
    overlay = { element, place, trigger, busy, watch, onDismiss, initial: formValues(element) };
    heading.textContent = title;
    byId("dialogFeedback").hidden = true;
    dialog.classList.toggle("lab-dialog-wide", wide);
    if (!same) contents.replaceChildren(element);
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => {
      dialog.scrollTop = 0;
      (element.querySelector("[data-form-focus]") || heading).focus({ preventScroll: true });
    });
  }

  function close(saved = false) {
    if (!overlay || pending || (!saved && !canClose())) return;
    closeApproved = true;
    pending = true;
    history.back();
  }

  function stop() {
    if (overlay) finish();
    if (current) {
      history.replaceState(null, "", address("home"));
      scrollPositions.clear();
    }
    current = null;
    pending = false;
    closeApproved = false;
    requested = false;
  }

  window.addEventListener("popstate", (event) => {
    if (!current) return;
    pending = false;
    if (requested) {
      requested = false;
      return;
    }
    const next = event.state?.elab && routes.has(event.state.route) ? event.state : makeState("home", 0, null);
    if (overlay && next.modal === current.modal) return;
    if (overlay && !closeApproved && !canClose()) {
      requested = true;
      history.go(current.depth - next.depth || 1);
      return;
    }
    closeApproved = false;
    const prior = current.route;
    if (next.route !== prior) scrollPositions.set(prior, scrollY);
    if (overlay) finish();
    current = { ...next, modal: null };
    if (next.modal || !event.state?.elab) history.replaceState(current, "", address(current.route));
    if (current.route !== prior) paint(current.route);
  });

  window.addEventListener("beforeunload", (event) => {
    if (hasChanges() || isBusy()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  byId("dialogClose").addEventListener("click", () => close());
  return { start, stop, go, back, show, close };
}
