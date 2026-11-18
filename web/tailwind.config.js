import flowbite from "flowbite/plugin";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}", "./node_modules/flowbite/**/*.js"],
  theme: {
    extend: {
      // Warm, low-contrast dark palette. Colours are CSS variables (index.css)
      // so the native screens and the web share one set of values.
      colors: {
        night: "rgb(var(--night) / <alpha-value>)",
        raise: "rgb(var(--raise) / <alpha-value>)",
        rule: "rgb(var(--rule) / <alpha-value>)",
        fg: "rgb(var(--fg) / <alpha-value>)",
        dim: "rgb(var(--dim) / <alpha-value>)",
        mute: "rgb(var(--mute) / <alpha-value>)",
        ok: "rgb(var(--ok) / <alpha-value>)",
        slip: "rgb(var(--slip) / <alpha-value>)",
        ember: "rgb(var(--ember) / <alpha-value>)",
      },
      fontFamily: {
        display: ['"Instrument Serif"', "Georgia", "serif"],
      },
    },
  },
  plugins: [flowbite],
};
