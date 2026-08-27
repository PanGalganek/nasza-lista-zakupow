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
  updateDoc,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { createAuthModule } from "./modules/auth.js";
import { createCalendarModule } from "./modules/calendar.js";
import { createChemicalsModule } from "./modules/chemicals.js";
import { createEquipmentModule } from "./modules/equipment.js";
import { createScheduleModule } from "./modules/schedule.js";
import { byId, runSafely } from "./modules/ui.js";

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
const firestore = { addDoc, collection, deleteDoc, doc, getDoc, onSnapshot, orderBy, query, updateDoc, writeBatch };
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
    alert(`Nie udało się zsynchronizować sekcji „${area}”. Odśwież stronę lub zaloguj się ponownie.`);
  }
}

const moduleDependencies = { db, firestore, registerSnapshot, reportListenerError };
const chemicals = createChemicalsModule(moduleDependencies);
const schedule = createScheduleModule(moduleDependencies);
const equipment = createEquipmentModule(moduleDependencies);
const calendar = createCalendarModule(moduleDependencies);

function startDataListeners() {
  clearSnapshots();
  chemicals.start();
  schedule.start();
  equipment.start();
  calendar.start();
}

function switchTab(target) {
  ["odczynniki", "woda", "scieki", "wzorcowanie", "kalendarz"].forEach((tab) => {
    const capitalized = tab.charAt(0).toUpperCase() + tab.slice(1);
    const isActive = tab === target;
    byId(`tabContent${capitalized}`)?.classList.toggle("hidden", !isActive);
    byId(`btn${capitalized}`)?.classList.toggle("active-tab", isActive);
    byId(`btn${capitalized}`)?.classList.toggle("text-gray-400", !isActive);
  });
  if (target === "kalendarz") calendar.render();
  if (target === "wzorcowanie") equipment.render();
}

const login = createAuthModule({
  auth,
  db,
  authApi,
  firestore,
  runSafely,
  onSignedOut: clearSnapshots,
  onAuthorized: () => {
    chemicals.initializeForm();
    startDataListeners();
  },
});

const delegatedActions = {
  login: () => login.login(),
  logout: () => login.logout(),
  "switch-tab": (button) => switchTab(button.dataset.tab),
  "switch-chemical-tab": (button) => chemicals.actions.switchSubTab(button.dataset.tab),
  "switch-task-tab": (button) => schedule.switchSubTab(button.dataset.lab, button.dataset.category),
  "add-form-row": () => chemicals.actions.addFormRow(),
  "save-items": () => chemicals.actions.saveItems(),
  "cancel-edit": () => chemicals.actions.cancelEdit(),
  "open-word-import": () => chemicals.actions.openImport(),
  "choose-word-file": () => chemicals.actions.chooseImportFile(),
  "close-word-import": () => chemicals.actions.closeImport(),
  "confirm-word-import": () => chemicals.actions.confirmImport(),
  "export-chemicals-csv": () => chemicals.actions.exportCsv(),
  "export-chemicals-json": () => chemicals.actions.exportJson(),
  "add-task": (button) => schedule.addTask(button.dataset.lab, button.dataset.category),
  "add-equipment": () => equipment.save(),
  "cancel-equipment-edit": () => equipment.cancelEdit(),
  "change-month": (button) => calendar.changeMonth(Number(button.dataset.offset)),
  "add-event": () => calendar.addEvent(),
};

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  const action = button && delegatedActions[button.dataset.action];
  if (action) runSafely(() => action(button), "Nie udało się wykonać operacji.");
});

chemicals.bind();
login.bind();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Service worker nie został uruchomiony.", error));
}
