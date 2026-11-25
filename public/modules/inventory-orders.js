import { formatLocalDate, formatPolishDate } from "../utils.js?v=14";
import { createElement } from "./ui.js?v=14";
import { formatQuantity, matchesInventorySearch, quantity } from "./inventory-quantity.js?v=14";
import { button, details, field, input, panel, saveButton, unitSelect } from "./inventory-ui.js?v=14";
import { createOrderDocx, orderColumns } from "./inventory-docx.js?v=14";

function download(rows, date) {
  const blob = createOrderDocx(rows, formatPolishDate(date));
  const url = URL.createObjectURL(blob);
  const link = createElement("a");
  link.href = url;
  link.download = `zamowienie-${date}.docx`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function mountInventoryOrders(inventory, { db, firestore }) {
  const { collection, doc, setDoc, writeBatch, serverTimestamp } = firestore;
  const values = new Map();
  inventory.mount("orders", (container) => {
    const title = createElement("h2", "text-lg font-bold", "Zamówienia");
    const note = createElement("p", "text-sm", "Pobierz osobny plik Word i skopiuj zweryfikowane wiersze do oficjalnego rejestru.");
    const search = input("Szukaj pozycji poza ostrzeżeniami", "", "search");
    const candidates = createElement("div", "max-h-56 space-y-1 overflow-y-auto");
    const draft = panel();
    const history = details("Historia wygenerowanych zamówień");
    const status = createElement("p", "text-sm text-red-700");
    status.setAttribute("role", "status");
    const products = new Map(inventory.products());
    container.replaceChildren(title, note, field("Dodaj pozycję", search), candidates, draft, history);

    function ensureRow(id) {
      if (values.has(id)) return values.get(id);
      const lot = products.get(id);
      if (!lot) return null;
      const previous = inventory.lotsFor(id).filter((record) => record.packageAmount).sort((a, b) => b.timestamp - a.timestamp)[0];
      const order = { size: previous ? formatQuantity(previous.packageAmount, previous.packageUnit).replace(/\s+[^\s]+$/, "").replace(/\s/g, "") : "",
        unit: previous?.packageUnit || "", count: previous?.orderPackages || lot.orderPackages || 1, notes: "" };
      values.set(id, order);
      return order;
    }

    const renderCandidates = () => {
      candidates.replaceChildren();
      if (!search.value.trim()) return;
      for (const [id, product] of products) {
        const lots = inventory.lotsFor(id);
        if (!matchesInventorySearch(search.value, product.name, product.producer, product.cas, product.formula,
          ...lots.flatMap((lot) => [lot.group, lot.lotNumber]))) continue;
        const checkbox = createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = inventory.orderSelections.has(id);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) inventory.orderSelections.add(id);
          else inventory.orderSelections.delete(id);
          renderDraft();
        });
        candidates.append(field(`${product.name} · ${product.producer || product.group}${lots.some((lot) => lot.ordered) ? " · zamówiono" : ""}`, checkbox));
      }
    };

    function renderDraft() {
      draft.replaceChildren(createElement("h3", "font-bold", "Podgląd zamówienia"));
      const selections = [...inventory.orderSelections].filter((id) => products.has(id));
      if (!selections.length) draft.append(createElement("p", "text-sm", "Wybierz pozycję w ostrzeżeniach lub dodaj ją powyżej."));
      for (const id of selections) {
        const product = products.get(id);
        const current = ensureRow(id);
        const row = createElement("div", "grid gap-2 border-t pt-2 sm:grid-cols-2");
        const size = input("Wielkość opakowania", current.size);
        const unit = unitSelect(current.unit);
        const count = input("Sztuki opakowań", current.count, "number");
        const notes = input("Uwagi", current.notes);
        notes.maxLength = 300;
        size.addEventListener("input", () => { current.size = size.value; });
        unit.addEventListener("change", () => { current.unit = unit.value; });
        count.addEventListener("input", () => { current.count = count.value; });
        notes.addEventListener("input", () => { current.notes = notes.value; });
        const alreadyOrdered = inventory.lotsFor(id).some((lot) => lot.ordered);
        draft.append(createElement("p", "font-bold", `${product.name}${product.producer ? ` · ${product.producer}` : ""}${alreadyOrdered ? " · już oznaczona jako zamówiona" : ""}`));
        row.append(field("Wielkość opakowania", size), field("Jednostka", unit), field("Liczba opakowań", count),
          field("Uwagi", notes), button("Usuń pozycję z zamówienia", () => {
            inventory.orderSelections.delete(id);
            renderDraft();
            renderCandidates();
          }));
        draft.append(row);
      }
      const orderRef = doc(collection(db, "magazyn_zamowienia"));
      if (selections.length) draft.append(saveButton("Generuj dokument Word", async () => {
        if (selections.some((id) => inventory.lotsFor(id).some((lot) => lot.ordered))
          && !confirm("Zamówienie zawiera pozycje, które już oznaczono jako zamówione. Czy kontynuować?")) return;
        const lines = selections.map((id) => {
          const product = products.get(id);
          const current = ensureRow(id);
          const size = String(current.size).trim();
          const count = Number(current.count || 1);
          if (size && current.unit && (!Number.isInteger(count) || count < 1 || count > 10000)) throw new Error("Podaj liczbę opakowań od 1 do 10 000.");
          const amount = size && current.unit
            ? `${count > 1 ? `${count} × ` : ""}${formatQuantity(quantity(size, current.unit), current.unit)}` : "";
          const name = product.producer && !matchesInventorySearch(product.producer, product.name)
            ? `${product.name} ${product.producer}` : product.name;
          return { productId: id, name, amount, notes: current.notes.trim() };
        });
        const date = formatLocalDate();
        await setDoc(orderRef, { lines, date, status: "generated", createdAt: serverTimestamp() });
        download(lines, date);
        for (const id of selections) inventory.orderSelections.delete(id);
        renderDraft();
        renderCandidates();
        status.textContent = "Wygenerowano dokument. Oznaczenie jako zamówione jest dostępne w historii.";
      }, status));
      draft.append(status);
    }

    function renderOrders() {
      const orders = [...inventory.rows("orders")].sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      [...history.children].slice(1).forEach((child) => child.remove());
      for (const order of orders) {
        const card = details(`${formatPolishDate(order.date)} · ${order.status === "ordered" ? "Zamówiono" : "Wygenerowano"} · ${order.lines.length} poz.`);
        order.lines.forEach((line) => {
          const [, , name, amount] = orderColumns(line, "");
          card.append(createElement("p", "text-sm", [name, amount].filter(Boolean).join(" · ")));
        });
        card.append(button("Pobierz ponownie", () => download(order.lines, order.date)));
        if (order.status === "generated") {
          const message = createElement("p", "text-sm text-red-700");
          const choice = button("Oznacz jako zamówione", async () => {
            choice.disabled = true;
            try {
              const batch = writeBatch(db);
              const lots = order.lines.flatMap((line) => inventory.lotsFor(line.productId));
              if (lots.length > 499) throw new Error("Zamówienie obejmuje zbyt wiele partii do jednoczesnego oznaczenia.");
              for (const lot of lots) batch.update(doc(db, "odczynniki", lot.id), { ordered: true });
              batch.update(inventory.store.ref("orders", order.id), { status: "ordered", orderedAt: serverTimestamp() });
              await batch.commit();
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
