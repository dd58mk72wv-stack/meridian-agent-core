# CLAUDE.md

Read at the start of every session in this repo.

---

## What this is

`@meridian/agent-core` — the shared core every Meridian **client system** is built on.
CMO → Manager → Agent, the voice chain, and the integration adapters.

**Consumed by version tag, not copied.** Each client gets their own repo, their own Supabase
project and their own Railway service, and depends on a pinned tag of this one. One client's
change can never reach another; a fix here lands once and each client bumps.

This repo contains **nothing vertical-specific**. No vet, dental or dealership business
logic. If you are writing a Triage Agent or a Test Drive Booking Agent, you are in the wrong
repo — that belongs in the client's own.

---

## Commands

```
install     npm install
typecheck   npm run typecheck
test        npm run test
verify      npm run verify      # typecheck + tests, run before anything counts as done
```

---

## Stack

- **Runtime** — Node 22+, TypeScript via `tsx`. No build step.
- **Database** — Postgres on Supabase. Per client, never shared.
- **Hosting** — Railway, per client.
- **Secrets** — Railway environment variables, never the repo.

---

## The four rules that hold this up

**Three tiers, no deeper.** CMO → Manager → Agent. A fourth layer adds latency and loses
detail through summarising.

**Full context up, full context down.** No layer summarises away detail a later step needs.
`Context` is append-only and there is deliberately no way to truncate it — the rule is a
property of the type, not a note in a file. Do not add one.

**One job per agent.** If the job description needs "and", it is two agents. `defineAgent`
refuses at definition time.

**Managers delegate, they do not execute.** A manager that handles "just the simple case"
itself has become an agent with no name, no department and no place in the registry.

---

## Two things that are easy to get wrong

**Every agent does not need a language model.** The org chart is a naming and ownership
scheme, not a mandate for N models. An agent that reads a row and writes a field does not
need to reason its way there. `reasons: false` is the common case.

**Stubs must announce themselves.** The danger is not a stub that breaks — it is a stub that
works, quietly, in production, while somebody reads its invented availability as a real
diary. Every stub's name begins `stub:` and the health view surfaces it.

---

## Corrections

- `db.ts` and `queue.ts` were first written into the client template, then moved here.
  They are generic infrastructure every client needs identically, and duplicating them per
  client repo is the thing the shared core exists to prevent. If something looks
  client-specific, check whether it actually is before copying it.
