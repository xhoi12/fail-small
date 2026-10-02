// Small helpers shared by the client components.

import { useEffect, useState } from "react";
import { isActive, type GameView } from "../shared";
import { GRADE_THRESHOLDS, type Grade } from "../sim";

export { isActive };

export type Rollout = NonNullable<GameView["rollout"]>;

/** Where the player is in a level. Drives what the game area shows. */
export type Phase = "plan" | "deploy" | "decide" | "debrief";

export const PHASES: { id: Phase; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "deploy", label: "Deploy & watch" },
  { id: "decide", label: "Decide" },
  { id: "debrief", label: "Debrief" },
];

/** `replanning` is set when the player chose "Try again" after a finished rollout. */
export function phaseOf(view: GameView, replanning: boolean): Phase {
  const { rollout } = view;
  if (!rollout || (replanning && !isActive(rollout))) return "plan";
  if (rollout.status === "running") return "deploy";
  if (rollout.status === "awaiting-decision") return "decide";
  return "debrief";
}

export const REGIONS: [string, string][] = [
  ["NA", "North America"],
  ["EU", "Europe"],
  ["APAC", "Asia-Pacific"],
  ["LATAM", "Latin America"],
  ["AF", "Africa"],
];

/** Grade bands for the blast radius, from the same thresholds scoreRollout() uses. */
export const GRADE_BANDS: { grade: Grade; max: number }[] = [
  ...GRADE_THRESHOLDS.map(([grade, max]) => ({ grade, max })),
  { grade: "D", max: Infinity },
];

export function gradeFor(blast: number): Grade {
  return GRADE_BANDS.find((band) => blast <= band.max)!.grade;
}

/** Re-renders every `ms` while `active`, for countdowns. */
export function useNow(active: boolean, ms = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return now;
}

export function fmtCodes(codes: string[], max = 3): string {
  return codes.length <= max ? codes.join(", ") : `${codes.slice(0, max).join(", ")} +${codes.length - max}`;
}
