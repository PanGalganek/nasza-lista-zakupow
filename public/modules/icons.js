const paths = {
  flask: "M9 3h6M10 3v7l-5.5 8.5A1.5 1.5 0 0 0 6 21h12a1.5 1.5 0 0 0 1.5-2.5L14 10V3M7 15h10",
  drop: "M12 3c3 4.4 7 7.2 7 11a7 7 0 1 1-14 0c0-3.8 4-6.6 7-11Z M8 15a4 4 0 0 0 4 4",
  waves: "M3 7c2 0 2.5-2 4.5-2s2.5 2 4.5 2 2.5-2 4.5-2 2.5 2 4.5 2M3 12c2 0 2.5-2 4.5-2s2.5 2 4.5 2 2.5-2 4.5-2 2.5 2 4.5 2M3 17c2 0 2.5-2 4.5-2s2.5 2 4.5 2 2.5-2 4.5-2 2.5 2 4.5 2",
  equipment: "M4 6h16v12H4zM8 6v4m4-4v6m4-6v4M8 15h8",
  calendar: "M4 6h16v15H4zM8 3v6m8-6v6M4 11h16m-12 4h2m3 0h3m-8 3h2",
  home: "m3 10 9-7 9 7M5 9v11h5v-6h4v6h5V9",
  bottle: "M10 3h4v4l3 3v10H7V10l3-3zM10 5h4M7 13h10",
  target: "M12 3a9 9 0 1 0 9 9 9 9 0 0 0-9-9Zm0 4a5 5 0 1 0 5 5 5 5 0 0 0-5-5Zm0 4v2",
  tubes: "M4 4h6m-5 0v13a2 2 0 1 0 4 0V4m5 0h6m-5 0v9a2 2 0 1 0 4 0V4M5 11h4m6-1h4",
  book: "M4 5h6a4 4 0 0 1 4 4v11a4 4 0 0 0-4-4H4zM14 9a4 4 0 0 1 4-4h2v11h-2a4 4 0 0 0-4 4",
  arrows: "M4 8h15m-4-4 4 4-4 4m5 4H5m4-4-4 4 4 4",
  calc: "M6 3h12v18H6zM9 7h6m-6 5h1m4 0h1m-6 4h1m4 0h1",
  cart: "M3 4h2l2 11h11l2-7H6m3 11h.1m7 0h.1",
  document: "M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6",
  chart: "M4 4v16h16M8 16v-4m4 4V8m4 8v-6",
  archive: "M4 4h16v5H4zM6 9v11h12V9m-8 4h4",
  bell: "M6 10a6 6 0 0 1 12 0v5l2 2H4l2-2Zm4 10a2 2 0 0 0 4 0",
  back: "m14 6-6 6 6 6M8 12h12",
  chevron: "m10 6 6 6-6 6",
  next: "m10 6 6 6-6 6",
  search: "M11 4a7 7 0 1 0 7 7 7 7 0 0 0-7-7Zm5 12 4 4",
  filters: "M4 7h16M4 12h16M4 17h16M8 5v4m8 1v4m-6 1v4",
  plus: "M12 5v14M5 12h14",
  close: "m6 6 12 12M18 6 6 18",
  edit: "m5 15-1 5 5-1L20 8l-4-4ZM14 6l4 4",
  check: "m5 12 4 4L19 6",
  square: "M5 5h14v14H5z",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5",
  logout: "M11 4H5v16h6m2-12 5 4-5 4m-4-4h9",
  wifi: "M3 8a14 14 0 0 1 18 0M6 12a9 9 0 0 1 12 0m-9 4a4 4 0 0 1 6 0m-3 4h.01",
  star: "m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.4-5.7-3-5.7 3 1.1-6.4-4.6-4.5 6.4-.9Z",
};

export function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", "lab-icon");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", paths[name] || paths.flask);
  svg.append(path);
  return svg;
}

export function fillIcons(root = document) {
  for (const element of root.querySelectorAll("[data-icon]")) element.replaceChildren(icon(element.dataset.icon));
}
