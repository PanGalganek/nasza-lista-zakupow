const activitySeparator = "\u001e";
const fieldSeparator = "\u001f";

export function encodeActivities(activities) {
  return activities.map(({ id, kind, label, active }, index) => {
    if (id !== "a" + (index + 1) || /[\u001e\u001f\r\n]/.test(kind + label)) {
      throw new Error("Nieprawidłowy zapis czynności urządzenia.");
    }
    return [kind, label, active ? "1" : "0"].join(fieldSeparator);
  }).join(activitySeparator);
}

export function decodeActivities(value) {
  return value ? value.split(activitySeparator).map((item, index) => {
    const [kind, label, active] = item.split(fieldSeparator);
    return { id: "a" + (index + 1), kind, label, active: active === "1" };
  }) : [];
}
