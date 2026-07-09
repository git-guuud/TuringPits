/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // The Tribunal palette (the approved direction).
        ink: { DEFAULT: "#0c0b08", 2: "#131009", 3: "#1b1610" },
        line: { DEFAULT: "#2c2417", 2: "#3a3018" },
        gilt: { DEFAULT: "#c9a23f", soft: "#9c8038" },
        cream: { DEFAULT: "#ece3cf", dim: "#b9ad91" },
        mute: { DEFAULT: "#7d745c", 2: "#5c543f" },
        convict: "#b5302e", // Mafia / "Acquitted" (the guilty walk)
        acquit: "#7fa07e", // Town / "Convicted" (the guilty caught)
        lamp: "#f0c552",
      },
      fontFamily: {
        display: ["'Cormorant Garamond'", "serif"],
        body: ["'EB Garamond'", "Georgia", "serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "monospace"],
      },
      keyframes: {
        livepulse: {
          "0%": { boxShadow: "0 0 0 0 rgba(181,48,46,.6)" },
          "70%": { boxShadow: "0 0 0 7px rgba(181,48,46,0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(181,48,46,0)" },
        },
        blink: { "50%": { opacity: "0" } },
        // The Wagers-panel odds-move flash (bg fades from tinted → transparent) + the header lamp pulse.
        lamppulse: { "0%,100%": { opacity: ".4" }, "50%": { opacity: "1" } },
        flashup: { "0%": { backgroundColor: "rgba(127,160,126,.28)" }, "100%": { backgroundColor: "transparent" } },
        flashdown: { "0%": { backgroundColor: "rgba(181,48,46,.28)" }, "100%": { backgroundColor: "transparent" } },
      },
      animation: {
        livepulse: "livepulse 2.4s infinite",
        blink: "blink 1s steps(1) infinite",
        lamppulse: "lamppulse 1.8s infinite",
        flashup: "flashup 0.8s ease-out",
        flashdown: "flashdown 0.8s ease-out",
      },
    },
  },
  plugins: [],
};
