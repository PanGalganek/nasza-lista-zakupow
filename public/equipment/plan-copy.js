import { copyCandidates } from "./copy-model.js?v=38.1";
import { monthlyNames, validYear } from "./plan-model.js?v=38.1";

const get = id => document.getElementById("copy-" + id);
const collator = new Intl.Collator("pl", { numeric: true });

function labelCheck(text, className) {
  const label = document.createElement("label");
  label.className = className;
  const input = document.createElement("input");
  input.type = "checkbox";
  label.append(input);
  const title = document.createElement("span");
  title.textContent = text;
  label.append(title);
  return { label, input, title };
}

function grouped(terms, equipment) {
  const devices = new Map();
  for (const term of terms) {
    const device = equipment[term.deviceId];
    if (!devices.has(device.id)) devices.set(device.id, { device, activities: new Map() });
    const activities = devices.get(device.id).activities;
    if (!activities.has(term.activityId)) {
      activities.set(term.activityId, { activity: device.activities.find(row => row.id === term.activityId), terms: [] });
    }
    activities.get(term.activityId).terms.push(term);
  }
  return [...devices.values()].sort((a, b) => collator.compare(a.device.name, b.device.name) || collator.compare(a.device.number, b.device.number));
}

export function copyDialog(api, onCopied) {
  const { loadExecution, loadPlan, loadRegistry, savePlan } = api;
  const dialog = get("dialog");
  let openRun = 0;
  let previewRun = 0;
  let targetRun = 0;
  let targetTimer;
  let groups = [];
  let checks = [];
  let omitted = new Set();
  let preview, sourceYear, targetReady, operation;
  let busy = false;
  let checkingSources = false;

  function selection() {
    return checks.flatMap(group => group.rows.flatMap(row => omitted.has(row.key) ? [] : row.terms.map(term => term.id)));
  }

  function controls() {
    const count = selection().length;
    const total = checks.reduce((num, group) => num + group.rows.reduce((sum, row) => sum + row.terms.length, 0), 0);
    get("count").textContent = total ? "Wybrano " + count + " z " + total + " terminów" : "";
    get("save").disabled = busy || !preview || !targetReady || count === 0;
    get("source").disabled = busy || checkingSources || !get("source").value;
    get("target").disabled = get("reload").disabled = get("cancel").disabled = busy;
    for (const { input, rows } of checks) {
      const active = rows.filter(row => !omitted.has(row.key)).length;
      input.checked = active === rows.length;
      input.indeterminate = active > 0 && active < rows.length;
      input.disabled = busy;
      for (const row of rows) {
        row.input.checked = !omitted.has(row.key);
        row.input.disabled = busy;
      }
    }
  }

  function renderGroups() {
    checks = [];
    const nodes = groups.map(({ device, activities }) => {
      const field = document.createElement("fieldset");
      field.className = "entry copy-device";
      field.dataset.copyDevice = device.id;
      const name = document.createElement("legend");
      name.textContent = device.name + (device.number ? " · " + device.number : "");
      const { label, input } = labelCheck("Kopiuj urządzenie", "check");
      field.append(name, label);
      const rows = [...activities.values()].map(({ activity, terms }) => {
        const key = device.id + ":" + activity.id;
        const item = labelCheck(activity.kind + (activity.label ? " · " + activity.label : ""), "check copy-choice");
        item.input.dataset.copyActivity = activity.id;
        const months = document.createElement("small");
        months.textContent = terms.map(term => term.month).sort((a, b) => a - b).map(month => monthlyNames[month - 1].toLowerCase()).join(", ");
        item.title.append(months);
        item.input.onchange = () => {
          if (item.input.checked) omitted.delete(key);
          else omitted.add(key);
          controls();
        };
        field.append(item.label);
        return { key, terms, input: item.input };
      });
      input.onchange = () => {
        for (const row of rows) {
          if (input.checked) omitted.delete(row.key);
          else omitted.add(row.key);
        }
        controls();
      };
      checks.push({ input, rows });
      return field;
    });
    get("rows").replaceChildren(...nodes);
  }

  function setTargetStatus(text, error = false) {
    get("target-status").textContent = text;
    get("target-status").dataset.tone = error ? "error" : "";
  }

  async function checkTarget() {
    const year = Number(get("target").value);
    const run = ++targetRun;
    targetReady = false;
    controls();
    if (!validYear(sourceYear)) {
      setTargetStatus("");
      return;
    }
    if (!validYear(year) || year === sourceYear) {
      setTargetStatus(year === sourceYear ? "Wybierz inny rok docelowy niż źródłowy." : "Wprowadź poprawny rok docelowy.", true);
      return;
    }
    setTargetStatus("Sprawdzanie roku docelowego…");
    try {
      const target = await loadPlan(year);
      if (!dialog.open || run !== targetRun) return;
      targetReady = target.revision === 0 && !target.state.draft && !target.state.approved;
      setTargetStatus(targetReady ? "Rok docelowy jest pusty." : "W roku docelowym istnieje już harmonogram lub szkic.", !targetReady);
    } catch (error) {
      if (run === targetRun) setTargetStatus(error.message, true);
    }
    controls();
  }

  async function loadPreview() {
    const year = Number(get("source").value);
    const run = ++previewRun;
    if (sourceYear !== year) omitted.clear();
    sourceYear = year;
    preview = undefined;
    groups = [];
    renderGroups();
    controls();
    if (!validYear(year)) {
      get("rows").textContent = "Brak zatwierdzonych harmonogramów do skopiowania.";
      return;
    }
    get("rows").textContent = "Wczytywanie terminów…";
    try {
      const [plan, registry] = await Promise.all([loadPlan(year), loadRegistry()]);
      if (!dialog.open || run !== previewRun) return;
      groups = grouped(copyCandidates(plan.state.approved, registry.state.equipment), registry.state.equipment);
      preview = { sourceYear: year, sourceRevision: plan.revision, registryRevision: registry.revision };
      renderGroups();
      if (!groups.length) get("rows").textContent = "W zatwierdzonym planie nie ma terminów aktywnego sprzętu i czynności.";
    } catch (error) {
      if (run === previewRun) get("rows").textContent = error.message;
    }
    controls();
  }

  async function loadSources(preferred, resetTarget = false) {
    const run = ++openRun;
    previewRun++;
    preview = undefined;
    checkingSources = true;
    get("error").textContent = "";
    controls();
    try {
      const years = (await loadExecution()).map(plan => plan.year).reverse();
      if (!dialog.open || run !== openRun) return;
      get("source").replaceChildren(...years.map(year => new Option(year, year)));
      if (years.includes(preferred)) get("source").value = preferred;
      if (resetTarget) get("target").value = validYear(Number(get("source").value) + 1) ? Number(get("source").value) + 1 : "";
      checkingSources = false;
      await Promise.all([loadPreview(), checkTarget()]);
    } catch (error) {
      if (run !== openRun) return;
      checkingSources = false;
      get("error").textContent = error.message;
      controls();
    }
  }

  get("source").onchange = () => {
    get("error").textContent = "";
    loadPreview();
    checkTarget();
  };
  get("target").oninput = () => {
    clearTimeout(targetTimer);
    targetRun++;
    targetReady = false;
    get("error").textContent = "";
    controls();
    targetTimer = setTimeout(checkTarget, 200);
  };
  get("reload").onclick = () => loadSources(sourceYear);
  get("cancel").onclick = () => { if (!busy) dialog.close(); };
  dialog.oncancel = event => { if (busy) event.preventDefault(); };
  dialog.onclose = () => {
    openRun++;
    previewRun++;
    targetRun++;
    clearTimeout(targetTimer);
  };
  get("form").onsubmit = async event => {
    event.preventDefault();
    if (get("save").disabled) return;
    const target = Number(get("target").value);
    const command = { action: "copy", ...preview, selectedIds: selection() };
    const signature = JSON.stringify([target, command]);
    if (operation?.signature !== signature) operation = { signature, id: crypto.randomUUID() };
    busy = true;
    get("error").textContent = "";
    controls();
    try {
      const saved = await savePlan(target, 0, command, operation.id);
      dialog.close();
      onCopied(target, saved);
    } catch (error) {
      if (error.status === 409) {
        await checkTarget();
        if (targetReady) preview = undefined;
        else if (error.message.includes(get("target-status").textContent)) setTargetStatus("");
      }
      get("error").textContent = error.message;
    } finally {
      busy = false;
      controls();
    }
  };

  return {
    open(preferred) {
      groups = [];
      omitted = new Set();
      operation = preview = sourceYear = targetReady = undefined;
      get("target").value = "";
      get("source").replaceChildren();
      setTargetStatus("");
      renderGroups();
      dialog.showModal();
      loadSources(preferred, true);
    },
  };
}
