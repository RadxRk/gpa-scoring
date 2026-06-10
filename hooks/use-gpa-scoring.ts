"use client";

/**
 * useGpaScoring — standalone React hook for real-time GPA scoring.
 * Agent-agnostic: configure per-agent via scoreEndpoint and options.
 *
 * Usage:
 *   const { score, isScoring, triggerScore, clearScore } = useGpaScoring({
 *     scoreEndpoint: "/api/agent/score",
 *     threshold: 2,
 *   });
 *
 *   // After streaming completes:
 *   triggerScore({ question, response, threadId, messageId });
 *
 *   // In JSX:
 *   <GpaScoreBadge score={score} threshold={options.threshold} />
 */

import { useState, useCallback } from "react";
import { GpaScore, ScoreRequest } from "../lib/types";

export interface UseGpaScoringOptions {
  /** API endpoint that handles POST scoring requests (default: /api/agent/score) */
  scoreEndpoint?: string;
  /** GF threshold below which to show low-confidence warning (default: 2) */
  threshold?: number;
  /** Called when a score is received */
  onScore?: (score: GpaScore) => void;
  /** Called on error */
  onError?: (err: Error) => void;
}

export interface UseGpaScoringReturn {
  score:        GpaScore | null;
  isScoring:    boolean;
  triggerScore: (request: ScoreRequest) => void;
  clearScore:   () => void;
}

export function useGpaScoring(options: UseGpaScoringOptions = {}): UseGpaScoringReturn {
  const {
    scoreEndpoint = "/api/agent/score",
    threshold     = 2,
    onScore,
    onError,
  } = options;

  const [score,     setScore]     = useState<GpaScore | null>(null);
  const [isScoring, setIsScoring] = useState(false);

  const triggerScore = useCallback((request: ScoreRequest) => {
    setScore({ isScoring: true });
    setIsScoring(true);

    // Fire-and-forget — does not block the caller
    (async () => {
      try {
        const res  = await fetch(scoreEndpoint, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(request),
        });

        if (!res.ok) {
          setScore(null);
          return;
        }

        const data = await res.json();

        // Support both new structured scores and legacy flat fields
        const newScore: GpaScore = {
          isScoring: false,
          // New structured dimensions
          ...(data.scores ?? {}),
          // Legacy flat fields (backwards compat)
          value:       data.value,
          label:       data.label,
          reasoning:   data.reasoning,
          lcValue:     data.lcValue,
          lcLabel:     data.lcLabel,
          lcReasoning: data.lcReasoning,
        };

        setScore(newScore);
        onScore?.(newScore);
      } catch (err) {
        console.error("[useGpaScoring] Error:", err);
        setScore(null);
        onError?.(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setIsScoring(false);
      }
    })();
  }, [scoreEndpoint, onScore, onError]);

  const clearScore = useCallback(() => {
    setScore(null);
    setIsScoring(false);
  }, []);

  return { score, isScoring, triggerScore, clearScore };
}

// ── Per-message scoring hook ────────────────────────────────────────────────

/**
 * useBatchGpaScoring — manages GPA scores for a list of messages.
 * Mirrors the clinical-trial-app pattern but works with any message type.
 */
export interface ScoredMessage {
  id:        string;
  role:      "user" | "assistant";
  content:   string;
  gpaScore?: GpaScore;
}

export function useBatchGpaScoring(options: UseGpaScoringOptions = {}) {
  const { scoreEndpoint = "/api/agent/score" } = options;
  const [isRescoring, setIsRescoring] = useState(false);

  const rescoreAll = useCallback(async (
    messages:  ScoredMessage[],
    threadId?: string,
    onUpdate?: (id: string, score: GpaScore) => void
  ) => {
    if (isRescoring) return;
    setIsRescoring(true);

    const assistantMessages = messages.filter(m => m.role === "assistant" && m.content);
    const scorePromises = assistantMessages.map(async (msg) => {
      const prevUser = [...messages]
        .slice(0, messages.indexOf(msg))
        .reverse()
        .find(m => m.role === "user");

      if (!prevUser) return;

      try {
        const res = await fetch(scoreEndpoint, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            question:  prevUser.content,
            response:  msg.content,
            threadId,
            messageId: msg.id,
          }),
        });
        if (!res.ok) return;
        const data = await res.json();
        const score: GpaScore = {
          isScoring: false,
          ...(data.scores ?? {}),
          value: data.value, label: data.label, reasoning: data.reasoning,
          lcValue: data.lcValue, lcLabel: data.lcLabel, lcReasoning: data.lcReasoning,
        };
        onUpdate?.(msg.id, score);
      } catch { /* silent */ }
    });

    await Promise.allSettled(scorePromises);
    setIsRescoring(false);
  }, [scoreEndpoint, isRescoring]);

  return { isRescoring, rescoreAll };
}
