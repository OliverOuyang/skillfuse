import { Info, TriangleAlert, XCircle } from "lucide-react";
import type { IssueSeverity } from "@/core/types";

/** 语义色调——徽标、评分环与提示条共用同一套取值。 */
export type Tone = "neutral" | "primary" | "success" | "warning" | "danger";

export const SEVERITY_ICON = { error: XCircle, warning: TriangleAlert, info: Info } as const;

export const SEVERITY_TONE: Record<IssueSeverity, Tone> = {
  error: "danger",
  warning: "warning",
  info: "primary",
};
