import { compatibleUnits, maxQuantity, units, validLots } from "./inventory-quantity.js?v=25";
import { chemicalCategory, formatLocalDate } from "../utils.js?v=25";
import { orderLineProgress, orderPackageCount, standardKind } from "./inventory-items.js?v=25";

export const inventoryCollections = {
  stock: "magazyn_partie",
  events: "magazyn_operacje",
  recipes: "magazyn_receptury",
  methods: "magazyn_metody",
  orders: "magazyn_zamowienia",
  calculations: "magazyn_obliczenia",
};

const maxLotsPerTransaction = 8;
export const productId = (lot) => lot.productId || lot.id;

export function openingSource(event) {
  if (event?.kind === "opening_correction") return event.details?.sourceKind;
  if (["opening", "receipt"].includes(event?.kind)) return event.kind;
  return "";
}

export function requireInventoryConnection() {
  if (globalThis.navigator?.onLine === false) {
    throw new Error("Brak połączenia. Zapis nie został wysłany. Połącz się z internetem i ponów.");
  }
}

export function createInventoryStore(db, firestore) {
  const { collection, doc, runTransaction, serverTimestamp } = firestore;
  const ref = (key, id) => doc(db, inventoryCollections[key], id);
  const lotRef = (id) => doc(db, "odczynniki", id);

  function operationId() {
    return doc(collection(db, inventoryCollections.events)).id;
  }

  async function transact(id, payload, write) {
    requireInventoryConnection();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload)));
    const intent = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const wasCommitted = (snapshot) => {
      if (!snapshot.exists()) return false;
      if (snapshot.data().details.intent !== intent) {
        throw new Error("Wcześniejszy zapis ma inne dane. Sprawdź historię i aktualny stan przed kolejną operacją.");
      }
      return true;
    };
    try {
      return await runTransaction(db, async (transaction) => {
        if (!wasCommitted(await transaction.get(ref("events", id)))) return write(transaction, intent);
      });
    } catch (error) {
      if (!["permission-denied", "aborted", "already-exists"].includes(error.code)) throw error;
      const committed = await runTransaction(db, (transaction) => transaction.get(ref("events", id)));
      if (!wasCommitted(committed)) throw error;
    }
  }

  async function readRoots(transaction, ids, sourceId = "") {
    return Promise.all([...new Set(ids.filter(Boolean))].map(async (id) => {
      const root = await transaction.get(lotRef(id));
      if (id === sourceId || !root.exists() || productId({ id, ...root.data() }) !== id) {
        throw new Error("Wybierz główną pozycję handlową w rejestrze.");
      }
      return root;
    }));
  }

  function reserveRoots(transaction, roots) {
    for (const root of roots) {
      if (!root.data().productId) transaction.update(root.ref, { productId: root.id });
    }
  }

  async function linkLot(id, fields) {
    requireInventoryConnection();
    return runTransaction(db, async (transaction) => {
      const roots = await readRoots(transaction, [fields.productId], id);
      reserveRoots(transaction, roots);
      transaction.update(lotRef(id), fields);
    });
  }

  function writeOperation(transaction, id, kind, changes, details) {
    const anchor = Object.keys(changes)[0];
    transaction.set(ref("events", id), { kind, anchor, changes, details, createdAt: serverTimestamp() });
    for (const [lotId, change] of Object.entries(changes)) {
      transaction.set(ref("stock", lotId), {
        initial: change.initial, balance: change.after, unit: change.unit, status: change.status, lastEvent: id,
      });
    }
  }

  function line(lot, unit, initial, before, after, status) {
    return { productId: productId(lot), number: lot.lotNumber || "", name: lot.name, unit, initial, before, after, status };
  }

  async function receive(items, id = operationId(), delivery = null) {
    const lots = items.map(({ fields, initial }) => ({ initial, fields, document: doc(collection(db, "odczynniki")) }));
    checkSize(lots.length);
    const payload = items.map(({ fields, initial }) => [{ ...fields, timestamp: 0 }, initial]);
    if (delivery && lots.length !== 1) throw new Error("Powiązana dostawa obejmuje jedno przyjmowane opakowanie.");
    // Zachowaj identyfikator zamiaru dla rozpoczętych zapisów w starszej wersji.
    const intentPayload = delivery ? ["receipt", payload, delivery] : ["receipt", payload];
    return transact(id, intentPayload, async (transaction, intent) => {
      const roots = await readRoots(transaction, lots.map(({ fields }) => fields.productId));
      let linkedDelivery;
      if (delivery) {
        const { orderId, lineIndex, kind } = delivery;
        const orderRef = ref("orders", orderId);
        const order = (await transaction.get(orderRef)).data();
        const row = order?.lines?.[lineIndex];
        const lot = lots[0].fields;
        const progress = orderLineProgress(order || {}, lineIndex);
        if (order?.status !== "ordered" || !row || progress.complete
          || standardKind(lot) !== kind || (row.standardKind && kind && row.standardKind !== kind)) {
          throw new Error("Wybrana pozycja zamówienia jest już rozliczona lub dotyczy innego produktu. Otwórz formularz ponownie.");
        }
        if (row.productId !== lot.productId) {
          const previous = (await transaction.get(lotRef(row.productId))).data();
          const root = roots[0].data();
          const originalGroup = previous?.group?.split("/")[0];
          if (!previous || previous.productId || previous.name !== root.name || !originalGroup || originalGroup !== root.group.split("/")[0]
            || chemicalCategory(previous) !== chemicalCategory(root) || standardKind(previous) !== standardKind(root)
            || ["producer", "formula", "cas", "orderDescription"].some((field) => previous[field] && root[field] && previous[field] !== root[field])) {
            throw new Error("Wybrane zamówienie dotyczy innego wariantu produktu.");
          }
        }
        const expected = orderPackageCount(row);
        const received = progress.received + 1;
        if (expected !== null && received > expected) throw new Error("Dostawa przekracza liczbę zamówionych opakowań.");
        const complete = expected === null ? delivery.complete === true : received === expected;
        linkedDelivery = { orderId, lineIndex, complete };
        transaction.update(orderRef, {
          deliveries: { ...order.deliveries, [lineIndex]: { received, complete } },
          lastReceipt: id,
        });
      }
      reserveRoots(transaction, roots);
      const changes = {};
      for (const { fields, document, initial } of lots) {
        const lot = { ...fields, id: document.id };
        transaction.set(document, { ...fields, productId: productId(lot) });
        changes[lot.id] = line(lot, fields.packageUnit, initial, 0, initial, "active");
      }
      writeOperation(transaction, id, "receipt", changes, { intent, ...(linkedDelivery && { delivery: linkedDelivery }) });
    });
  }

  async function establish(lotId, initial, unit, id = operationId()) {
    if (!Number.isSafeInteger(initial) || initial < 0 || initial > maxQuantity || !units[unit]) throw new Error("Nieprawidłowy stan początkowy.");
    return transact(id, ["opening", lotId, initial, unit], async (transaction, intent) => {
      const [batch, stock] = await Promise.all([transaction.get(lotRef(lotId)), transaction.get(ref("stock", lotId))]);
      if (!batch.exists() || stock.exists()) throw new Error("Stan tej partii został już ustalony lub partia jest niedostępna.");
      if (batch.data().packageUnit && !compatibleUnits(batch.data().packageUnit, unit)) throw new Error("Jednostka stanu jest niezgodna z jednostką opakowania.");
      writeOperation(transaction, id, "opening", { [lotId]: line({ ...batch.data(), id: lotId }, unit, initial, initial, initial, "active") }, { intent });
    });
  }

  async function correctOpening(lotId, initial, previousId, id = operationId()) {
    if (!Number.isSafeInteger(initial) || initial < 0 || initial > maxQuantity) throw new Error("Nieprawidłowa ilość początkowa.");
    return transact(id, ["opening_correction", lotId, initial, previousId], async (transaction, intent) => {
      const [batch, state] = await Promise.all([transaction.get(lotRef(lotId)), transaction.get(ref("stock", lotId))]);
      const stock = state.data();
      if (!batch.exists() || stock?.status !== "active" || stock.lastEvent !== previousId || stock.balance !== stock.initial) {
        throw new Error("Stan partii uległ zmianie. Otwórz jej kartę ponownie.");
      }
      const previous = await transaction.get(ref("events", previousId));
      const sourceKind = openingSource(previous.data());
      if (!sourceKind) throw new Error("Korekta ilości początkowej jest dostępna tylko przed pierwszym rozchodem.");
      const lot = { ...batch.data(), id: lotId };
      if (sourceKind === "receipt" && (!compatibleUnits(stock.unit, lot.packageUnit) || initial === 0 || initial > lot.packageAmount)) {
        throw new Error("Ilość przyjęta musi być większa od zera i mieścić się w podanej wielkości opakowania.");
      }
      if (initial === stock.initial) throw new Error("Podaj inną ilość niż aktualnie zapisana.");
      writeOperation(transaction, id, "opening_correction", {
        [lotId]: line(lot, stock.unit, initial, stock.balance, initial, "active"),
      }, { intent, previousId, sourceKind });
    });
  }

  async function withdraw(requests, { id = operationId(), preparation = null } = {}) {
    const quantities = new Map();
    for (const request of requests) {
      const existing = quantities.get(request.lotId);
      if (!Number.isSafeInteger(request.quantity) || request.quantity <= 0 || !units[request.unit]
        || (existing && (!compatibleUnits(request.unit, existing.unit) || existing.productId !== request.productId))) {
        throw new Error("Nieprawidłowa ilość lub jednostka pobrania.");
      }
      quantities.set(request.lotId, { ...request, quantity: request.quantity + (existing?.quantity || 0) });
    }
    if (quantities.size === 0 && !preparation) throw new Error("Wybierz partię.");
    if (quantities.size) checkSize(quantities.size);
    return transact(id, ["withdraw", [...quantities.entries()].sort(([a], [b]) => a.localeCompare(b)), preparation], async (transaction, intent) => {
      const changes = {};
      const snapshots = await Promise.all([...quantities.keys()].map(async (lotId) => {
        const [lot, stock] = await Promise.all([transaction.get(lotRef(lotId)), transaction.get(ref("stock", lotId))]);
        return { lotId, lot, stock };
      }));
      for (const { lotId, lot: item, stock: state } of snapshots) {
        const lot = { ...item.data(), id: lotId, stock: state.data() };
        const amount = quantities.get(lotId);
        if (!item.exists() || productId(lot) !== amount.productId || !validLots([lot], amount.unit, formatLocalDate()).length
          || lot.stock.balance < amount.quantity) throw new Error("Stan lub dostępność partii uległy zmianie. Sprawdź partie i ponów operację.");
        changes[lotId] = line(lot, lot.stock.unit, lot.stock.initial, lot.stock.balance, lot.stock.balance - amount.quantity, "active");
      }
      if (quantities.size === 0) {
        transaction.set(ref("events", id), {
          kind: "preparation", anchor: "", changes: {}, details: { ...preparation, intent }, createdAt: serverTimestamp(),
        });
      } else {
        writeOperation(transaction, id, preparation ? "preparation" : "withdrawal", changes, { ...preparation, intent });
      }
    });
  }

  async function close(lotId, status, id = operationId()) {
    if (!["used", "withdrawn"].includes(status)) throw new Error("Nieprawidłowy status partii.");
    return transact(id, ["close", lotId, status], async (transaction, intent) => {
      const [batch, state] = await Promise.all([transaction.get(lotRef(lotId)), transaction.get(ref("stock", lotId))]);
      const stock = state.data();
      if (!batch.exists() || (stock && stock.status !== "active")) throw new Error("Partia nie jest aktywna.");
      const lot = { ...batch.data(), id: lotId };
      if (status === "used" && lot.expiry && lot.expiry < formatLocalDate()) throw new Error("Przeterminowaną partię wycofaj.");
      writeOperation(transaction, id, status, {
        [lotId]: line(lot, stock?.unit ?? "", stock?.initial ?? null, stock?.balance ?? null, stock ? 0 : null, status),
      }, { intent });
    });
  }

  async function reverse(originalId) {
    const id = `reverse_${originalId}`;
    return transact(id, ["reverse", originalId], async (transaction, intent) => {
      const original = await transaction.get(ref("events", originalId));
      const event = original.data();
      if (!event || !["withdrawal", "preparation"].includes(event.kind)) throw new Error("Tej operacji nie można cofnąć.");
      const rows = Object.entries(event.changes);
      if (!rows.length) {
        transaction.set(ref("events", id), {
          kind: "reversal", anchor: "", changes: {}, details: { originalId, intent }, createdAt: serverTimestamp(),
        });
        return;
      }
      checkSize(rows.length);
      const snapshots = await Promise.all(rows.map(async ([lotId, change]) => {
        const [stock, chemical] = await Promise.all([transaction.get(ref("stock", lotId)), transaction.get(lotRef(lotId))]);
        return [lotId, change, stock.data(), chemical.data()];
      }));
      const changes = {};
      for (const [lotId, change, stock, chemical] of snapshots) {
        if (!stock || !chemical || stock.status !== "active") throw new Error("Operacja dotyczy zamkniętej partii.");
        const after = stock.balance + change.before - change.after;
        if (after > stock.initial) throw new Error("Cofnięcie przekroczyłoby stan początkowy.");
        changes[lotId] = line({ ...chemical, id: lotId }, stock.unit, stock.initial, stock.balance, after, stock.status);
      }
      writeOperation(transaction, id, "reversal", changes, { originalId, intent });
    });
  }

  function checkSize(size) {
    if (size < 1 || size > maxLotsPerTransaction) throw new Error(`Jedna operacja może objąć najwyżej ${maxLotsPerTransaction} partii.`);
  }

  return { ref, receive, establish, correctOpening, withdraw, close, reverse, operationId, linkLot };
}
