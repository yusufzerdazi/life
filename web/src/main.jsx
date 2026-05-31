import React, { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import Dashboard from "./Dashboard.jsx";
import BedPrompt from "./BedPrompt.jsx";
import "./index.css"; // Tailwind + Flowbite

const subscribe = (cb) => {
  window.addEventListener("popstate", cb);
  return () => window.removeEventListener("popstate", cb);
};
const getPath = () => window.location.pathname.replace(/\/+$/, "");

function Root() {
  const path = useSyncExternalStore(subscribe, getPath);
  if (path === "/dashboard") return <Dashboard />;
  if (path === "/bed") return <BedPrompt />;
  return <App />;
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
