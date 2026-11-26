import { chemicalCategory, formatLocalDate, formatPolishDate, parseLocalDate } from "../utils.js?v=30";
import { createElement } from "./ui.js?v=30";
import { formatQuantity, matchesInventorySearch, quantity } from "./inventory-quantity.js?v=30";
import { lotOptions, orderItemKey, orderLineProgress, orderPackageCount, standardKind } from "./inventory-items.js?v=30";
import { button, details, field, input, orderDescriptionLimit, panel, saveButton, select, unitSelect } from "./inventory-ui.js?v=30";
import { createOrderDocx, orderColumns } from "./inventory-docx.js?v=30";
import { productId, requireInventoryConnection } from "./inventory-store.js?v=30";

export const orderRequesters = ["B. Joachim", "A. Cieniewski", "K. Łoboda", "J. Gosławska", "M. Piasecka"];
const requesterStorage = "e-lab-order-requester";

function download(rows, date, requester, blob = createOrderDocx(rows, formatPolishDate(date), requester)) {
  const url = URL.createObjectURL(blob);
  const link = createElement("a");
  link.href = url;
  link.download = `zamowienie-${date}.docx`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function registerOrderName(product) {
  return product.producer && !matchesInventorySearch(product.producer, product.name)
    ? `${product.name} ${product.producer}` : product.name;
}

export function orderDefaults(product, lots) {
  const previous = lots.filter((record) => record.packageAmount).sort((a, b) => b.timestamp - a.timestamp)[0];
  const packaging = product.orderPackaging || (previous && { amount: previous.packageAmount, unit: previous.packageUnit });
  return {
    description: product.orderDescription?.trim() || registerOrderName(product),
    size: packaging ? formatQuantity(packaging.amount, packaging.unit).replace(/\s+[^\s]+$/, "").replace(/\s/g, "") : "",
    unit: packaging?.unit || "",
    count: product.orderPackages || previous?.orderPackages || 1,
  };
}

export function orderItems(lots, products) {
  const items = new Map();
  for (const lot of lots) {
    const key = orderItemKey(lot);
    if (!items.has(key)) items.set(key, { product: products.get(productId(lot)) || lot, kind: standardKind(lot), lots: [] });
    items.get(key).lots.push(lot);
  }
  return items;
}

export function suggestedOrderLot(lots) {
  const active = lots.filter((lot) => !lot.stock || lot.stock.status === "active");
  if (!active.length) return [...lots].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
  return active.sort((a, b) => (parseLocalDate(a.expiry) ? a.expiry : "9999")
    .localeCompare(parseLocalDate(b.expiry) ? b.expiry : "9999"))[0];
}

function orderLine(product, lot, current) {
  const size = String(current.size).trim();
  const count = Number(current.count || 1);
  if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error("Podaj liczbę opakowań od 1 do 10 000.");
  const amount = size && current.unit
    ? `${count > 1 ? `${count} × ` : ""}${formatQuantity(quantity(size, current.unit), current.unit)}` : "";
  const name = current.description.trim() || registerOrderName(product);
  if (name.length > orderDescriptionLimit) throw new Error("Opis zamówieniowy jest zbyt długi.");
  if (current.expiry && !parseLocalDate(current.expiry)) throw new Error("Podaj poprawny termin ważności partii.");
  const line = { productId: productId(lot), lotId: lot.id, name, amount, packages: count, expiry: current.expiry, standardKind: current.standardKind };
  return { ...line, notes: orderColumns(line, "")[10] };
}

export function mountInventoryOrders(inventory, { db, firestore }) {
  const { collection, doc, runTransaction, serverTimestamp } = firestore;
  const values = new Map();
  let orderDate = "";
  let requester = orderRequesters[0];
  try {
    const recent = localStorage.getItem(requesterStorage);
    if (orderRequesters.includes(recent)) requester = recent;
  } catch { /* Ustawienia lokalne są opcjonalne. */ }
  let pending = false;
  inventory.mount("orders", (container) => {
    const note = createElement("p", "lab-notice", "Pobierz osobny plik Word i skopiuj zweryfikowane wiersze do oficjalnego rejestru.");
    const search = input("Szukaj pozycji poza ostrzeżeniami", "", "search");
    const candidates = createElement("div", "lab-list max-h-56 overflow-y-auto");
    const draft = panel();
    const history = details("Historia wygenerowanych zamówień");
    const status = createElement("p", "text-sm text-red-700");
    status.setAttribute("role", "status");
    const items = orderItems(inventory.allLots(), new Map(inventory.products()));
    const selection = panel();
    const warnings = createElement("button", "lab-button lab-button-warning", "Przejdź do ostrzeżeń");
    warnings.type = "button";
    warnings.dataset.route = "alerts";
    selection.append(field("Dodaj pozycję", search), warnings, candidates);
    container.replaceChildren(note, selection, draft, history);

    function ensureRow(key) {
      const { product, kind, lots } = items.get(key);
      const lot = lots.find((part) => part.id === inventory.orderSelections.get(key)) || suggestedOrderLot(lots);
      const overrides = values.get(key);
      const expiry = overrides?.expiry?.lotId === lot.id ? overrides.expiry.value : lot.expiry || "";
      return {
        product, lot, ...orderDefaults(product, lots), ...overrides, expiry,
        standardKind: kind || overrides?.standardKind || "",
      };
    }

    const renderCandidates = () => {
      candidates.replaceChildren();
      if (!search.value.trim()) return;
      for (const [key, { product, kind, lots }] of items) {
        const type = kind === "O" ? "(O) okresowy" : kind === "B" ? "(B) bieżący" : "";
        if (!matchesInventorySearch(search.value, product.name, type, product.orderDescription, product.producer, product.cas, product.formula,
          ...lots.flatMap((lot) => [lot.group, lot.lotNumber]))) continue;
        const checkbox = createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = inventory.orderSelections.has(key);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            const matchingLot = lots.find((lot) => lot.lotNumber && matchesInventorySearch(search.value, lot.lotNumber));
            inventory.orderSelections.set(key, (matchingLot || suggestedOrderLot(lots)).id);
          } else inventory.orderSelections.delete(key);
          renderDraft();
        });
        const label = [product.name, kind ? `(${kind})` : "", product.producer, product.group,
          lots.length > 1 ? `Partie (${lots.length})` : "", lots.every((lot) => inventory.orderStatus(lot).state === "ordered") ? "zamówiono" : ""].filter(Boolean).join(" · ");
        candidates.append(field(label, checkbox));
      }
    };

    function renderDraft() {
      draft.replaceChildren(createElement("h3", "font-bold", "Podgląd zamówienia"));
      const selections = [...inventory.orderSelections.keys()].filter((key) => items.has(key));
      if (!selections.length) draft.append(createElement("p", "text-sm", "Wybierz pozycję w ostrzeżeniach lub dodaj ją powyżej."));
      const metadata = createElement("div", "lab-fields");
      const buyer = select(orderRequesters.map((name) => [name, name]), requester);
      buyer.required = true;
      const dateInput = input("Data zamówienia", orderDate || formatLocalDate(), "date");
      dateInput.required = true;
      const preview = details("Dane w dokumencie Word");
      preview.open = true;
      metadata.append(field("Osoba zamawiająca", buyer), field("Data zamówienia", dateInput));
      if (selections.length) draft.append(metadata);
      buyer.addEventListener("change", () => {
        requester = buyer.value;
        try { localStorage.setItem(requesterStorage, requester); } catch { /* Ustawienia lokalne są opcjonalne. */ }
        renderPreview();
      });
      dateInput.addEventListener("input", () => { orderDate = dateInput.value; renderPreview(); });

      function renderPreview() {
        [...preview.children].slice(1).forEach((child) => child.remove());
        const headings = ["Zamawiający i data", "Opis", "Ilość", "Ważność dotychczasowej partii"];
        for (const key of selections) {
          const current = ensureRow(key);
          const entry = createElement("dl", "lab-panel lab-fields lab-order-preview");
          try {
            const columns = orderColumns(orderLine(current.product, current.lot, current), formatPolishDate(dateInput.value, ""), buyer.value);
            [columns[1], columns[2], columns[3], columns[10]].forEach((value, index) => {
              const block = createElement("div");
              block.append(createElement("dt", "lab-muted", headings[index]), createElement("dd", "", value || "—"));
              entry.append(block);
            });
          } catch (error) { entry.append(createElement("p", "lab-field-wide", error.message)); }
          preview.append(entry);
        }
      }

      for (const key of selections) {
        const { kind, lots } = items.get(key);
        const current = ensureRow(key);
        const { product, lot } = current;
        const row = createElement("div", "lab-panel lab-fields");
        const description = createElement("textarea");
        description.value = current.description;
        description.rows = 4;
        description.maxLength = orderDescriptionLimit;
        const descriptionField = field("Opis zamówieniowy", description);
        descriptionField.classList.add("lab-field-wide");
        const size = input("Wielkość opakowania", current.size);
        const unit = unitSelect(current.unit);
        const count = input("Sztuki opakowań", current.count, "number");
        const lotSelect = select(lotOptions(lots), lot.id);
        const expiry = input("Termin ważności", current.expiry, "date");
        const standard = select([["", "Brak oznaczenia"], ["O", "(O) Okresowy"], ["B", "(B) Bieżący"]], current.standardKind);
        standard.disabled = Boolean(kind);
        for (const [name, control, event] of [["description", description, "input"], ["size", size, "input"],
          ["unit", unit, "change"], ["count", count, "input"], ["standardKind", standard, "change"]]) {
          control.addEventListener(event, () => updateValue(control, name));
        }
        function updateValue(control, name) {
          const value = name === "expiry" ? { lotId: lot.id, value: control.value } : control.value;
          values.set(key, { ...values.get(key), [name]: value });
          renderPreview();
        }
        expiry.addEventListener("input", () => updateValue(expiry, "expiry"));
        lotSelect.addEventListener("change", () => {
          inventory.orderSelections.set(key, lotSelect.value);
          renderDraft();
        });
        const title = [product.name, kind ? `(${kind})` : "", product.producer,
          inventory.orderStatus(lot).state === "ordered" ? "partia już oznaczona jako zamówiona" : ""].filter(Boolean).join(" · ");
        row.append(createElement("h4", "lab-field-wide lab-section-title", title));
        row.append(descriptionField);
        if (!product.orderDescription?.trim()) row.append(createElement("p", "lab-muted lab-field-wide",
          "Brak pełnego opisu w rejestrze. Możesz go uzupełnić dla tego zamówienia."));
        const source = field("Dotychczasowa partia", lotSelect);
        source.classList.add("lab-field-wide");
        row.append(field("Wielkość opakowania", size), field("Jednostka", unit), field("Liczba opakowań", count),
          source, field("Termin ważności dotychczasowej partii", expiry));
        if (chemicalCategory(product) === "Wzorce") row.append(field("Rodzaj wzorca", standard));
        row.append(button("Usuń pozycję z zamówienia", () => {
            inventory.orderSelections.delete(key);
            values.delete(key);
            renderDraft();
            renderCandidates();
          }));
        draft.append(row);
      }
      if (selections.length) {
        renderPreview();
        draft.append(preview);
      }
      const orderRef = doc(collection(db, "magazyn_zamowienia"));
      if (selections.length) draft.append(saveButton("Generuj dokument Word", async () => {
        if (pending) return;
        if (!orderRequesters.includes(buyer.value)) throw new Error("Wybierz osobę zamawiającą.");
        if (!parseLocalDate(dateInput.value)) throw new Error("Podaj poprawną datę zamówienia.");
        const selected = selections.map(ensureRow);
        if (selected.some(({ lot }) => inventory.orderStatus(lot).state === "ordered")
          && !confirm("Zamówienie zawiera pozycje, które już oznaczono jako zamówione. Czy kontynuować?")) return;
        const lines = selected.map((current) => orderLine(current.product, current.lot, current));
        const order = { lines, date: dateInput.value, requester: buyer.value };
        const blob = createOrderDocx(lines, formatPolishDate(order.date), order.requester);
        pending = true;
        try {
          const current = await runTransaction(db, async (transaction) => {
            const existing = await transaction.get(orderRef);
            if (existing.exists()) return existing.data();
            transaction.set(orderRef, { ...order, status: "generated", createdAt: serverTimestamp() });
            return order;
          });
          download(current.lines, current.date, current.requester, current === order ? blob : undefined);
          for (const key of selections) {
            inventory.orderSelections.delete(key);
            values.delete(key);
          }
          orderDate = "";
          renderDraft();
          renderCandidates();
          status.textContent = "Wygenerowano dokument. Oznaczenie jako zamówione jest dostępne w historii.";
        } finally { pending = false; }
      }, status));
      draft.append(status);
    }

    function renderOrders() {
      const orders = [...inventory.rows("orders")].sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      [...history.children].slice(1).forEach((child) => child.remove());
      for (const order of orders) {
        const delivered = order.lines.every((_, index) => orderLineProgress(order, index).complete);
        const stage = order.status === "ordered" ? delivered ? "Dostarczono" : "Zamówiono" : "Wygenerowano";
        const card = details(`${formatPolishDate(order.date)} · ${stage} · ${order.lines.length} poz.`);
        if (order.requester) card.append(createElement("p", "lab-muted", order.requester));
        order.lines.forEach((line, index) => {
          const [, , name, amount] = orderColumns(line, "");
          const { complete, received } = orderLineProgress(order, index);
          const count = orderPackageCount(line);
          const progress = complete ? "Dostarczono" : received ? `Przyjęto ${received}${count ? ` z ${count}` : ""} op.` : "";
          card.append(createElement("p", "text-sm", [name, amount, progress].filter(Boolean).join(" · ")));
        });
        card.append(button("Pobierz ponownie", () => download(order.lines, order.date, order.requester)));
        if (order.status === "generated") {
          const message = createElement("p", "text-sm text-red-700");
          const choice = button("Oznacz jako zamówione", async () => {
            choice.disabled = true;
            try {
              requireInventoryConnection();
              const orderRef = inventory.store.ref("orders", order.id);
              await runTransaction(db, async (transaction) => {
                if ((await transaction.get(orderRef)).data()?.status === "ordered") return;
                transaction.update(orderRef, { status: "ordered", orderedAt: serverTimestamp() });
              });
              choice.remove();
              history.querySelector("summary").setAttribute("aria-live", "polite");
            } catch (error) { message.textContent = error.message; choice.disabled = false; }
          });
          card.append(choice, message);
        }
        history.append(card);
      }
    }
    inventory.onChange("orders", renderOrders);
    search.addEventListener("input", renderCandidates);
    renderDraft();
    renderOrders();
  });
}
