# AI & education policy tracker — live dashboard + daily update check

A dashboard (`index.html`) backed by a scheduled job that checks federal and
state sources for changes and scans nationally for district-level AI policy
news — every day, automatically. High-confidence findings publish directly;
lower-confidence ones wait for a person to confirm.

## What's here

- `index.html` — the dashboard. Fetches its data from the `data/` folder at
  runtime rather than having it baked in, so a daily commit to those files
  is all it takes to update what people see — no rebuild step.
- `data/watchlist.json` — the live dataset: every federal, state, and district
  entry shown on the dashboard, plus the metadata (source URL, confidence
  history) the daily check needs to re-verify it. This file **is** the
  dashboard's data source, not a separate internal list.
- `data/activity-log.json` — a rolling log of what the daily job auto-published
  (capped at the most recent 300 entries), shown as "Recent activity" on the
  dashboard.
- `data/review-queue.json` — lower-confidence findings awaiting a person's
  confirmation, shown as "Needs review" on the dashboard.
- `scripts/check-policy-updates.mjs` — runs two passes daily:
  1. **Verify** — for each watchlist entry, asks Claude (web search on)
     whether the source page *and* recent news (last ~14 days) still match
     the stored note.
  2. **Discover** — six broad national queries (e.g. "school district bans
     AI students," "school board votes AI policy") to surface districts
     making AI-policy news that aren't tracked yet, since ~13,000 districts
     can never be an enumerated watchlist.

  Every finding gets a confidence level and is routed accordingly — see
  "How confidence decides what happens" below.
- `.github/workflows/check-policy-updates.yml` — runs the script daily at
  noon Eastern (self-adjusting for daylight saving), commits any data
  changes, and opens a GitHub issue only for items that need a decision.

## Setup

1. Put this folder at the root of a repo, and enable **GitHub Pages** for it
   (Settings → Pages → Deploy from a branch → root). The dashboard depends
   on `index.html` and `data/` being served from the same origin — opening
   `index.html` directly from disk will not work, since browsers block
   local-file fetches (the page shows a banner explaining this if it happens).
2. Add a repo secret named `ANTHROPIC_API_KEY` (Settings → Secrets and
   variables → Actions → New repository secret).
3. That's it — the workflow runs automatically on the schedule, or you can
   trigger it by hand from the Actions tab (**Run workflow**). Once it commits
   an update, GitHub Pages picks up the new `data/*.json` files automatically
   — no separate deploy step.

## How confidence decides what happens

Every finding — whether re-verifying a known entry or discovering a new
district — gets a confidence level, and that level decides the outcome:

| Confidence | Meaning | What happens |
|---|---|---|
| **High** | A primary source (`.gov` page, official agency/board/mayor's-office announcement) or independent corroboration from 2+ reputable outlets | **Auto-published** — `watchlist.json` is updated (or a new district row added) directly, logged to `activity-log.json`, and shown on the dashboard. No issue opened. |
| **Medium** | A single reputable outlet, no official confirmation yet | Held in `review-queue.json`, shown as "Needs review" on the dashboard, and included in the daily GitHub issue. |
| **Low** | Unclear, unofficial, or the model isn't confident | Dropped. Not enough signal to act on or worth holding for review. |

The bar for "high" is deliberately about source quality, not entity
familiarity — a brand-new district reported directly by its own school
board carries the same confidence as a well-known state's official page
updating. The NYC and LAUSD stories from September 2026, for example, would
both auto-publish under this rubric: official government sources,
corroborated by multiple outlets, describing already-enacted policy.

## What happens when something's flagged for review

- Appended to `data/review-queue.json` with `status: "pending_review"`, the
  suggested category/note, a confidence level, and the evidence URL.
- Shown in the dashboard's "Needs review" section so it's visible without
  checking GitHub.
- A GitHub issue (`needs-review` label) summarizes the day's review items —
  only opened when there's actually something to decide.
- Confirming or rejecting a review-queue item is currently a manual edit to
  `data/review-queue.json` and `data/watchlist.json` (move the confirmed
  fact into the watchlist, delete the queue entry). Automating that
  approve/reject step — e.g. a button on the dashboard itself — is a natural
  next piece if the manual edit becomes a bottleneck.

## Real limits of the discovery pass — read before relying on this

- **It cannot see all ~13,000 districts.** Six broad queries will surface
  large, well-covered districts and stories that got real news pickup —
  which is exactly the kind of story most likely to matter for a national
  policy landscape scan, but it will systematically miss small or rural
  districts unless a local outlet's story happens to surface in a general
  web search.
- **It's a daily snapshot, not real-time.** A story breaking hours before
  the scheduled run (as happened with the LAUSD story LAist broke same-day)
  may or may not be indexed yet when the search runs. For same-day
  reliability, pair this with a push-based source — a Google Alert or a news
  API — rather than relying on the daily pull alone.
- **"Medium confidence" means "worth checking," not "verified."** The model
  can misidentify a district, conflate a proposal with an enacted policy, or
  pick up an outdated recirculated story. Every review-queue item should be
  read against its evidence URL before being confirmed.
- **"High confidence" is not infallible either** — it's a bar calibrated to
  catch clear cases like NYC's and LAUSD's official announcements without
  needing a person to rubber-stamp the obvious. It will occasionally
  auto-publish something that turns out to be wrong (a misread page, a
  premature announcement that gets walked back). The activity log exists
  specifically so that's checkable after the fact, not just trusted blindly.

## What happens if the account runs out of credit

The script recognizes the specific error the API returns when the credit
balance is too low (`HTTP 400`, message *"Your credit balance is too low to
access the Anthropic API"*) and treats it differently from an ordinary
failure:

- It **stops immediately** — no further watchlist entries or discovery
  queries are attempted that run. Because a low-balance request is rejected
  before any tokens are processed, this doesn't add cost beyond whatever was
  already spent earlier in the run.
- Whatever was found before the stop (flags, new districts) is still saved
  to `data/review-queue.json` and committed — a partial run isn't discarded.
- It opens a **separate** GitHub issue (`billing-alert` label) rather than
  folding this into the regular daily-flags issue, and marks the workflow
  run as failed so it's visible in the Actions tab.
- The next scheduled run (or a manual "Run workflow") picks back up normally
  once the balance is topped up — nothing needs to be reset.

This only guards against the specific "out of credit" condition. It does not
cap spending before that point — see "Cost and rate expectations" below for
estimating what a normal day costs, and consider setting a spend limit or
alert in the Claude Console if you want a ceiling enforced from the billing
side rather than relying on the account simply running dry.

## Cost and rate expectations

Verify pass: 1 API call per watchlist entry (with web search), daily.
Discover pass: 6 additional calls, daily. Both are modest relative to a
person re-checking sources by hand, but confirm against current Claude API
pricing for your expected watchlist size.

## Next steps (not built yet)

- **An approve/reject action on the dashboard itself** for review-queue
  items, instead of a manual JSON edit — the natural next piece once the
  daily review volume makes that edit tedious.
- **A push-based alert layer**: Google Alerts or a news API feeding the
  same review queue, to close the same-day gap the daily pull can't.
- **De-duplicate issues**: right now every run with review items opens a new
  issue; a small tweak could instead update one running issue per day.
- **Spot-check the auto-publish bar over time**: if the activity log starts
  showing high-confidence items that turn out wrong, the confidence rubric
  in the script's prompts is the place to tighten.
