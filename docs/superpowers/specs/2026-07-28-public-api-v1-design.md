# Public API v1 — Design

**Date:** 2026-07-28
**Status:** Approved
**Base:** `main` @ `4dc3155` — 763 tests, deployed

## Problem

Forge has two mutation surfaces that both call the same `lib/` functions, and the split between
them is accidental rather than principled.

- **REST** — nine handlers under `apps/web/src/app/(app)/api/missions/*`, gated by `apiAuth()`
- **Server Actions** — eighteen exports across eight `'use server'` files, gated by `withAuth()`

They overlap on lifecycle: `POST /api/missions/:id/start` and `missionAction op=start` both call
`startMission()`. Meanwhile every operation an operator actually performs exists **only** as a
Server Action and is therefore invisible to any external caller: approve, dismiss, steer, abort,
repo settings, policy.

A definitive scan found **only three** REST endpoints have any in-app caller — `retrospect`, the
SSE `stream`, and `PATCH /proposals/:id`. The other six have had zero callers since April.

Neither surface is reachable by a machine. `apiAuth()` and `withAuth()` both resolve via
`auth.api.getSession({ headers })` — the same session cookie. There is no API key, no PAT, no
service account. This was hit directly during this session: driving Forge programmatically was
impossible, and the fallback was the HMAC webhook plus the OIDC-gated tick, which work precisely
because they were built for machines.

A competitive analysis (`docs/competitive-gap-analysis.md`) rates this a Tier-0 gap. Factory ships
`fk-…` keys with a Service Accounts API and is CLI-first; Devin and GitHub both have machine
identities.

## Decisions

### The API is a product

`/api/v1/*` is a supported public surface, versioned from day one. It lives in the same Next app —
a separate `apps/api` (Cal.com's model) is right at hundreds of endpoints and overkill at fifteen.

The six uncalled `/api/missions/*` handlers are **deleted**, not migrated. Porting dead code
forward relocates debt rather than paying it.

The three with in-app callers **stay on their current paths** and are explicitly out of v1's scope:

- **`GET .../tasks/:taskId/stream`** — has a pending redesign in #43 (move streaming behind
  `BackendAdapter`, emit the AI SDK UI Message Stream). Relocating it now would mean moving it
  twice and would conflict with that work.
- **`POST /missions/:id/retrospect`** and **`PATCH /proposals/:id`** — internal client-component
  fetches, not operator surface. They may join a later version once the retrospective flow is
  something a CLI user drives.

This keeps v1's boundary clean: it contains exactly the operations a CLI operator needs, and
nothing that exists only because a React client wanted a plain HTTP response.

### Scope — aimed at a human at a CLI

| Group | Operations |
| --- | --- |
| Missions | list, create, get, plan, start, cancel, retry |
| Tasks | list, get, **approve**, **dismiss**, **steer**, **abort** |
| Ledger | mission events, task events |
| Repos | list, get policy, set policy |

The bolded operations exist today only as Server Actions. They are what turns a lifecycle API into
an operable one. The ledger read closes the highest-value gap in the product: auditability is the
headline claim and is currently reachable only through a browser.

### Auth — two paths, one identity

- **Browser** — session cookie, unchanged.
- **CLI** — better-auth's `device-authorization` plugin mints a session; the `bearer` plugin
  carries it as `Authorization: Bearer`. The flow is `gh auth login`: run `forge login`, get a
  code, approve in the browser, token stored under `~/.forge/`. (Deferred to Task 8, pending a
  consent page, client validation, and scope handling — see the auth-hardening commit.)

**Header convention.** The token is accepted as `Authorization: Bearer <token>` or `x-api-key:
<token>`, in that order. The sibling `managed-agents` server uses exactly this pair
(`src/mcp/app.ts:31`: *"`x-api-key` header first, else `Authorization: Bearer <key>`"*), so one CLI
can speak to both products without special-casing. Note the credential still resolves to a **user**
— unlike `managed-agents`, which has no user model and can therefore accept a single static
`MA_API_KEY`. Forge scopes everything by `missions.userId`, so a static key with no identity behind
it would require a synthetic user and reopen the ownership-scoping class of bug closed on
2026-07-27.

Both resolve through `auth.api.getSession()`. That is the point of the choice: `apiAuth()` needs no
change, every ownership check keeps working unmodified, and **no new auth primitive is invented**.
A five-hop cross-account authorization chain was found and closed in this codebase on 2026-07-27,
each hop caused by trusting a value a caller could set one step upstream. The cheapest way not to
repeat that is to add no new identity model.

Rejected for v1: hand-rolled API keys (#26) — most work, only option inventing auth surface, and no
integrator has asked. OIDC federation — better for CI, deferred to v2 with the CI use case, and
already precedented at `server/tick/oidc.ts` when it arrives.

### Schema-first

One Zod schema per operation in a shared registry, driving request validation, TypeScript types,
and a **generated** OpenAPI spec. Zod 4 is already the validation layer in `lib/missions.ts` and
the existing API routes.

Generation rather than hand-authoring is what keeps the spec honest: it derives from what handlers
actually validate, so drift is structurally impossible. The spec is committed and regenerated in
CI; a schema change not reflected in it fails the build. This supersedes an earlier idea of a
parity test asserting Server Action ↔ REST equivalence, which achieves less for more effort.

### Boundary rule

> Business logic lives in `lib/`. Server Actions are the **web app's** transport. `/api/v1` is the
> **public** transport. Both are thin. Streaming must be a route, because Server Actions cannot
> stream.

The web app does **not** call its own API over HTTP. Server components query the data layer
directly; that is the framework's design, and routing them through HTTP would cost a network hop,
break `revalidatePath`, and discard end-to-end type safety. Every shipping Next.js product
surveyed — Vercel, Dub, Documenso, Cal.com — keeps the dashboard off its own public API.

### Centralised auth

`middleware.ts` matching `/api/v1/*` resolves identity once, rather than fifteen handlers each
remembering the correct helper. That per-route pattern is exactly how `apiAuth()` and `withAuth()`
drifted into different failure modes, fixed on 2026-07-28 in `3536274`.

**Risk, to be resolved during planning:** Next middleware defaults to the edge runtime, and
better-auth's session lookup requires database access. Next 15.2+ supports `runtime: 'nodejs'` in
middleware config, but this is unverified against better-auth 1.6.9 on Cloud Run. **Fallback:** a
single `withApiAuth()` wrapper that every v1 route composes — same centralisation, one call per
route, no middleware. The plan must verify the middleware path works before adopting it, and fall
back without ceremony if it does not.

## Error shape

All v1 errors return a consistent JSON body — `{ error: { code, message } }` — with conventional
status codes. Ownership failures return **404, not 403**, so a resource's existence is not
observable across accounts. This matches the existing behaviour of `getMission`/`getTask`, which
return null for both non-existent and non-owned rows.

## Out of scope

- **The CLI itself.** This spec makes the API callable and adds the login flow. Building
  `forge` as a distributed binary is separate work.
- **Generated SDKs.** The OpenAPI spec enables them; producing them is later.
- **Org and role models.** Ownership stays per-user via `missions.userId`. Team-owned policy needs
  a model that does not exist.
- **API keys and OIDC federation.** v2, with the integrator and CI use cases respectively.
- **Rate limiting.** No external consumers yet; premature.

## Testing

- Every operation gets ownership-scoping coverage: a request authenticated as one user must not
  reach another user's resource, and the test must fail if the scoping is removed.
- The device-flow and bearer paths get adversarial review before merge, on the standard applied to
  the authorization work of 2026-07-27.
- Spec generation runs in CI; an ungenerated schema change fails the build.
- Every behaviour is mutation-tested: revert the change, confirm a specific named test fails,
  restore. Results are reported per behaviour, never bundled.
