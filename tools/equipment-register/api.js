
async function request(path, options) {
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.message ?? "Nie udało się otworzyć rejestru.");
    error.status = response.status;
    throw error;
  }
  return result;
}

export const loadRegistry = () => request("/registry.json");
export const loadPlan = year => request("/plans/" + year + ".json");
export const loadExecution = () => request("/execution.json");
export const loadExecutionHistory = year => request("/plans/" + year + "/history.json");
export const loadSource = () => request("/source.json");

function save(path, revision, command, operationId) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision, operationId, command }),
  });
}

export function saveRegistry(revision, command, operationId = crypto.randomUUID()) {
  return save("/registry.json", revision, command, operationId);
}

export function savePlan(year, revision, command, operationId) {
  return save("/plans/" + year + ".json", revision, command, operationId);
}
