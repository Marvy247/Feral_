# Submission checklist

Read this once, top to bottom. The form takes **one** submission per team and it
**cannot be edited after sending**, so the order matters.

The live rules: <https://nearhackathon.com/HACKATHON.md>. The form:
<https://nearhackathon.com/#apply>. A mistake is fixed with
<https://nearhackathon.com/request-changes>, never with a second submission.

## What only a human can do

| # | Task | Notes |
|---|---|---|
| 1 | Make the repository public | Judges cannot open a private one. It must be public before **2026-11-14T23:59:00Z**. |
| 2 | Post the demo on X | Say the project was built at NEAR HACKATHON, tag `@NEARProtocol` and `#NEARHackathon`, attach the video or screenshots. |
| 3 | Fill `submission.json` | Copy `submission.example.json` and fill every field by hand. |
| 4 | Run `node scripts/submit.mjs` | It validates every field against the published contract and prints the exact payload. Nothing is sent. |
| 5 | Send | `node scripts/submit.mjs --send` asks you to type the project name first, or paste the printed JSON into the form. |

The agent never pushes, never makes a repository public, never posts to X, and never
sends the submission without an explicit yes.

## Before you send: the five checks that matter

1. **`npm run verify:claims` is green.** Every claim in the README is re-measured
   against the code. If it fails, the README is lying about something.
2. **`npm run preflight` is green.** The repository is consistent and every command
   in the documentation exits 0.
3. **`npm run caps:check` is green.** The capability manifest still matches the
   engine, the Rust vault and the scenario catalogue.
4. **`npm run demo:check` is green.** The committed browser demo is exactly what the
   current sources build, and it reproduces all 52 verdicts.
5. **The demo post opens.** Paste the link into a private window. It must show the
   product without a login, and the repository link next to it must be public.

## The fields the form asks for

| Field | Where it comes from |
|---|---|
| Project name | The name must be distinctive. Another project called "Feral" is already published in the build log (an AI-creature swarm with a "MUNCH" token). The suggested name carries the category so a judge reading the directory knows which one is which. |
| Team lead | Your name as you want it shown. |
| Email | Where the organizers contact you. One person may send at most two submissions for independent projects, and each project's README must name the other. |
| Team size | `1` for a solo build. |
| Tracks | `security` and `agents`. The project is built for the AI Security & Defense track. |
| NEAR account | A named account you own, on mainnet, where the prize is sent. Never let an agent invent one. |
| Repository link | `https://github.com/Marvy247/Feral_` - the public root URL. |
| Demo post link | The public X post, with the video attached. |
| What did you build | 20-2000 characters: the problem, the product, and what NEAR does in it. Draft it in `docs/DEMO_SCRIPT.md`. |
| Consent | The notice, read to you verbatim: "I agree that the organizers may use these details to review our submission and contact us about this hackathon." |

## What the description should say

The judges read the description before they open the repository. It has to answer
three questions in the first two sentences:

1. **What is broken today?** An AI agent with a wallet has no bound: one prompt
   injection and the balance is gone.
2. **What did you build?** A vault contract that holds the money, an agent key that
   can only call `spend()`, and a policy the vault recomputes on every call.
3. **What does NEAR do here?** Function-call keys scoped to one method, NEP-297
   events the agent can read to learn why it was refused, hash-chained audit
   records anchored on-chain, and chain signatures for cross-chain output.

Avoid "powered by NEAR" and architecture diagrams. One concrete moment beats a
paragraph of adjectives: an agent asks for 40 USDC, the vault refuses with
`PER_TX_LIMIT`, and the agent buys the cheap tier instead.

## After sending

- The repository must stay public, and the demo post must stay up, until the
  results are announced (2026-11-18T23:59:00Z).
- If a field is wrong, use <https://nearhackathon.com/request-changes>. Never
  submit twice: the second submission for the same repository is rejected.
