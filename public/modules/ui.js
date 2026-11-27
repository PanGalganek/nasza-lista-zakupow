import { icon } from "./icons.js?v=38";

export const byId = (id) => document.getElementById(id);
const messageTimers = new WeakMap();

export function notify(message, error = false) {
  const status = error && byId("labDialog")?.open ? byId("dialogFeedback") : byId("labToast");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("lab-toast-error", error);
  status.setAttribute("role", error ? "alert" : "status");
  status.hidden = false;
  clearTimeout(messageTimers.get(status));
  if (status.id !== "dialogFeedback") messageTimers.set(status, setTimeout(() => { status.hidden = true; }, 4500));
}

export function createElement(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== "") element.textContent = String(text);
  return element;
}

export function createInput(className, placeholder, value = "", type = "text") {
  const input = createElement("input", className);
  input.type = type;
  input.placeholder = placeholder;
  input.value = value ?? "";
  return input;
}

export function setPositionOptions(select, positions, selected, placeholder) {
  const options = [{ value: "", label: placeholder }, ...positions];
  if (selected && !positions.some(({ value }) => value === selected.value)) {
    options.splice(1, 0, { ...selected, label: "Poza filtrem · " + selected.label, disabled: true });
  }
  const current = [...select.options];
  if (current.length !== options.length || options.some(({ value, label, disabled }, index) =>
    current[index].value !== value || current[index].textContent !== label || current[index].disabled !== Boolean(disabled))) {
    select.replaceChildren(...options.map(({ value, label, disabled }) => {
      const option = createElement("option", "", label);
      option.value = value;
      option.disabled = Boolean(disabled);
      return option;
    }));
  }
  const value = selected?.value || "";
  if (select.value !== value) select.value = value;
  select.disabled = positions.length === 0 && !selected;
}

export async function runSafely(action, userMessage) {
  try {
    await action();
  } catch (error) {
    console.error(error);
    notify(error.code ? userMessage : error.message || userMessage, true);
  }
}

export function createButton(text, title, handler, className = "") {
  const button = createElement("button", className, text);
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", () => runSafely(handler, "Nie udało się wykonać operacji."));
  return button;
}

export function iconButton(symbol, title, handler, variant = "") {
  const button = createButton("", title, handler, `lab-button lab-button-icon ${variant}`);
  button.append(icon(symbol));
  return button;
}
