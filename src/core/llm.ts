import type { DatasetItem, ModelConfig, SkillAnalysis } from "./types";

/** Call any OpenAI-compatible chat endpoint (the user's own model included). */
export async function chatCompletion(cfg: ModelConfig, prompt: string): Promise<string> {
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new Error(`model endpoint returned ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

/** Ask the user's model for extra dataset items; returns parsed items or throws. */
export async function augmentDatasetItems(
  cfg: ModelConfig,
  a: SkillAnalysis,
  existing: DatasetItem[],
  count = 3,
): Promise<DatasetItem[]> {
  const prompt = `You are helping build a Langfuse evaluation dataset for an AI skill.

Skill name: ${a.skillName}
Skill description: ${a.description}
Detected output formats: ${a.formats.join(", ") || "free text"}
Hard constraints:
${a.constraints.map((c) => `- ${c}`).join("\n") || "- none"}

Existing dataset items (do not duplicate):
${JSON.stringify(existing.map((i) => i.input), null, 2)}

Propose ${count} NEW, diverse dataset items (mix of happy-path and edge cases).
Return a JSON array only, each element:
{ "input": { "task": string, "context": object },
  "expectedOutput": { "must_include": string[], "format": string, "notes": string },
  "metadata": { "source": "llm-augmented", "section": string, "tags": string[], "difficulty": "basic|intermediate|edge" } }`;

  const raw = await chatCompletion(cfg, prompt);
  const match = raw.match(/\[[\s\S]*\]/);
  const parsed = JSON.parse(match ? match[0] : raw);
  if (!Array.isArray(parsed)) throw new Error("model did not return a JSON array");
  return parsed as DatasetItem[];
}

/** Run the generated judge prompt against one input/output pair using the user's model. */
export async function runJudge(
  cfg: ModelConfig,
  judgePrompt: string,
  input: string,
  output: string,
): Promise<{ score: number; reasoning: string; raw: string }> {
  const prompt = judgePrompt.replace("{{input}}", input).replace("{{output}}", output);
  const raw = await chatCompletion(cfg, prompt);
  const match = raw.match(/\{[\s\S]*\}/);
  try {
    const data = JSON.parse(match ? match[0] : raw);
    return {
      score: Math.max(0, Math.min(1, Number(data.score ?? 0))),
      reasoning: String(data.reasoning ?? "").slice(0, 500),
      raw,
    };
  } catch {
    return { score: 0, reasoning: "judge parse error", raw };
  }
}
