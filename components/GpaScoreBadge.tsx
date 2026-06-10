"use client";

/**
 * GpaScoreBadge — reusable score badge component.
 * Works standalone — no dependency on shadcn or any specific UI library.
 *
 * Usage:
 *   import { GpaScoreBadge } from "@/gpa-scoring/components/GpaScoreBadge";
 *   <GpaScoreBadge score={message.gpaScore} threshold={2} />
 */

import React from "react";
import { GpaScore, Dimension, DIMENSION_RUBRICS } from "../lib/types";

// ── Colour helpers ────────────────────────────────────────────────────────────

const SCORE_COLOURS: Record<string, { bg: string; text: string; border: string }> = {
  High:    { bg: "#f0fdf4", text: "#15803d", border: "#bbf7d0" },
  Good:    { bg: "#f0fdfa", text: "#0f766e", border: "#99f6e4" },
  Partial: { bg: "#fefce8", text: "#a16207", border: "#fef08a" },
  Low:     { bg: "#fef2f2", text: "#dc2626", border: "#fecaca" },
  default: { bg: "#f3f4f6", text: "#6b7280", border: "#d1d5db" },
};

function colourFor(label?: string) {
  return SCORE_COLOURS[label ?? ""] ?? SCORE_COLOURS.default;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

interface BadgePillProps {
  dimKey:    Dimension;
  value:     number;
  label:     string;
  reasoning: string;
}

function BadgePill({ dimKey, value, label, reasoning }: BadgePillProps) {
  const [showTip, setShowTip] = React.useState(false);
  const c = colourFor(label);
  const fullName = DIMENSION_RUBRICS[dimKey]?.name ?? dimKey;

  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <span
        onMouseEnter={() => setShowTip(true)}
        onMouseLeave={() => setShowTip(false)}
        style={{
          display:      "inline-flex",
          alignItems:   "center",
          gap:          "3px",
          padding:      "1px 7px",
          borderRadius: "9999px",
          border:       `1px solid ${c.border}`,
          background:   c.bg,
          color:        c.text,
          fontSize:     "10px",
          fontWeight:   "600",
          cursor:       "default",
          whiteSpace:   "nowrap",
          userSelect:   "none",
        }}
      >
        {dimKey}: {label} ({value}/3)
      </span>

      {showTip && reasoning && (
        <span
          style={{
            position:    "absolute",
            bottom:      "calc(100% + 6px)",
            left:        "50%",
            transform:   "translateX(-50%)",
            background:  "#1f2937",
            color:       "#f9fafb",
            padding:     "6px 10px",
            borderRadius:"6px",
            fontSize:    "11px",
            lineHeight:  "1.5",
            whiteSpace:  "normal",
            width:       "240px",
            zIndex:      50,
            pointerEvents: "none",
            boxShadow:   "0 4px 12px rgba(0,0,0,0.25)",
          }}
        >
          <strong style={{ display: "block", marginBottom: "2px" }}>{fullName}</strong>
          {reasoning}
        </span>
      )}
    </span>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export interface GpaScoreBadgeProps {
  score?:     GpaScore;
  /** GF threshold below which to show a low-confidence warning (default: 2) */
  threshold?: number;
  /** Which dimensions to display (default: whatever is present in score) */
  dimensions?: Dimension[];
}

export function GpaScoreBadge({ score, threshold = 2, dimensions }: GpaScoreBadgeProps) {
  if (!score) return null;

  if (score.isScoring) {
    return (
      <span style={{ fontSize: "10px", color: "#9ca3af", display: "flex", alignItems: "center", gap: "4px" }}>
        <span style={{
          width: "10px", height: "10px",
          border: "2px solid #d1d5db", borderTopColor: "#6b7280",
          borderRadius: "50%",
          display: "inline-block",
          animation: "gpa-spin 0.7s linear infinite",
        }} />
        Scoring…
        <style>{`@keyframes gpa-spin { to { transform: rotate(360deg); } }`}</style>
      </span>
    );
  }

  // Collect dimensions to show
  const dimOrder: Dimension[] = dimensions ?? ["GF", "LC", "EE", "PQ", "PA"];
  const toShow = dimOrder.filter(d => {
    const ds = (score as Record<string, unknown>)[d] as { value: number; label: string; reasoning: string } | undefined;
    return ds && typeof ds.value === "number";
  });

  if (!toShow.length) return null;

  const gfValue = score.GF?.value ?? score.value;
  const showWarning = gfValue !== undefined && gfValue < threshold;

  return (
    <div style={{ marginTop: "6px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", alignItems: "center" }}>
        {toShow.map(d => {
          const ds = (score as Record<string, unknown>)[d] as { value: number; label: string; reasoning: string };
          return (
            <BadgePill
              key={d}
              dimKey={d}
              value={ds.value}
              label={ds.label}
              reasoning={ds.reasoning}
            />
          );
        })}
      </div>

      {showWarning && (
        <div style={{
          marginTop:    "5px",
          display:      "flex",
          alignItems:   "center",
          gap:          "5px",
          padding:      "4px 8px",
          borderRadius: "6px",
          border:       "1px solid #fde68a",
          background:   "#fffbeb",
          fontSize:     "10px",
          color:        "#92400e",
        }}>
          <span>⚠</span>
          Low confidence — try rephrasing your question for better results
        </div>
      )}
    </div>
  );
}
