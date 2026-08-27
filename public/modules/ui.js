export const byId = (id) => document.getElementById(id);

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

export async function runSafely(action, userMessage) {
  try {
    await action();
  } catch (error) {
    console.error(error);
    alert(userMessage);
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
