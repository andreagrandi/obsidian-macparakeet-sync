# Meeting Notes Sync — Implementation Plan

> Status: **v1 complete** — MacParakeet sync shipped via GitHub issues [#1–#12](https://github.com/andreagrandi/obsidian-macparakeet-sync/issues) (see §10 for the executed order). **v2 planned** — rename, Fellow adapter, multi-source merge (see §12).
>
> v2 identity (rename pending; collision-checked against the community registry and GitHub on 2026-06-12): name **Meeting Notes Sync** · ID `meeting-notes-sync` · Repo `obsidian-meeting-notes-sync`
>
> Shipped v1 identity: name **MacParakeet Sync** · ID `macparakeet-sync` · Repo `obsidian-macparakeet-sync`

## 1. Context & Goal

MacParakeet (macOS local-first voice app) records meetings and stores transcripts, user notes, and AI prompt results ("summaries") in its SQLite database. This plugin syncs that meeting content into an Obsidian vault as markdown, one folder per meeting.

The plugin is fully independent of the MacParakeet codebase: it consumes only `macparakeet-cli`, the semver-versioned public contract (CLI 2.x at time of writing — see `Sources/CLI/CHANGELOG.md` upstream). It never reads `macparakeet.db` directly (internal schema, migration churn).

**Why CLI, not DB:** the CLI is documented for downstream integrations (`integrations/README.md` upstream), emits stable JSON, and is installed on every user's machine — bundled inside the app at `/Applications/MacParakeet.app/Contents/MacOS/macparakeet-cli` and also distributed standalone via `brew install moona3k/tap/macparakeet-cli`.

## 2. Decisions (settled during plan interview, 2026-06-12)

| Topic | Decision |
|---|---|
| Vault layout | One **folder per meeting**: `<base folder>/<path template>`, default template `Meetings/{year}/{month} - {monthName}/{n} - {title}` |
| Path config | Two settings: base folder + token template. Tokens: `{year}`, `{month}` (zero-padded), `{monthName}`, `{day}`, `{date}` (YYYY-MM-DD), `{n}`, `{title}` |
| Numbering `n` | Per-`{year}/{month}` counter, assigned at **first sync** in sync order, persisted in plugin state, **never reassigned**. Late-synced older meetings get the next free number in their month |
| Folder contents | Folder note index named like the folder (`{n}-{title}.md` — folder-note plugin compatible) + `Transcript.md` + `Notes.md` + one file per AI result named after its prompt |
| Update semantics | Plugin-owned files are **mirrors**: overwritten whenever source content changes. Files the plugin didn't create (user's own notes in the folder) are **never touched**. User does not hand-edit imported files; formatting changes go through plugin updates |
| New content | Always flows: a new AI result on an already-synced meeting becomes a new file on the next sync |
| Config retroactivity | Content toggles apply to meetings **as they are processed** (new or changed). Unchanged already-synced meetings are never re-touched just because a toggle changed — no proactive backfill |
| Backfill scope | "Sync meetings since" date setting, default = plugin install date. Move it back to import history deliberately |
| Content toggles | AI results **ON**, Meeting notes **ON**, Transcript **OFF** (transcripts are huge; opt-in) |
| Triggers | Manual command + ribbon icon; interval setting in minutes (default **30**, `0` disables); on-launch sync ~15 s after startup; single-flight guard |
| Incremental sync | One `meetings list --json` per sync; skip meetings whose `(updatedAt, promptResultCount)` match stored state — no detail fetches for unchanged meetings |
| Deletions | Never propagate. Vault is the archive; deleting a meeting in MacParakeet (e.g. to free disk) leaves the vault folder untouched. Out-of-scope meetings are ignored |
| Platform | Desktop-only (`isDesktopOnly: true`), macOS in practice (MacParakeet is macOS-only) |

## 3. Architecture

```
┌────────────────────────────── Obsidian (Electron) ───────────────────────────────┐
│  main.ts (Plugin)                                                                │
│   ├─ SettingsTab            settings UI                                          │
│   ├─ SyncScheduler          on-launch delay · interval timer · manual command    │
│   └─ SyncEngine             orchestrates one sync run (single-flight)            │
│        ├─ CliBridge         discovers + spawns macparakeet-cli, parses JSON      │
│        ├─ SyncState         data.json: counters, per-meeting records             │
│        ├─ PathPlanner       template → sanitized vault paths, n assignment       │
│        └─ NoteRenderer      JSON → markdown files (index, transcript, notes,     │
│                             one file per AI result) via Vault API                │
└───────────────────────────────────────────────────────────────────────────────────┘
                       │ child_process.execFile (JSON over stdout)
                       ▼
              macparakeet-cli  ──reads──►  ~/Library/Application Support/MacParakeet/macparakeet.db
```

### CLI surface used (the entire upstream contract we depend on)

| Call | Purpose | Key JSON fields |
|---|---|---|
| `health --json` | Validate CLI path at startup/settings change | db accessibility |
| `meetings list --limit 500 --json` | One per sync; change detection | `id`, `shortID`, `title`, `status`, `createdAt`, `updatedAt`, `durationMs`, `hasNotes`, `promptResultCount` |
| `meetings show <id> --json` | Fetch details for new/changed meetings | transcript (clean/raw), `userNotes`, speakers, engine, metadata |
| `meetings results list <id> --json` | Fetch AI results | per result: `id`, `name`, `content`, `promptContent`, `createdAt`, `updatedAt` |

Notes:
- `--limit 500` then client-side filter `status == "completed" && createdAt >= syncSince`. 500 is an internal cap, revisit if ever insufficient.
- Spawn with `execFile` (no shell), explicit binary path, reasonable timeout (e.g. 30 s), parse stdout as JSON, treat non-zero exit / `{"ok":false,...}` envelope as a sync failure for that step.

### CLI discovery (in order)

1. Manual override path from settings, if set.
2. `macparakeet-cli` resolved from common locations: `/opt/homebrew/bin`, `/usr/local/bin` (Electron does not inherit the user's shell `$PATH` — check these explicitly).
3. App bundle fallback: `/Applications/MacParakeet.app/Contents/MacOS/macparakeet-cli`.

Whichever resolves first is validated with `health --json`; result and resolved path shown in settings.

## 4. Settings

| Setting | Type | Default |
|---|---|---|
| CLI path override | text (path) | empty (auto-discover) |
| Base folder | text (vault path) | `MacParakeet` |
| Path template | text | `Meetings/{year}/{month} - {monthName}/{n} - {title}` |
| Sync meetings since | date | plugin install date |
| Sync AI results | toggle | on |
| Sync meeting notes | toggle | on |
| Sync transcript | toggle | **off** |
| Sync interval (minutes, 0 = off) | number | 30 |
| Sync on launch | toggle | on |

Settings live in `data.json` alongside sync state (standard `loadData`/`saveData`).

## 5. Plugin state (`data.json`)

```jsonc
{
  "settings": { /* §4 */ },
  "state": {
    "counters": { "2026/06": 3 },          // next n per {year}/{month} bucket
    "meetings": {
      "<meeting-uuid>": {
        "folderPath": "MacParakeet/Meetings/2026/06/2-Weekly Standup",
        "n": 2,
        "bucket": "2026/06",
        "snapshot": { "updatedAt": "...", "promptResultCount": 3 },   // skip check
        "files": {
          "index":      { "path": ".../2-Weekly Standup.md", "sourceUpdatedAt": "..." },
          "transcript": { "path": ".../Transcript.md", "sourceUpdatedAt": "..." },
          "notes":      { "path": ".../Notes.md", "sourceUpdatedAt": "..." },
          "result:<result-id>": { "path": ".../Summary.md", "sourceUpdatedAt": "..." }
        }
      }
    }
  }
}
```

- `files` is the authoritative list of plugin-owned paths — **only** these are ever written/overwritten. Anything else in the folder belongs to the user.
- `counters` + per-meeting `n` make numbering immutable across re-syncs and backfills.

## 6. Sync algorithm (one run)

1. **Guard**: if a sync is already running, return (single-flight).
2. **Resolve CLI** (cached after first success); on failure → Notice (manual sync) / quiet console + one non-spammy Notice (background), abort.
3. `meetings list --limit 500 --json` → filter `status == completed` and `createdAt >= syncSince`.
4. For each meeting, diff against `state.meetings[id].snapshot`:
   - **Unknown id** → NEW. **Known but `updatedAt` or `promptResultCount` differ** → CHANGED. **Else** → skip (no further I/O).
5. For each NEW meeting:
   - Fetch `show` + (if results toggle on) `results list`.
   - Assign `n` from the meeting's `{year}/{month}` bucket counter (from `createdAt`), increment counter.
   - Build folder path from template; sanitize `{title}`; create folder.
   - Render and write: index note, plus `Transcript.md` / `Notes.md` / one file per result, **per current toggles**.
   - Record snapshot + files in state.
6. For each CHANGED meeting:
   - Fetch details; for every artifact enabled by **current** toggles:
     - Artifact tracked in `files` and source newer → overwrite file.
     - Artifact not yet tracked (new result, or toggle newly on and content is new/changed) → create file, track it.
   - Files in `files` are never deleted, user files never touched. Update snapshot.
7. **Persist state**, then report: manual sync → Notice `"MacParakeet Sync: 2 new, 1 updated, 14 unchanged"`; background → console log, Notice only on errors (once per failure streak, not every 30 min).

**Known limitation (documented, accepted):** a result *regenerated in place* (same `promptResultCount`, and transcription `updatedAt` not bumped) may not be detected by the cheap diff. Escape hatch: a `Force re-sync MacParakeet meetings` command that treats all in-scope meetings as CHANGED.

## 7. Vault output

### Folder

`MacParakeet/Meetings/2026/06/2-Weekly Standup/`

### Index note — `2-Weekly Standup.md` (folder note)

```markdown
---
macparakeet-id: 550e8400-e29b-41d4-a716-446655440000
type: macparakeet-meeting
date: 2026-06-12T10:00:00Z
duration: 47m
engine: parakeet
---

# Weekly Standup

- [[Summary]] · [[Action items]]
- [[Notes]]
- [[Transcript]]
```

(Links rendered only for files that exist.)

### Artifact files

- `Transcript.md` — clean transcript; small frontmatter (`macparakeet-id`, `type: transcript`).
- `Notes.md` — the user's typed meeting notes from MacParakeet.
- One file per AI result, named from sanitized prompt name (`Summary.md`, `Action items.md`); frontmatter carries `macparakeet-id`, `result-id`, prompt name, generated date. Two results with the same prompt name → second gets ` (shortID)` suffix.

### Sanitization rules

- Strip/replace characters invalid in Obsidian filenames or links: `* " \ / < > : | ? # ^ [ ]` → `-`; collapse whitespace; trim dots/spaces at ends; cap `{title}` at 60 chars; empty → `Untitled Meeting`.
- Collisions are impossible at the folder level (`n` disambiguates); artifact collisions handled per above.

Formatting (frontmatter fields, index layout, heading styles) is expected to iterate via feedback after the first working version — owner reviews output and requests changes; no hand-editing of generated files.

## 8. Tech stack & scaffolding

- **TypeScript + esbuild**, structured after the official `obsidianmd/obsidian-sample-plugin` (manifest.json, `main.ts`, `versions.json`, esbuild config, `npm run dev` watch build).
- `manifest.json`: `id: macparakeet-sync`, `name: MacParakeet Sync`, `isDesktopOnly: true`, description noting it's an unofficial community integration.
- `.gitignore` (Node) extended with `main.js`, `*.js.map` — built artifacts ship only as GitHub release assets.
- **Tests: vitest** for pure logic, no Obsidian runtime needed: path templating, title sanitization, counter assignment, list-diff/skip logic, renderer output. CLI/Vault interactions isolated behind thin interfaces so the engine is testable with fakes.
- Dev loop: symlink/copy build output into a throwaway test vault's `.obsidian/plugins/macparakeet-sync/`, reload Obsidian, run against real local MacParakeet data.

## 9. Milestones

> Tickets for all milestones are filed as GitHub issues — see §10 for the issue map, execution order, and session workflow.

1. **M1 — Scaffold**: sample-plugin structure adapted, manifest, esbuild, vitest wired, plugin loads in a test vault (no behavior).
2. **M2 — CLI bridge + settings**: discovery chain, `health --json` validation, full settings tab, status surfaced in settings.
3. **M3 — Sync engine**: state model, list/diff/skip, fetch, path planning, rendering, manual sync command end-to-end against real data.
4. **M4 — Triggers + UX**: ribbon icon, interval timer, on-launch sync, single-flight, notices, force re-sync command.
5. **M5 — Release**: README (install incl. BRAT, setup, screenshots), GitHub release workflow (zip `main.js`+`manifest.json`), community-store submission PR to `obsidianmd/obsidian-releases`. Courtesy heads-up to the MacParakeet maintainer (moona3k).

### Verification (per milestone and overall)

- `npm test` green (pure-logic coverage as in §8).
- Manual end-to-end in test vault: first sync creates expected folders; second sync is a no-op (all skipped); generate a new AI result in MacParakeet → next sync adds exactly one file; toggle transcript on → old unchanged meetings untouched, next new meeting gets `Transcript.md`; add a personal note inside a meeting folder → never modified; delete a meeting in MacParakeet → vault unchanged.

## 10. Execution: ticket order & session workflow

All work is broken into GitHub issues [#1–#12](https://github.com/andreagrandi/obsidian-macparakeet-sync/issues). Each issue is self-contained — goal, context, task checklist, acceptance criteria, and its own end-to-end verification — and sized for a single focused session.

### How to run a session

1. Read this PLAN.md end to end first (decisions, architecture, state model — the issue assumes this context).
2. Work on exactly **one** issue: implement, unit-test, then run the issue's end-to-end verification section.
3. Branch per ticket (e.g. `issue-3-tracer-sync`), PR with `Closes #N` in the description, CI green before merge (once #10 has landed).
4. On the high-risk tickets **#3** and **#5** — they guard the "never touch user files" and "never renumber" invariants — run a code-review pass on the diff before merging.

### Order & parallelism

```
#1  Scaffold
 ├─ #10 CI             ┐
 ├─ #11 Dependabot     ├─ parallel batch after #1 (independent files; land #10 first
 └─ #2  CLI bridge     ┘  so every later PR gets a green/red signal)
#3  Tracer sync
#4  Path engine        (pure-logic core may start during #3 — interface pinned in §7)
#5  Full sync engine
 └─ #12 README v1      (parallel — docs only, no code conflicts)
#6  Settings tab
#7  Triggers & UX
#8  Release pipeline
#9  Final e2e matrix
```

Everything not marked parallel is sequential by real dependency: #5 needs #4's paths, #6 needs #5's config object, #7 needs #6's interval setting, #8 needs a finished plugin, #9 needs a tagged build. Don't force more parallelism — two sessions editing `main.ts`/the engine concurrently buys merge pain, not speed.

### Session type

Normal single-agent sessions, **one per ticket**. The codebase is small and every ticket fits one context window with room to spare; multi-agent/team sessions earn their cost on wide independent fan-out (audits, migrations), which none of these tickets has. The place for extra agents is *review* on #3/#5, not implementation. The parallel batch doesn't need a team either — three quick PRs in one session, or two terminals on separate branches.

### Milestone ↔ ticket map

| §9 milestone | Issues |
|---|---|
| M1 — Scaffold | #1, #10, #11 |
| M2 — CLI bridge + settings | #2 (bridge), #6 (settings UI) |
| M3 — Sync engine | #3, #4, #5 |
| M4 — Triggers + UX | #7 |
| M5 — Release | #8, #12 |
| Verification | #9 |

Where the ticket order differs from the milestone grouping (settings UI moved after the engine), the ticket order above wins.

## 11. Out of scope (v1) / future ideas

- Per-prompt allowlist for AI results; orphaned-meeting frontmatter marking; Dataview-friendly extra properties; syncing dictation history or file transcriptions; triggering `prompts run` from Obsidian; Templater-style custom note templates.

## 12. v2 — Multi-source: rename + Fellow adapter

> Status: **planned** (decisions settled 2026-06-12) — work is broken into GitHub issues [#23–#31](https://github.com/andreagrandi/obsidian-macparakeet-sync/issues) (see §12.6 for the map; same session workflow as §10). Goal: the same vault tree also ingests AI meeting recaps from [Fellow](https://fellow.ai), and meetings recorded by *both* Fellow and MacParakeet merge into one folder instead of duplicating.

### 12.1 Rename

One plugin, generic identity; sources become adapters named in the description. Everything here happens **before** the community-store submission — plugin IDs are immutable after store acceptance, and no release is published yet, so the rename is free now.

| Step | Detail |
|---|---|
| Repo | `gh repo rename obsidian-meeting-notes-sync` (old URLs redirect); update BRAT path + links in README, `authorUrl` in manifest |
| Manifest / package.json | `id: meeting-notes-sync`, `name: Meeting Notes Sync`, description: "Sync meeting transcripts, notes, and AI summaries from MacParakeet and Fellow into your vault" (name/ID must not contain "Obsidian") |
| Own vault migration | With Obsidian closed, rename `.obsidian/plugins/macparakeet-sync/` → `meeting-notes-sync/` so `data.json` (counters, snapshots, file ownership) carries over; otherwise next sync re-imports everything |
| Generalize conventions | Index frontmatter `type: macparakeet-meeting` → `type: meeting`; default base folder `MacParakeet` → `Meetings`. Per-source keys stay (`macparakeet-id`, new `fellow-id`) |

Collision check (2026-06-12): no `meeting-notes-sync` id/name in the community registry (closest — Meeting Notes Plus, Meeting Notes Synthesizer, Meetings Plus — all different purposes); GitHub repo name unclaimed; **no Fellow→Obsidian plugin exists anywhere**. Prior art is all single-source (`granola-sync` ×3, `plaud-sync`, `snipd-official`).

### 12.2 Fellow source (REST Developer API)

Docs: <https://developers.fellow.ai/> (index: `/llms.txt`). No CLI exists; the official MCP server is an OAuth connector for AI assistants — wrong transport for deterministic background sync. Webhooks (`ai_note.generated`, …) need a public HTTPS endpoint, so the plugin polls with `updated_at` filters instead.

- **Base URL** `https://{subdomain}.fellow.app/api/v1/` · auth header `X-API-KEY` · limits 3 req/s, 10k req/day (ample for 30-min polling)
- **Prerequisites**: paid Fellow plan; workspace admin enables the API (Workspace Settings → Security); user generates a personal key (User Settings → Developer Tools). Key is scoped to what the user can see in-app, revocable, audit-logged 90 days
- **Calls** (mirrors the v1 CLI surface): `GET /me` (health) · `POST /notes` with `updated_at_start/end` filters (list/change detection) · `GET /notes/{id}` with `include=content,attendees` → `content_markdown` (already markdown — minimal rendering work) · recordings endpoints with `include` for diarized transcripts (`speech_segments`) · action-items endpoints
- **Token storage**: plugin settings (`data.json`, plaintext — standard for API-backed community plugins). Masked password input + settings-tab warning about vault sync/git exposure
- **Open question (resolve first, one live API call):** the docs show no dedicated "AI summary" field — confirm whether the recap text arrives in the note's `content_markdown` or on the Recording object

### 12.3 Architecture

Second adapter implementing the same client facade `SyncEngine` already consumes: `FellowClient` (HTTP via Obsidian `requestUrl`) next to the existing `CliBridge`. Engine, renderer, path planner, and state machinery stay source-agnostic and unchanged in role. `isDesktopOnly: true` stays for now; mobile later only requires lazy-loading the CLI adapter behind `Platform.isDesktop` (no top-level `child_process` import).

### 12.4 Cross-source identity & merge

No shared ID exists (Fellow keys on calendar `event_guid`; MacParakeet uses local UUIDs), so matching is heuristic:

| Signal | Rule |
|---|---|
| **Primary — time-interval overlap** | MacParakeet interval = `createdAt + duration`; Fellow = recording start/end. Same meeting if overlap ≥ ~50% of the shorter recording (robust to late starts and differing lengths; exact-start matching is not) |
| **Secondary — normalized title similarity** | Tiebreaker for back-to-back/double-booked slots and confidence scoring only — titles routinely differ across sources. Uncertain merges get `merge-confidence: low` frontmatter for manual review |

State: `MeetingRecord` gains a canonical `interval {start, end}` and per-source bindings `sources: { macparakeet?: {id, snapshot}, fellow?: {id, snapshot} }`; `files` keys become source-scoped (`transcript:fellow`, `result:<id>` …). The existing per-source snapshot diff (§6) is untouched — identity resolution is a new layer on ingest (overlap lookup within the time bucket → bind to existing record or create one). First source to arrive freezes folder name + `{n}` (consistent with v1's never-renumber rule); the later source — often Fellow's recap, hours after — merges in by overlap match.

Vault output — one folder per real-world meeting, artifacts suffixed by source; index note links everything and carries both IDs + the interval (audit trail; enables manual un-merge of false positives):

```
Meetings/2026/06 - June/4 - Weekly Standup/
  4 - Weekly Standup.md        ← index: macparakeet-id + fellow-id + interval in frontmatter
  Summary (Fellow).md · Action Items (Fellow).md · Transcript (Fellow).md
  Summary (MacParakeet).md · Transcript (MacParakeet).md · Notes.md
```

### 12.5 Settings additions

| Setting | Type | Default |
|---|---|---|
| MacParakeet source enabled | toggle | **on** (preserves v1 behavior) |
| Fellow source enabled | toggle | **off** (strictly opt-in) |
| Fellow workspace subdomain | text | empty |
| Fellow API key | masked text | empty |
| Overlap threshold + minimum-overlap-minutes floor | advanced | 50% / sensible floor |

**Per-source enablement is a hard rule:** every source adapter is individually enable/disable-able, and a disabled source is completely inert — no fetches, no writes, no notices, no errors. Fellow ships **disabled by default** and only runs once explicitly enabled *and* configured (subdomain + key); this gating exists from the first client commit, not just from the settings-UI ticket. Disabling a source never touches already-imported content (vault is the archive, §2); re-enabling resumes incremental sync from existing state.

### 12.6 Milestones & tickets

| Milestone | Issues |
|---|---|
| **M6 — Rename** (§12.1, incl. own-vault migration) | [#23](https://github.com/andreagrandi/obsidian-macparakeet-sync/issues/23) |
| **M7 — Fellow client**: API spike (recap placement, §12.2), then `FellowClient` behind the facade, settings + health check | [#24](https://github.com/andreagrandi/obsidian-macparakeet-sync/issues/24) → [#25](https://github.com/andreagrandi/obsidian-macparakeet-sync/issues/25) → [#26](https://github.com/andreagrandi/obsidian-macparakeet-sync/issues/26) |
| **M8 — Multi-source state**: v1→v2 state migration, interval computation, identity resolution on ingest | [#27](https://github.com/andreagrandi/obsidian-macparakeet-sync/issues/27) → [#28](https://github.com/andreagrandi/obsidian-macparakeet-sync/issues/28) |
| **M9 — Merge rendering**: source-suffixed artifacts, merged index note, `merge-confidence` flagging | [#29](https://github.com/andreagrandi/obsidian-macparakeet-sync/issues/29) |
| **M10 — Release**: README rewrite, tagged release, community-store submission PR | [#30](https://github.com/andreagrandi/obsidian-macparakeet-sync/issues/30) |
| **Verification** — cross-source e2e matrix on real data | [#31](https://github.com/andreagrandi/obsidian-macparakeet-sync/issues/31) |

Order & parallelism:

```
#23 Rename                          ┐ independent starts: #24 needs only the
#24 Fellow API spike                ┘ Fellow workspace, not the codebase
#25 Fellow client      (after #24; coordinate with #27 — both touch the engine)
#26 Fellow settings    (after #25)
#27 Multi-source state (after #23; high-risk like v1 #3/#5 — review the diff)
#28 Identity resolution(after #25 + #27)
#29 Merge rendering    (after #28)
#30 Release            (after #23, #26, #29)
#31 e2e matrix         (after #30 — needs a tagged build)
```

### 12.7 Out of scope (v2)

Webhook-driven sync; OAuth/MCP transport; additional sources (Granola, Zoom, …) — the adapter seam makes them possible later; un-merge UI (manual via frontmatter audit trail).
