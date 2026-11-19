import React from "react";
import { createRoot } from "react-dom/client";
import Blocks from "./Blocks.jsx";
import SyncPanel from "./SyncPanel.jsx";
import "./index.css";

// The desktop app (desktop/): blocks and the devices they're shared with.
// desktop.html#blocked?… is the "Not now." screen shown over a blocked app.
function Main() {
  return (
    <div className="mx-auto max-w-xl px-5 pb-16 pt-8">
      <h1 className="font-display text-4xl">life</h1>
      <Blocks />
      <SyncPanel />
    </div>
  );
}

function until(iso) {
  if (!iso || iso.startsWith("9999")) return "";
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const t = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return sameDay ? `until ${t}` : `until ${d.toLocaleDateString(undefined, { weekday: "short" })} ${t}`;
}

function Blocked() {
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-8 text-center">
      <img src="/icon.svg" alt="" className="mb-8 h-24 w-24" />
      <h1 className="font-display text-6xl">Not now.</h1>
      <p className="mt-4 text-lg text-mute">
        {q.get("what") || "This"} is blocked by “{q.get("name") || "a block"}” {until(q.get("until"))}
      </p>
    </div>
  );
}

const blocked = location.hash.startsWith("#blocked");
createRoot(document.getElementById("root")).render(<React.StrictMode>{blocked ? <Blocked /> : <Main />}</React.StrictMode>);
// The blocked window is reused: re-render when it's pointed at another app.
window.addEventListener("hashchange", () => location.reload());
