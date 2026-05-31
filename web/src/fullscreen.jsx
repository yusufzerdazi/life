import { useEffect, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";

const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;

export function enterFullscreen() {
  const el = document.documentElement;
  const fn = el.requestFullscreen || el.webkitRequestFullscreen;
  if (fn) Promise.resolve(fn.call(el)).catch(() => {});
}
export function exitFullscreen() {
  const fn = document.exitFullscreen || document.webkitExitFullscreen;
  if (fn && fsElement()) Promise.resolve(fn.call(document)).catch(() => {});
}

// Tracks fullscreen state and enters on the first user tap (browsers block
// auto-enter on load, so this needs a gesture).
export function useFullscreen() {
  const [fs, setFs] = useState(!!fsElement());
  useEffect(() => {
    const onChange = () => setFs(!!fsElement());
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    const onFirst = (e) => {
      if (e.target?.closest?.("[data-fs-btn]")) return; // the button toggles itself
      if (!fsElement()) enterFullscreen();
      document.removeEventListener("pointerdown", onFirst);
    };
    document.addEventListener("pointerdown", onFirst);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
      document.removeEventListener("pointerdown", onFirst);
    };
  }, []);
  return { fs, toggle: () => (fsElement() ? exitFullscreen() : enterFullscreen()) };
}

export function FullscreenButton({ fs, toggle, className = "" }) {
  return (
    <button
      data-fs-btn
      onClick={toggle}
      aria-label={fs ? "Exit fullscreen" : "Enter fullscreen"}
      className={
        "grid size-[clamp(2rem,3vw,3rem)] shrink-0 place-items-center rounded-lg border border-slate-700 bg-slate-800/60 text-slate-400 transition hover:text-slate-200 " +
        className
      }
    >
      {fs ? <Minimize2 className="size-[55%]" /> : <Maximize2 className="size-[55%]" />}
    </button>
  );
}
