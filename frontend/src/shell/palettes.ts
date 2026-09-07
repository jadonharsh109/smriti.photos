/** The palettes the Appearance tab offers. The colours here are for the
 *  preview cards only; the real tokens live in styles/tokens.css. */
export type PaletteId = "smriti" | "midnight" | "paper" | "catppuccin-mocha" | "catppuccin-latte" | "nord" | "dracula" | "tokyo-night" | "rose-pine" | "rose-pine-dawn" | "gruvbox-dark" | "gruvbox-light" | "solarized-dark" | "solarized-light" | "one-dark";
export interface Palette { id: PaletteId; label: string; scheme: "light" | "dark" | "auto"; side: string; ground: string; ink: string; accent: string; }
export const PALETTES: Palette[] = [
  { id: "smriti", label: "Smriti", scheme: "auto", side: "#ededef", ground: "#f6f6f7", ink: "#1d1d1f", accent: "#c46a0e" },
  { id: "midnight", label: "Midnight", scheme: "dark", side: "#0b0f19", ground: "#0f1420", ink: "#e3e8f2", accent: "#7cc4ff" },
  { id: "paper", label: "Paper", scheme: "light", side: "#efe9df", ground: "#f7f3ec", ink: "#2a2622", accent: "#c46a0e" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", scheme: "dark", side: "#181825", ground: "#1e1e2e", ink: "#cdd6f4", accent: "#cba6f7" },
  { id: "catppuccin-latte", label: "Catppuccin Latte", scheme: "light", side: "#e6e9ef", ground: "#eff1f5", ink: "#4c4f69", accent: "#8839ef" },
  { id: "nord", label: "Nord", scheme: "dark", side: "#272c36", ground: "#2e3440", ink: "#eceff4", accent: "#88c0d0" },
  { id: "dracula", label: "Dracula", scheme: "dark", side: "#232530", ground: "#282a36", ink: "#f8f8f2", accent: "#bd93f9" },
  { id: "tokyo-night", label: "Tokyo Night", scheme: "dark", side: "#16161e", ground: "#1a1b26", ink: "#c0caf5", accent: "#7aa2f7" },
  { id: "rose-pine", label: "Rosé Pine", scheme: "dark", side: "#1f1d2e", ground: "#191724", ink: "#e0def4", accent: "#c4a7e7" },
  { id: "rose-pine-dawn", label: "Rosé Pine Dawn", scheme: "light", side: "#f4ece4", ground: "#faf4ed", ink: "#575279", accent: "#907aa9" },
  { id: "gruvbox-dark", label: "Gruvbox Dark", scheme: "dark", side: "#242424", ground: "#282828", ink: "#ebdbb2", accent: "#fe8019" },
  { id: "gruvbox-light", label: "Gruvbox Light", scheme: "light", side: "#f5ebc0", ground: "#fbf1c7", ink: "#3c3836", accent: "#af3a03" },
  { id: "solarized-dark", label: "Solarized Dark", scheme: "dark", side: "#00252f", ground: "#002b36", ink: "#e6dfcd", accent: "#268bd2" },
  { id: "solarized-light", label: "Solarized Light", scheme: "light", side: "#f3edda", ground: "#fdf6e3", ink: "#073642", accent: "#268bd2" },
  { id: "one-dark", label: "One Dark", scheme: "dark", side: "#21252b", ground: "#282c34", ink: "#d7dae0", accent: "#61afef" },
];
