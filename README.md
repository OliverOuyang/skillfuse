# SkillFuse

**Turn AI skills into measurable impact.** Drop in a `SKILL.md` and SkillFuse generates a Langfuse-ready evaluation pack: dataset schema + items, deterministic rule scorers, an LLM-as-a-judge scorer, and the Langfuse wiring to run it all.

Everything runs locally. No skill content leaves your machine unless you explicitly configure your own model.

## What it generates

| Artifact | Description |
| --- | --- |
| `dataset_schema.json` | Langfuse-compatible dataset schema derived from the skill's inputs, tasks and expected outputs — ready for `langfuse.create_dataset()` |
| `dataset_items.json` | Happy-path, example-based and constraint-adversarial dataset items with `input` / `expectedOutput` / `metadata` |
| `rule_scorers.py` | Zero-dependency deterministic scorers (format checks, structure checks, hard-constraint validation) with a weighted aggregate |
| `rule_checks.json` | The same rules as data — drives the in-browser dry-run |
| `llm_judge_prompt.md` | LLM-as-a-judge rubric built from the skill's own quality criteria and hard rules |
| `llm_judge.py` | Judge scorer for any OpenAI-compatible endpoint — your own model included |
| `langfuse_config.py` | One-shot dataset creation + evaluation-run skeleton |
| `.env.example` | Environment template (Langfuse keys + judge model) |

## Quick start

### Web UI

```bash
npm install
npm run dev
```

Open the app, then follow the guided pipeline:

1. **Import** — drag & drop a `SKILL.md` or `.zip`, paste one directly, or try the built-in sample
2. **Inspect** — review the detected formats, constraints, workflow steps and trigger keywords
3. **Generate** — preview every artifact, copy or download individually, or grab the whole pack as a `.zip`
4. **Test** — paste any model output and dry-run the rule scorers (and the LLM judge, if a model is configured) right in the browser

### CLI

The same engine ships as a command-line tool:

```bash
npm install
npx tsx cli/skillfuse.ts ./path/to/SKILL.md --out ./out
# also accepts a skill directory or a .zip containing SKILL.md
```

### Using the pack with Langfuse

```bash
pip install langfuse openai python-dotenv
cp .env.example .env   # fill in your Langfuse keys (and judge model if used)
python langfuse_config.py          # create the dataset + upload items
python langfuse_config.py --eval   # evaluation-run skeleton — plug in your skill runner
```

## Bring your own model (optional)

Generation is **rule-based by default** — fully deterministic, no API key needed. Optionally, open *Model settings* in the UI and point SkillFuse at any OpenAI-compatible endpoint (`base_url` + `api_key` + `model`) to:

- **augment** the dataset with extra items proposed by your model
- **run the LLM judge** live in the browser during the Test step

The key is stored only in your browser's `localStorage`.

## How it works

```
SKILL.md ──► parseSkill   (frontmatter + sections via js-yaml)
         ──► analyzeSkill (heuristics: formats, inputs, constraints,
                          quality criteria, steps, triggers, examples)
         ──► generate     (dataset schema/items, rule checks,
                          judge prompt, Langfuse config)
```

The rule checks are data (`rule_checks.json`), interpreted identically by the in-browser runner (`src/core/runRules.ts`) and the shipped `rule_scorers.py` — what you see in the Test step is what Langfuse will compute.

## Project layout

```
cli/skillfuse.ts            CLI entry (npx tsx cli/skillfuse.ts ...)
src/core/                   shared engine (used by web app and CLI)
  parseSkill.ts             SKILL.md parser
  analyze.ts                heuristic skill analyzer
  generate.ts               artifact generator
  runRules.ts               in-browser rule runner
  llm.ts                    OpenAI-compatible client (optional)
src/components/skillfuse/   guided-pipeline UI
```

## Privacy

SkillFuse runs entirely on your machine. Skill files are processed in your browser or by the local CLI; nothing is sent to external services unless you configure your own model endpoint.

## License

[MIT](LICENSE)
