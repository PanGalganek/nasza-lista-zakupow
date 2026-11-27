import test from "node:test";
import assert from "node:assert/strict";
import { createChemicalsModule } from "../public/modules/chemicals.js";

class Element extends EventTarget {
  children = [];
  dataset = {};
  className = "";
  classList = { add() {}, remove() {}, toggle() {} };
  value = "";
  disabled = false;
  get options() { return this.children; }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  scrollIntoView() {}
  focus() {}

  find(predicate) {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const descendant = child.find(predicate);
      if (descendant) return descendant;
    }
  }

  querySelector(selector) {
    return this.find((child) => child.className.split(" ").includes(selector.slice(1)));
  }
}

function setup(t, commit = async () => {}, fixture) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  globalThis.document = {
    getElementById: element,
    createElement: () => new Element(),
    createTextNode: () => new Element(),
    querySelector: () => null,
  };
  t.after(() => { delete globalThis.document; });

  const item = { name: "Wzorzec", category: "Wzorce", group: "II-4/31", received: "2026-01-01" };
  let receiveSnapshot;
  const refresh = (items) => receiveSnapshot({ docs: items.map(({ id, ...fields }) => ({ id, data: () => fields })) });
  const calls = { creates: [], updates: [] };
  const module = createChemicalsModule({
    db: {},
    firestore: {
      collection: (_db, name) => name,
      doc: (...path) => path.at(-1),
      orderBy: () => {},
      query: () => {},
      onSnapshot: (_query, receive) => {
        receiveSnapshot = receive;
        refresh(fixture || [{ ...item, id: "existing" }]);
      },
      updateDoc: async (id, fields) => calls.updates.push({ id, fields }),
      writeBatch: () => ({
        set: (_id, fields) => calls.creates.push(fields),
        commit,
      }),
    },
    registerSnapshot: () => {},
    reportListenerError: () => {},
  });
  module.initializeForm();
  module.bind();
  module.start();

  const choose = (option) => {
    const picker = element("chemicalPosition");
    picker.value = option.value;
    picker.dispatchEvent(new Event("change"));
  };
  return {
    module,
    calls,
    submit: element("submitBtn"),
    element, choose, refresh,
    edit: () => {
      choose(element("chemicalPosition").options[1]);
      element("chemicalListGrouped").find((child) => child.title === "Edytuj pozycję").dispatchEvent(new Event("click"));
    },
    name: () => element("dynamicItemsContainer").querySelector(".chem-name"),
  };
}

test("a new session clears an unfinished edit before saving a new chemical", async (t) => {
  const { module, calls, edit, name } = setup(t);
  edit();
  module.initializeForm();
  name().value = "Nowy odczynnik";

  await module.actions.saveItems();

  assert.deepEqual(calls.updates, []);
  assert.equal(calls.creates.length, 1);
  assert.equal(calls.creates[0].name, "Nowy odczynnik");
});

test("registry filters the LP choices but opens the whole selected product and preserves it on refresh", (t) => {
  const chemical = (id, group, lotNumber) => ({ id, name: "Wzorzec żelaza", category: "Wzorce", group, lotNumber });
  const first = chemical("first", "II-2/26", "LOT-PODSTAWOWA");
  const second = chemical("second", "II-10/26", "LOT-A");
  const third = chemical("third", "II-10/27", "LOT-B");
  const { element, choose, refresh } = setup(t, undefined, [second, first, third]);
  const picker = element("chemicalPosition");
  const products = () => element("chemicalListGrouped").children.filter(({ className }) => className.includes("lab-product"));
  assert.deepEqual(picker.options.slice(1).map(({ textContent }) => textContent), [
    "LP 1 · II-2/26 · Wzorzec żelaza", "LP 2 · II-10 · Wzorzec żelaza",
  ]);
  assert.equal(products().length, 0);
  const input = element("chemicalSearch");
  input.value = "LOT-B";
  input.dispatchEvent(new Event("input"));
  assert.equal(picker.options.length, 2);
  choose(picker.options[1]);
  assert.equal(products().length, 1);
  assert.equal(products()[0].children.filter(({ className }) => className.includes("lab-lot")).length, 2);
  input.value = "LP 1";
  input.dispatchEvent(new Event("input"));
  assert.ok(picker.options[1].disabled);
  assert.match(picker.options[2].textContent, /^LP 1/);
  assert.equal(products()[0].children.filter(({ className }) => className.includes("lab-lot")).length, 2);
  refresh([third, second, first]);
  assert.equal(products().length, 1);
  choose(picker.options[2]);
  assert.equal(products()[0].children.filter(({ className }) => className.includes("lab-lot")).length, 1);
  element("clearChemicalPosition").dispatchEvent(new Event("click"));
  assert.equal(products().length, 0);
  assert.equal(input.value, "LP 1");
});

test("editing preserves the document category after switching tabs", async (t) => {
  const { module, calls, edit, name } = setup(t);
  edit();
  module.actions.switchSubTab("Odczynniki");
  name().value = "Nowa nazwa wzorca";

  await module.actions.saveItems();

  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].id, "existing");
  assert.equal(calls.updates[0].fields.name, "Nowa nazwa wzorca");
  assert.equal(calls.updates[0].fields.category, "Wzorce");
});

test("a repeated save while the first write is pending adds only one chemical", async (t) => {
  const pending = Promise.withResolvers();
  const { module, calls, submit, name } = setup(t, () => pending.promise);
  name().value = "Jedna pozycja";

  const first = module.actions.saveItems();
  const second = module.actions.saveItems();
  assert.equal(submit.disabled, true);
  pending.resolve();
  await Promise.all([first, second]);

  assert.equal(calls.creates.length, 1);
  assert.equal(submit.disabled, false);
});

test("a failed write preserves the form and allows another save", async (t) => {
  const commit = t.mock.fn(async () => { throw new Error("Zapis nieudany"); });
  const { module, submit, name } = setup(t, commit);
  name().value = "Pozycja do ponowienia";

  await assert.rejects(module.actions.saveItems(), /Zapis nieudany/);

  assert.equal(submit.disabled, false);
  assert.equal(name().value, "Pozycja do ponowienia");
  commit.mock.mockImplementation(async () => {});
  await module.actions.saveItems();
  assert.equal(commit.mock.callCount(), 2);
  assert.equal(name().value, "");
});
