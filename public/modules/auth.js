import { byId } from "./ui.js";

export function createAuthModule({ auth, db, authApi, firestore, onAuthorized, onSignedOut, runSafely }) {
  const { browserLocalPersistence, onAuthStateChanged, setPersistence, signInWithEmailAndPassword, signOut } = authApi;
  const { doc, getDoc } = firestore;

  function setLoginError(message = "") {
    const errorBox = byId("loginError");
    errorBox.textContent = message;
    errorBox.classList.toggle("hidden", !message);
  }

  async function login() {
    setLoginError();
    const email = byId("loginEmail").value.trim();
    const password = byId("loginPassword").value;
    if (!email || !password) {
      setLoginError("Podaj adres e-mail i hasło.");
      return;
    }
    try {
      await setPersistence(auth, browserLocalPersistence);
      await signInWithEmailAndPassword(auth, email, password);
      byId("loginPassword").value = "";
    } catch (error) {
      console.error(error);
      setLoginError("Logowanie nie powiodło się. Sprawdź e-mail i hasło.");
    }
  }

  async function handleChange(user) {
    onSignedOut();
    if (!user) {
      byId("loginSection").classList.remove("hidden");
      byId("appSection").classList.add("hidden");
      return;
    }

    try {
      const access = await getDoc(doc(db, "app_users", user.uid));
      const accessData = access.exists() ? access.data() : null;
      if (!accessData || accessData.active !== true || !["admin", "operator"].includes(accessData.role)) {
        await signOut(auth);
        setLoginError("To konto nie ma dostępu do aplikacji.");
        return;
      }
    } catch (error) {
      console.error(error);
      await signOut(auth);
      setLoginError("Nie udało się potwierdzić dostępu do aplikacji.");
      return;
    }

    setLoginError();
    byId("loginSection").classList.add("hidden");
    byId("appSection").classList.remove("hidden");
    onAuthorized();
  }

  function bind() {
    byId("loginPassword").addEventListener("keydown", (event) => {
      if (event.key === "Enter") runSafely(login, "Logowanie nie powiodło się.");
    });
    onAuthStateChanged(auth, (user) => runSafely(() => handleChange(user), "Nie udało się uruchomić aplikacji."));
  }

  return { bind, login, logout: () => signOut(auth) };
}
