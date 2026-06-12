/**
 * OpenRouter client + model routing for the AI brain (P2.2).
 *
 * Routing (CLAUDE.md): Haiku 4.5 for routine lens diagnoses, Sonnet 4.5 for
 * analog/synthesis-heavy steps, Perplexity Sonar for Lens 6 market scan.
 *
 * Server-only — reads OPENROUTER_API_KEY from env, never embeds it. JSON-mode
 * wrapper parses the model's JSON and retries once on malformed output.
 */

import { requireEnv } from "@/lib/env";

export const MODELS = {
  haiku: "anthropic/claude-haiku-4.5",
  sonnet: "anthropic/claude-sonnet-4.5",
  sonar: "perplexity/sonar",
} as const;

export type ModelKey = keyof typeof MODELS;

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

type ChatArgs = {
  model: ModelKey;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
};

export type Usage = { total_tokens?: number; cost?: number };

async function rawChat(args: ChatArgs, jsonMode: boolean): Promise<{ content: string; usage: Usage }> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("OPENROUTER_API_KEY")}`,
      "Content-Type": "application/json",
      "X-Title": "Optimization PLUS",
    },
    body: JSON.stringify({
      model: MODELS[args.model],
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
      max_tokens: args.maxTokens ?? 1200,
      temperature: args.temperature ?? 0.2,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const j = await res.json();
  return { content: j.choices?.[0]?.message?.content ?? "", usage: j.usage ?? {} };
}

/** Strip ```json fences / leading prose so JSON.parse succeeds. */
function extractJson(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  return first >= 0 && last > first ? s.slice(first, last + 1) : s.trim();
}

/** Chat expecting JSON. Parses to T; on parse failure, retries once with a reminder. */
export async function chatJSON<T>(args: ChatArgs): Promise<{ data: T; usage: Usage }> {
  const first = await rawChat(args, true);
  try {
    return { data: JSON.parse(extractJson(first.content)) as T, usage: first.usage };
  } catch {
    const retry = await rawChat(
      { ...args, user: args.user + "\n\nYour previous reply was not valid JSON. Return ONLY a single valid JSON object, no prose, no markdown fences." },
      true,
    );
    return { data: JSON.parse(extractJson(retry.content)) as T, usage: retry.usage };
  }
}

/** Plain text chat (used for Sonar market scan, which returns prose + citations). */
export async function chatText(args: ChatArgs): Promise<{ content: string; usage: Usage }> {
  return rawChat(args, false);
}
