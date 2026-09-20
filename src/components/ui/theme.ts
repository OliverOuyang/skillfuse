import { useEffect, useMemo, useState } from "react";

const THEME_KEY = "skillfuse.theme";

export type Theme = "light" | "dark";

/** 主题优先读用户上次的选择，其次跟随系统。 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      /* localStorage 不可用时回落到系统偏好 */
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* 隐私模式下忽略写入失败 */
    }
  }, [theme]);

  return useMemo(() => ({ theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) }), [theme]);
}
