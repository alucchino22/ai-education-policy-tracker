// check-policy-updates.mjs
//
// Runs two passes:
//  1. VERIFY — for every entry in data/watchlist.json, checks whether the
//     source page / recent news still matches the stored note.
//  2. DISCOVER — since ~13,000 U.S. school districts can never be an
//     enumerated watchlist, runs a handful of broad national queries to
//     surface districts making AI-policy news that aren't tracked yet.
//
// Confidence decides what happens next:
//   high    -> auto-published: watchlist.json is updated (or a new district
//              row added) directly, and logged to data/activity-log.json.
//              Reserved for primary-source or multi-outlet-corroborated
//              findings (a .gov press release, an official board/agency
//              page, or 2+ independent reputable outlets agreeing).
//   medium  -> held in data/review-queue.json for a person to confirm —
//              typically a single news outlet with no official corroboration.
//   low     -> dropped. Not enough signal to act on or hold for review.
//
// Anything auto-published or held for review that needs attention opens a
// GitHub issue when run in GitHub Actions.
//
// Requires: ANTHROPIC_API_KEY env var. Node 20+ (uses global fetch).

import { readFile, writeFile } from "node:fs/promises";

const WATCHLIST_PATH = new URL("../data/watchlist.json", import.meta.url);
const REVIEW_QUEUE_PATH = new URL("../data/review-queue.json", import.meta.url);
const ACTIVITY_LOG_PATH = new URL("../data/activity-log.json", import.meta.url);
const ACTIVITY_LOG_MAX_ENTRIES = 300; // keep the log from growing without bound

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY env var.");
  process.exit(1);
}

const MODEL = "claude-sonnet-4-6";
const DELAY_MS = 600; // be polite between calls

// Thrown when the Anthropic API rejects a request for insufficient credit
// balance, so the run can stop immediately instead of retrying uselessly.
// This is a distinct error from a malformed request or a transient failure.
class CreditBalanceError extends Error {}

// Broad, unscoped queries meant to surface ANY district in the news for AI
// policy action — phrased several different ways since no single query
// reliably catches "ban," "moratorium," "guidance," and "board vote" stories.
const DISCOVERY_QUERIES = [
  "school district bans AI students",
  "school district generative AI moratorium",
  "school board votes AI policy",
  "school district releases AI guidance",
  "superintendent announces AI policy schools",
  "district blocks ChatGPT student devices",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pull the first {...} or [...] JSON value out of a text blob, tolerating
// stray prose or ```json fences around it.
function extractJson(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const match = candidate.match(/[\{\[][\s\S]*[\}\]]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/school district|unified|public schools|county|city of|schools/g, "")
    .replace(/[^a-z]/g, "")
    .trim();
}

async function callClaude(prompt, maxTokens = 1024) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    let apiMessage = bodyText;
    try {
      apiMessage = JSON.parse(bodyText)?.error?.message || bodyText;
    } catch {
      // not JSON, use raw text
    }
    // The API returns HTTP 400 with error.type "invalid_request_error" for
    // this case — same status as a malformed request — so match on the
    // message text specifically rather than the status code alone.
    if (res.status === 400 && /credit balance is too low/i.test(apiMessage)) {
      throw new CreditBalanceError(apiMessage);
    }
    throw new Error(`API error ${res.status}: ${bodyText.slice(0, 300)}`);
  }

  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

const CONFIDENCE_RUBRIC = `Set "confidence" using this rubric, since it determines whether this gets
published automatically or held for a person to check:
- "high": a primary/official source (a .gov site, a mayor's or governor's
  office, a school board or state education agency page) OR the same fact
  corroborated by 2+ independent reputable outlets (e.g., a wire service and
  a local paper both reporting it, not two outlets both citing the same
  press release).
- "medium": reported by exactly one reputable outlet (K-12 Dive, Chalkbeat,
  EdWeek, a major local news outlet) with no official page yet confirming it.
- "low": the source is unclear, unofficial, an opinion piece, or you're not
  confident the story is accurately characterized.
Do not default to "medium" out of caution — an official press release IS
high confidence even if you can't find independent corroboration yet.`;

async function checkEntry(entry) {
  const prompt = `You are verifying one row of a K-12 AI policy tracker.

Entity: ${entry.entity}
Level: ${entry.level}
Current stored category: ${entry.category}
Current stored note: ${entry.note}
Source URL: ${entry.source_url}
Last verified: ${entry.last_verified_date}

Do TWO kinds of searches, since a policy can change before any official page
reflects it:
1. Check the source URL itself and the entity's official education agency
   (or, for a district, mayor's office / school board) site for changes.
2. Separately, search for recent NEWS coverage from roughly the last 14 days
   using a query like "<entity> AI policy schools" or "<entity> generative AI
   ban" — press conferences, board votes, and superintendent announcements are
   routinely reported by outlets like K-12 Dive, Chalkbeat, local news, or
   national wires well before an agency's own guidance page is updated to
   match. Treat a credible, dated news report of an enacted or announced
   policy as sufficient grounds for "changed": true even if the official page
   hasn't caught up yet — note that gap in "reasoning".
Also check reputable trackers (AI for Education, FutureEd, ExcelinEd, PIE
Network) as a supplementary source, not a substitute for the news search.

${CONFIDENCE_RUBRIC}

Reply with ONLY a JSON object, no other text, in exactly this shape:
{
  "changed": true or false,
  "confidence": "high" | "medium" | "low",
  "new_category": "guidance" | "mandate" | "pending" | "none" (same value as current if unchanged),
  "new_note": "one or two sentence summary if changed, else empty string",
  "evidence_url": "the URL that supports your answer",
  "reasoning": "one sentence on why you think it did or didn't change"
}

If you cannot find enough information to be confident either way, set
"changed": false and "confidence": "low" rather than guessing.`;

  const text = await callClaude(prompt);
  const parsed = extractJson(text);
  if (!parsed) {
    throw new Error(`Could not parse a JSON verdict from response: ${text.slice(0, 300)}`);
  }
  return parsed;
}

async function discoverDistrictStories(knownNames) {
  const found = [];
  for (const query of DISCOVERY_QUERIES) {
    const prompt = `Search the web for: ${query}

Look specifically for U.S. K-12 SCHOOL DISTRICT (not state or federal) news
from roughly the last 14 days about artificial intelligence policy — a board
vote, a ban or moratorium, new guidance released, or a superintendent
announcement. Skip general commentary/opinion pieces and skip anything about
a specific named state agency or federal action (those are tracked
separately).

${CONFIDENCE_RUBRIC}

Reply with ONLY a JSON array (no other text), one object per distinct
district story found, in exactly this shape:
[
  {
    "district": "district name",
    "state": "two-letter state code if known, else empty string",
    "category": "guidance" | "mandate" | "pending",
    "confidence": "high" | "medium" | "low",
    "summary": "one or two sentence summary of what happened",
    "source_url": "the URL reporting this",
    "published_date": "YYYY-MM-DD if known, else empty string"
  }
]

If you find nothing matching, reply with an empty array: []`;

    try {
      const text = await callClaude(prompt, 1536);
      const parsed = extractJson(text);
      if (Array.isArray(parsed)) {
        found.push(...parsed);
      }
    } catch (err) {
      if (err instanceof CreditBalanceError) throw err; // stop the whole run, don't swallow this one
      console.error(`Discovery query failed ("${query}"): ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  // Dedupe against the watchlist (already tracked — the verify pass covers
  // these) and against duplicate hits across the different queries above.
  const seen = new Set();
  const newDistricts = [];
  for (const item of found) {
    if (!item.district) continue;
    const key = normalizeName(item.district);
    if (knownNames.has(key) || seen.has(key)) continue;
    seen.add(key);
    newDistricts.push(item);
  }
  return newDistricts;
}

async function loadJsonArray(path) {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function main() {
  const watchlist = JSON.parse(await readFile(WATCHLIST_PATH, "utf-8"));
  const reviewQueue = await loadJsonArray(REVIEW_QUEUE_PATH);
  const activityLog = await loadJsonArray(ACTIVITY_LOG_PATH);
  const runDate = new Date().toISOString().slice(0, 10);
  const runTimestamp = new Date().toISOString();

  const pendingReview = []; // medium confidence — needs a person to confirm
  const published = []; // high confidence — applied directly below, logged for visibility
  const failures = [];
  let haltedForCredits = false;
  let watchlistChanged = false;

  // --- Pass 1: verify known entries ---
  for (let i = 0; i < watchlist.length; i++) {
    const entry = watchlist[i];
    try {
      const verdict = await checkEntry(entry);
      if (verdict.changed && verdict.confidence === "high") {
        const before = { category: entry.category, note: entry.note };
        entry.category = verdict.new_category;
        entry.note = verdict.new_note;
        entry.source_url = verdict.evidence_url || entry.source_url;
        entry.last_verified_date = runDate;
        entry.needs_review = false;
        watchlistChanged = true;
        published.push({
          date: runDate,
          timestamp: runTimestamp,
          change_type: "update",
          entity: entry.entity,
          level: entry.level,
          previous_category: before.category,
          previous_note: before.note,
          category: entry.category,
          note: entry.note,
          source_url: entry.source_url,
          reasoning: verdict.reasoning,
        });
        console.log(`PUBLISHED (auto): ${entry.entity} — ${verdict.reasoning}`);
      } else if (verdict.changed && verdict.confidence === "medium") {
        pendingReview.push({
          type: "update",
          entity: entry.entity,
          level: entry.level,
          checked_on: runDate,
          current_category: entry.category,
          current_note: entry.note,
          suggested_category: verdict.new_category,
          suggested_note: verdict.new_note,
          confidence: verdict.confidence,
          evidence_url: verdict.evidence_url,
          reasoning: verdict.reasoning,
          status: "pending_review",
        });
        console.log(`NEEDS REVIEW: ${entry.entity} — ${verdict.reasoning}`);
      } else {
        console.log(`ok: ${entry.entity}`);
      }
    } catch (err) {
      if (err instanceof CreditBalanceError) {
        console.error(
          `STOPPING: Anthropic credit balance is too low (hit on entry ${i + 1} of ${watchlist.length}: ${entry.entity}). No further API calls will be made this run.`
        );
        haltedForCredits = true;
        break;
      }
      console.error(`FAILED: ${entry.entity} — ${err.message}`);
      failures.push({ entity: entry.entity, error: err.message, checked_on: runDate });
    }
    await sleep(DELAY_MS);
  }

  // --- Pass 2: discover new district stories nationally (skipped if halted above) ---
  if (!haltedForCredits) {
    const knownNames = new Set(
      watchlist.filter((e) => e.level === "district").map((e) => normalizeName(e.entity))
    );
    console.log("Running district discovery queries...");
    try {
      const discovered = await discoverDistrictStories(knownNames);
      for (const d of discovered) {
        const entityName = d.state ? `${d.district} (${d.state})` : d.district;
        if (d.confidence === "high") {
          const newEntry = {
            entity: entityName,
            level: "district",
            category: d.category,
            note: d.summary,
            source_url: d.source_url,
            last_verified_date: runDate,
            needs_review: false,
          };
          watchlist.push(newEntry);
          watchlistChanged = true;
          published.push({
            date: runDate,
            timestamp: runTimestamp,
            change_type: "new_entity",
            entity: entityName,
            level: "district",
            category: d.category,
            note: d.summary,
            source_url: d.source_url,
            reasoning: `Discovered via national news scan (published ${d.published_date || "date unknown"}), high-confidence source.`,
          });
          console.log(`PUBLISHED (new district): ${entityName} — ${d.summary}`);
        } else if (d.confidence === "medium") {
          pendingReview.push({
            type: "new_district",
            entity: entityName,
            level: "district",
            checked_on: runDate,
            suggested_category: d.category,
            suggested_note: d.summary,
            confidence: d.confidence,
            evidence_url: d.source_url,
            reasoning: `Discovered via national news scan, single-source. Published ${d.published_date || "date unknown"}.`,
            status: "pending_review",
          });
          console.log(`NEEDS REVIEW (new district): ${entityName} — ${d.summary}`);
        } else {
          console.log(`SKIPPED (low confidence): ${entityName} — ${d.summary}`);
        }
      }
    } catch (err) {
      if (err instanceof CreditBalanceError) {
        console.error("STOPPING: Anthropic credit balance is too low (hit during discovery pass).");
        haltedForCredits = true;
      } else {
        throw err;
      }
    }
  } else {
    console.log("Skipping discovery pass — run already halted for low credit balance.");
  }

  // Persist everything.
  if (watchlistChanged) {
    await writeFile(WATCHLIST_PATH, JSON.stringify(watchlist, null, 2) + "\n");
  }
  if (pendingReview.length > 0) {
    const updatedQueue = [...reviewQueue, ...pendingReview];
    await writeFile(REVIEW_QUEUE_PATH, JSON.stringify(updatedQueue, null, 2) + "\n");
  }
  if (published.length > 0) {
    const updatedLog = [...activityLog, ...published].slice(-ACTIVITY_LOG_MAX_ENTRIES);
    await writeFile(ACTIVITY_LOG_PATH, JSON.stringify(updatedLog, null, 2) + "\n");
  }

  // Emit outputs for the GitHub Actions workflow to consume.
  const summary = {
    run_date: runDate,
    checked: watchlist.length,
    published: published.length,
    needs_review: pendingReview.length,
    failed: failures.length,
    halted_for_credits: haltedForCredits,
  };
  console.log("SUMMARY", JSON.stringify(summary));

  if (process.env.GITHUB_OUTPUT) {
    await writeFile(
      process.env.GITHUB_OUTPUT,
      `published_count=${published.length}\nreview_count=${pendingReview.length}\nfailed_count=${failures.length}\nhalted_for_credits=${haltedForCredits}\ndata_changed=${watchlistChanged || pendingReview.length > 0 || published.length > 0}\n`,
      { flag: "a" }
    );
  }

  if (haltedForCredits) {
    await writeFile(
      "credit_alert.md",
      `The Anthropic API rejected requests today because the account's credit ` +
        `balance is too low. The run stopped as soon as this was detected — no ` +
        `further API calls were made, so this did not run up additional cost ` +
        `beyond what was already used.\n\n` +
        `Add funds or check the current balance under Plans & Billing in the ` +
        `Claude Console (platform.claude.com), then the next scheduled run (or ` +
        `a manual "Run workflow") will pick back up normally.\n`
    );
  }

  // Only open a review issue when something actually needs a person's
  // decision. Auto-published items are visible on the dashboard and in the
  // commit history — they don't need to interrupt anyone.
  if (pendingReview.length > 0) {
    const lines = pendingReview
      .map((f) =>
        f.type === "update"
          ? `- **${f.entity}** (${f.confidence} confidence): stored as _${f.current_category}_ — ${f.reasoning}\n  Suggested: _${f.suggested_category}_ — ${f.suggested_note}\n  Evidence: ${f.evidence_url}`
          : `- **${f.entity}** (new district, ${f.confidence} confidence): ${f.suggested_note}\n  Suggested category: _${f.suggested_category}_ · Evidence: ${f.evidence_url}`
      )
      .join("\n");
    await writeFile(
      "issue_body.md",
      `Daily AI & education policy check — ${runDate}${haltedForCredits ? " (stopped early — credit balance too low)" : ""}\n\n` +
        `${published.length} item(s) auto-published today (single-source, official, or corroborated — see the dashboard or commit history). ` +
        `${pendingReview.length} item(s) below need a decision:\n\n${lines}\n`
    );
  }

  if (failures.length > 0) {
    console.warn(`${failures.length} entries could not be checked this run (see log above).`);
  }

  // Exit non-zero when halted so the workflow run shows as failed — that's
  // the visible signal (and, if repo notifications are on, the email/alert)
  // that this needs attention. Outputs above are still written either way.
  if (haltedForCredits) {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
