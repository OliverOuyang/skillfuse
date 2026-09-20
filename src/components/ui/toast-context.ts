import { createContext, useContext } from "react";

export type ToastKind = "success" | "error" | "info";

export interface ToastInput {
  kind: ToastKind;
  message: string;
  detail?: string;
}

export const ToastCtx = createContext<(t: ToastInput) => void>(() => {});

/** 在任意组件里弹出一条轻提示。 */
export function useToast() {
  return useContext(ToastCtx);
}
