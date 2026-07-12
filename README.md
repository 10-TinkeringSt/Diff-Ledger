# Diff Ledger

A schema-agnostic CSV comparison tool that runs entirely in your browser. Upload two CSVs, pick a key column, and Diff Ledger joins the rows and sorts every pair into **Match**, **Mismatch**, **A only**, or **B only** — instantly, with local rules, and with an optional AI pass to resolve wording-only differences.

No backend, no build step, no data ever leaves your machine unless you opt into AI review.

## Features

- **Fast mode (always runs first, free, instant)** — deterministic, local heuristics join rows by key column(s) and flag differences. Handles up to ~200k rows comfortably in-browser.
- **Column roles** — mark each shared column as `Key` (joins rows), `Compare` (judged for content), `Context` (shown for reference only), or `Ignore`.
- **Optional AI review** — only re-checks the mismatches that are wording-only (numeric/value disagreements are never sent to AI, since those are already conclusive). Two engines to choose from:
  - **Cloud**: bring your own Anthropic API key, sent directly from your browser.
  - **Local**: a small model (Qwen2.5, via [WebLLM](https://github.com/mlc-ai/web-llm)) running in-browser over WebGPU — nothing leaves your machine.
- **Uncertainty flagging** — AI verdicts are flagged for a human glance when the model hedges its language or its stated reasoning contradicts its own verdict.
- **Export** — full results to CSV, or print/save as PDF.
- **Dark mode** by default, with a light mode toggle.

## Usage

Just open `index.html` in a modern browser (Chrome or Edge recommended if you want to try local AI review, since that needs WebGPU).

```bash
git clone https://github.com/<your-username>/diff-ledger.git
cd diff-ledger
# open index.html directly, or serve it locally:
npx serve .
```

> Serving via a local server (rather than opening the file directly) is recommended if you plan to use local AI review — `file://` pages get a much smaller browser storage quota, which can cause the model download to fail with a quota error.

## How it works

1. Upload File A and File B (CSV, with headers).
2. Diff Ledger detects shared columns and guesses sensible roles (columns with `id`/`code`/`key`/`date` in the name become keys).
3. Adjust column roles if needed, then run the **Fast** comparison — a deterministic join + heuristic diff (exact match for numeric fields, Jaccard text similarity otherwise).
4. Confident results (matches, numeric mismatches, A/B-only rows) are done. Wording-only mismatches are queued for **optional AI review**.
5. If you choose to run AI review, results merge back into the same table, tagged `AI` and flagged `⚠ uncertain` where relevant.

## Project structure

```
diff-ledger/
├── index.html        # page structure
├── css/
│   └── styles.css    # all styling, light/dark theme via CSS variables
└── js/
    └── script.js      # CSV parsing, fast heuristic diff, AI review (cloud + local)
```

## Dependencies (loaded via CDN, no install required)

- [PapaParse](https://www.papaparse.com/) — CSV parsing
- [WebLLM](https://github.com/mlc-ai/web-llm) — local in-browser LLM inference (loaded on demand, only if you select Local AI review)
- Google Fonts: Space Grotesk, IBM Plex Sans, IBM Plex Mono

## Privacy notes

- CSV data never leaves your browser in Fast mode.
- Cloud AI review sends only the flagged mismatch rows' `Compare`-role columns to the Anthropic API, using an API key you provide (stored in tab memory only, never persisted).
- Local AI review sends nothing anywhere — inference runs in-browser via WebGPU.

## License

MIT — see [LICENSE](LICENSE).
