import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import Dashboard from "./Dashboard.jsx";
import "./index.css"; // Tailwind + Flowbite

const path = window.location.pathname.replace(/\/+$/, "");
const isDashboard = path === "/dashboard";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>{isDashboard ? <Dashboard /> : <App />}</React.StrictMode>
);
