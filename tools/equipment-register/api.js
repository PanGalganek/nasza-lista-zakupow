
async function request(options) {
  const response = await fetch("/registry.json", options);
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.message ?? "Nie udało się otworzyć rejestru.");
    error.status = response.status;
    throw error;
  }
  return result;
}

export const loadRegistry = () => request();

export function saveRegistry(revision, command, operationId = crypto.randomUUID()) {
  return request({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision, operationId, command }),
  });
}
