import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import {
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { createAuthModule } from "./modules/auth.js?v=33";
import { createCalendarModule } from "./modules/calendar.js?v=33";
import { createChemicalsModule } from "./modules/chemicals.js?v=33";
import { createEquipmentModule } from "./modules/equipment.js?v=33";
import { createInventoryModule } from "./modules/inventory-ui.js?v=33";
import { mountInventoryHistory } from "./modules/inventory-history.js?v=33";
import { mountInventoryStatistics } from "./modules/inventory-statistics.js?v=33";
import { mountInventoryRecipes } from "./modules/inventory-recipes.js?v=33";
import { mountInventoryTheory } from "./modules/inventory-theory.js?v=33";
import { mountInventoryOrders } from "./modules/inventory-orders.js?v=33";
import { createScheduleModule } from "./modules/schedule.js?v=33";
import { byId, notify, runSafely } from "./modules/ui.js?v=33";
import { bindShell, buildShell, renderShell, syncFilters } from "./modules/shell.js?v=33";
import { createNavigation } from "./modules/navigation.js?v=33";

const firebaseConfig = {
  apiKey: "AIzaSyANS8FT-mgc8D1kR-WXlhzjEvufveMMeM8",
  authDomain: "nasza-lista-zakupow.firebaseapp.com",
  projectId: "nasza-lista-zakupow",
  storageBucket: "nasza-lista-zakupow.firebasestorage.app",
  messagingSenderId: "516283526174",
  appId: "1:516283526174:web:f42c9c38333e821da5520f",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const firestore = { addDoc, collection, deleteDoc, doc, getDoc, onSnapshot, orderBy, query, runTransaction, serverTimestamp, setDoc, updateDoc, writeBatch };
const authApi = { browserLocalPersistence, onAuthStateChanged, setPersistence, signInWithEmailAndPassword, signOut };
let snapshotUnsubscribers = [];
const reportedListenerErrors = new Set();

function registerSnapshot(unsubscribe) {
  snapshotUnsubscribers.push(unsubscribe);
}

function clearSnapshots() {
  snapshotUnsubscribers.forEach((unsubscribe) => unsubscribe());
  snapshotUnsubscribers = [];
  reportedListenerErrors.clear();
}

function reportListenerError(area, error) {
  console.error(`Błąd synchronizacji: ${area}`, error);
  if (!reportedListenerErrors.has(area)) {
    reportedListenerErrors.add(area);
    notify(`Nie udało się zsynchronizować sekcji „${area}”. Odśwież stronę lub zaloguj się ponownie.`, true);
  }
}

buildShell();
const navigation = createNavigation((route, viewState) => renderShell(route, { inventory, chemicals, schedule, equipment, calendar }, viewState));
const moduleDependencies = { db, firestore, registerSnapshot, reportListenerError, navigation };
const inventory = createInventoryModule(moduleDependencies);
mountInventoryHistory(inventory);
mountInventoryStatistics(inventory);
mountInventoryRecipes(inventory, moduleDependencies);
mountInventoryTheory(inventory, moduleDependencies);
mountInventoryOrders(inventory, moduleDependencies);
const chemicals = createChemicalsModule({ ...moduleDependencies, inventory });
const schedule = createScheduleModule(moduleDependencies);
const equipment = createEquipmentModule(moduleDependencies);
const calendar = createCalendarModule(moduleDependencies);

function startDataListeners() {
  clearSnapshots();
  inventory.start();
  chemicals.start();
  schedule.start();
  equipment.start();
  calendar.start();
}

const login = createAuthModule({
  auth,
  db,
  authApi,
  firestore,
  runSafely,
  onSignedOut: () => { clearSnapshots(); navigation.stop(); },
  onAuthorized: () => {
    chemicals.initializeForm();
    startDataListeners();
    navigation.start();
  },
});

const delegatedActions = {
  login: () => login.login(),
  logout: () => login.logout(),
  "go-back": () => navigation.back(),
  "close-dialog": () => navigation.close(),
  "open-chemical-form": () => chemicals.actions.openForm(),
  "open-equipment-form": () => equipment.openForm(),
  "open-event-form": () => calendar.openForm(),
  "toggle-filters": (button) => {
    const filter = byId("chemicalFilters");
    filter.hidden = !filter.hidden;
    button.setAttribute("aria-expanded", String(!filter.hidden));
  },
  "clear-filters": () => {
    byId("chemicalStatusFilter").selectedIndex = 0;
    byId("chemicalSort").selectedIndex = 0;
    byId("chemicalStatusFilter").dispatchEvent(new Event("change"));
    syncFilters();
  },
  "add-form-row": () => chemicals.actions.addFormRow(),
  "save-items": () => chemicals.actions.saveItems(),
  "cancel-edit": () => navigation.close(),
  "add-task": (button) => schedule.addTask(button.dataset.lab, button.dataset.category),
  "add-equipment": () => equipment.save(),
  "cancel-equipment-edit": () => navigation.close(),
  "change-month": (button) => calendar.changeMonth(Number(button.dataset.offset)),
  "add-event": () => calendar.addEvent(),
};

document.addEventListener("click", (event) => {
  if (event.target.closest(".lab-skip") && !byId("appSection").classList.contains("hidden")) {
    event.preventDefault();
    byId("mainContent").focus();
    return;
  }
  const route = event.target.closest("[data-route]")?.dataset.route;
  if (route) navigation.go(route);
  const button = event.target.closest("[data-action]");
  const action = button && delegatedActions[button.dataset.action];
  if (action) runSafely(() => action(button), "Nie udało się wykonać operacji.");
});
document.addEventListener("submit", (event) => {
  const action = delegatedActions[event.target.dataset.submitAction];
  if (!action) return;
  event.preventDefault();
  runSafely(() => action(event.target), "Nie udało się wykonać operacji.");
});

chemicals.bind();
bindShell();
login.bind();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).catch((error) => console.warn("Service worker nie został uruchomiony.", error));
}
