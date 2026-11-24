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

function setup(t, commit = async () => {}) {
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
  const calls = { creates: [], updates: [] };
  const module = createChemicalsModule({
    db: {},
    firestore: {
      collection: (_db, name) => name,
      doc: (...path) => path.at(-1),
      orderBy: () => {},
      query: () => {},
      onSnapshot: (_query, receive) => receive({ docs: [{ id: "existing", data: () => item }] }),
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
  module.start();

  return {
    module,
    calls,
    submit: element("submitBtn"),
    edit: () => element("chemicalListGrouped").find((child) => child.title === "Edytuj pozycję").dispatchEvent(new Event("click")),
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
