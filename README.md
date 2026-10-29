# OAuth Setup Scout

**Live demo:** https://oauth-setup-scout.vercel.app/
**What this is:** a Composio APM Integrations take-home. It answers one question for developers building AI agents: *"what will it take to register an OAuth app with provider X and get it approved?"*

## What it does

1. **Guide library** - four providers with genuinely different setup paths, researched against current official docs (2026-10-28):
   - **GitHub** - self-serve, no approval; the real decision is OAuth app vs GitHub App.
   - **Slack** - self-serve unlisted distribution; only a Marketplace listing triggers review (10 business days preliminary + up to 10 weeks functional, 10+ active workspaces prerequisite).
   - **Google** - difficulty is scope-dependent: identity scopes instant, sensitive scopes need verification (10 business days per Google's FAQ), restricted scopes ~6 weeks + an annual paid CASA assessment.
   - **LinkedIn** - three self-serve products; everything else is partner-program gated; apps need a LinkedIn Page with admin verification.
2. **Live agent** - submit any app name or website. The agent resolves the official site, crawls the provider's public developer/OAuth docs, asks the LLM which additional pages to read, then generates a structured, cited, shareable guide in real time.
3. **Shareable guides** - every generated guide can be shared as a link; the guide JSON is compressed into the URL fragment, so sharing needs no database or account.

## Architecture

- Static front end (`index.html`, `app.js`, `styles.css`, `guides/*.json`) - no framework, no build step.
- One serverless endpoint `api/generate.js` - runs the investigation pipeline in `agent/`:
  - `investigate.js` - domain resolution (LLM suggestion or search + TLD verification), deterministic doc crawler (probes `developer.`/`docs.` subdomains and common paths, follows OAuth-flavored links), LLM round-2 page selection, final synthesis.
  - `gemini.js` - minimal Gemini REST client (free-tier key, `GEMINI_API_KEY` env var, server-side only; default model `gemini-3.5-flash`, override with `GEMINI_MODEL`).
  - No-key fallback: the same crawler runs, but synthesis is heuristic and the guide is explicitly labeled **doc-assisted** - never mislabeled as LLM output.
- Evidence discipline: the LLM is instructed to only cite fetched pages; every claim carries a support label (`official-docs` / `community` / `tested` / `uncertain`), and each guide lists every URL investigated.

## Run it locally

```bash
node server.js          # http://localhost:3457
GEMINI_API_KEY=... node server.js   # enables llm-agent mode
```

No dependencies - Node 18+ only (uses global `fetch`).

## Deploy (Vercel)

Zero-config: static files at the repo root, one function in `api/`. Set `GEMINI_API_KEY` as a server-side environment variable. Works on the free Hobby plan.

## Key decisions

- **Scope: the "bring your own OAuth app" path.** Composio already manages OAuth apps for 100+ toolkits; the homepage tells developers to check that directory first. This product focuses on the harder remainder, where the developer must register and possibly get approval - the case where the time/approval uncertainty lives.
- **Use-case-scoped difficulty, not universal rankings.** "How hard is Google?" has no single answer; difficulty is rated for a stated use case (e.g. "public app with sensitive scopes") and the guide says so.
- **Honesty over polish.** Tested means executed; source-supported means the provider's docs say it; everything else is labeled uncertain. The investigation log ships with every guide.
- **No database.** Share links carry the guide payload in the URL fragment (compressed). Trade-off: links are long (~2-4 KB) and there's no server-side analytics or edit history - acceptable for a take-home, and it keeps the free tier stateless.
- **Agents investigate, humans register.** Guides split every step into what an agent can do (research, draft values, generate code) and what needs a human (accounts, consent, secrets, provider correspondence).

## Limitations

- The crawler only reads public HTML; login-gated consoles and JS-heavy pages may be missed.
- Generated guides for unfamiliar apps should be verified against the linked sources before reliance - the agent's citations make that fast.
- No provider approvals were completed for this take-home (the brief says none are required); guides state exactly where the attempt stopped.
- Library currently covers 4 of the target 100 providers; the generation pipeline is the scaling path.

## Credentials

No credentials are in this repo. The demo's LLM key lives only as a server-side environment variable.
