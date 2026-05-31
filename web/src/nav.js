// Minimal in-app navigation (no full reload) so fullscreen survives view changes.
export function navigate(to) {
  const norm = (p) => p.replace(/\/+$/, "");
  if (norm(to) === norm(window.location.pathname)) return;
  window.history.pushState({}, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
