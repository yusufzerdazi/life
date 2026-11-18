import { useEffect } from "react";
import { Check, X } from "lucide-react";

export function todayStr() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

export function shiftDate(dateStr, delta) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + delta);
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

export function formatDuration(min) {
  if (min == null) return "";
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}`;
}

export function minutesBetween(a, b) {
  if (!a || !b) return null;
  const m = (t) => {
    const [h, mm] = t.split(":").map(Number);
    return h * 60 + mm;
  };
  let d = m(b) - m(a);
  if (d <= 0) d += 1440;
  return d;
}

// Consecutive done days per goal, counting back from today (or yesterday, if
// today isn't done yet — an unfinished today doesn't break a streak).
export function streaks(history) {
  if (!history) return () => 0;
  const done = new Set(history.logs.map((l) => `${l.goal_id}|${l.date}`));
  return (id) => {
    let n = 0;
    let cur = todayStr();
    if (!done.has(`${id}|${cur}`)) cur = shiftDate(cur, -1);
    while (done.has(`${id}|${cur}`)) {
      n++;
      cur = shiftDate(cur, -1);
    }
    return n;
  };
}

// Round status mark: filled when done, outlined when not, red cross for a slip.
export function Mark({ state, size = "size-[22px]" }) {
  const on = state === true || state === "clean";
  const slipped = state === "slipped";
  return (
    <span
      className={`grid ${size} shrink-0 place-items-center rounded-full border-[1.5px] transition-colors ${
        on ? "border-ok bg-ok text-night" : slipped ? "border-slip text-slip" : "border-mute/60 text-transparent"
      }`}
    >
      {slipped ? <X size={12} strokeWidth={3} /> : <Check size={12} strokeWidth={3} />}
    </span>
  );
}

// The Android app pulls Google Health / Waking Up when it comes to the
// foreground and fires this event when new data has landed.
export function useOnSynced(fn) {
  useEffect(() => {
    window.addEventListener("life:synced", fn);
    return () => window.removeEventListener("life:synced", fn);
  }, [fn]);
}
