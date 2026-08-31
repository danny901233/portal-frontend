---
title: "AI receptionists for multi‑site garage groups: routing, handoffs, reporting"
description: "How to set up AI receptionists for 5+ garage sites: capacity‑aware call routing, clean branch handoffs, group‑level reporting, and the fixes for what breaks at scale."
publishedAt: 2026-08-31
author: auto
tags: ["multi-site", "call routing", "UK garages"]
topicKey: "multi-site-groups"
heroImage: "/blog/ai-receptionists-for-multi-site-garage-groups-routing-handoffs-reporting.png"
heroImageAlt: "Illustration for \"AI receptionists for multi‑site garage groups: routing, handoffs, reporting\""
---

Running five, ten or twenty branches changes the phone from a simple line into a system. Calls bounce between sites, diaries drift out of sync, local numbers live on, and head office loses sight of what’s actually happening. An AI receptionist built for UK garages can solve it, but only if it respects branches, capacity and the way groups really operate.

## Routing that respects branches (and capacity)

Multi‑site routing isn’t an IVR that says “press 1 for Stockport”. It’s rules that map callers to the right diary, first time, and don’t collapse when it’s busy.

Practical routing rules to set on day one:
- Numbers: keep local branch numbers live for SEO and customer habit; add a single group number for marketing. Route both through the AI with branch‑aware logic.
- Identification: use reg or postcode to anchor the caller. If they’ve booked before, use a “sticky branch” so repeat callers default to their last site unless they ask to change.
- Capacity: check live availability in each branch diary (Garage Hive, Tyresoft, etc.) before offering slots. If Branch A is full for tomorrow, offer Branch B that’s 3 miles away with space, then A’s next available.
- Skills and kit: map jobs to branches with the right ramps, ADAS kit, EV competence, and tyre stock. Don’t route a 20‑inch tyre fit to the fast‑fit pod that can’t do it.
- Fleet and trade: whitelist fleet numbers and route to a central team or a specific branch that holds their credit terms. The AI should recognise account names from caller ID and confirm purchase order rules.
- Opening hours: use per‑branch hours, bank holidays and training days. After hours, always answer, capture intent and let the caller choose to book, request a callback, or move to the nearest open site.
- Overflow: set ring‑through windows per branch (e.g. ring desk 12 seconds, then the AI answers). For peak weeks, tighten it so the AI catches more calls before queues form.
- Geography fallbacks: if the nearest branch has no courtesy cars or MOT slots this week, offer next‑nearest with the required resource, not just nearest by distance.

Example flow: A caller from SK3 says, “Puncture, can you help today?” The AI asks for reg, checks tyre size from DVLA data, sees Stockport is full but Cheadle has two same‑day tyre slots and the right stock profile. It offers Cheadle 14:20, or Stockport tomorrow 09:40. Caller picks Cheadle; booking lands in Cheadle’s diary with notes “puncture OSR, 225/45 R17”.

## Branch handoffs without dropped balls

At five sites, the problem isn’t answering; it’s how context survives a handoff.

Non‑negotiables for clean handoffs:
- Pass the packet: every transfer carries the transcript, reg, callback number, job type, quoted price, and any promises already made. If a human picks up, they see it. If the call returns to the AI, it resumes with context.
- Warm vs cold: use warm transfer when moving between branches or to head office. If the receiving line doesn’t answer within a set window, snap back to the AI and offer to book or take a message. No dead air, no voicemail maze.
- Wrong‑branch bookings: if the caller booked into the wrong site, the AI should be able to re‑site the job cleanly, preserving notes and cancelling the original slot without leaving orphan bookings.
- Duplicates: dedupe on reg + phone + date. If the caller tries to book the same MOT twice across two branches, surface the existing booking and offer to amend rather than creating noise.
- Special cases: courtesy car allocation, while‑you‑wait jobs, and warranty authorisations vary by site. The AI should check the right flag at the destination branch before promising anything.
- Sticky follow‑up: if a branch asks for a parts check and a callback, the task sits with that branch queue, not a group‑wide abyss. The AI can chase politely if no one calls back by a set time.

Trade‑off: full autonomy vs human sign‑off. For most groups, allow the AI to book standard services, MOTs and tyres up to a defined value; route clutch/engine diagnostics to a human at the chosen branch with all context attached.

## Group reporting that operators actually use

Dashboards for groups should answer three questions: are we answering, are we converting, and where are the leaks?

Metrics that earn their keep:
- Answer performance by site and hour: total calls, AI‑answered, human‑answered, and abandon rate. Look for spikes when phones ring out (often lunch or 08:30–09:00). Target: under 5% abandons during open hours.
- Booking conversion by intent and site: MOT, service, tyres, repairs. If Site A converts 68% of MOT intents and Site B does 49%, listen to transcripts and fix the script or capacity.
- Cross‑branch transfers: count, success rate, and time to resolution. More than a handful per day per site usually means your number mapping or Google profiles are confusing customers.
- Wrong‑site rebooks: bookings moved after creation. Track down‑stream labour loss and fix the routing rule that caused it.
- First response time to “call me back” tasks by branch: anything over an hour during open hours needs a process tweak or staffing.
- New vs existing customers per site: helps judge local marketing impact and “sticky branch” effectiveness.
- Peak intent mix: during MOT season, status‑chasing can dominate. Use this to plan proactive status texts to cut low‑value calls.

Reporting should be exportable per site and rolled up for the group, with call recordings and transcripts tied to the diary entry for audit. Keep data permissions tight: branch managers see their site; ops leads see all.

## What breaks at 5+ sites (and how to fix it)

The pitfalls are boring, operational, and very fixable if named up front.

- Inconsistent hours: branches quietly run different Saturdays. Fix: load a single source of truth for hours and holidays; the AI reads that, not a spreadsheet someone forgets to update.
- Price drift: MOT or labour rates vary by site. Fix: store per‑branch pricing and promotions; the AI quotes from the branch it’s booking into.
- Number sprawl: old ads and Google profiles point to dead DIDs. Fix: map every live number to a branch or the group, route through the AI, and 301‑redirect web click‑to‑calls where you can.
- Diary fragmentation: integrations aren’t uniform. Fix: connect each branch’s system directly; avoid “central diary then copy over” workflows that create lag and double‑bookings.
- Parts promises: one site carries OE filters, another doesn’t. Fix: set parts rules per job type per branch. If stock is unknown, the AI books with a “parts to confirm” flag and schedules a callback task.
- Language and accents: local names (e.g., Vale, Llanelli) trip generic systems. Fix: seed the AI with a pronunciation and spelling list per region and common customer names from your CRM.
- Governance: who can listen to what? Fix: set role‑based access, a retention policy for recordings/transcripts, and a one‑click “privacy pause” for card details if calls ever reach a human.
- Kill‑switch: occasionally, you’ll want to send every call to humans (power cut, diary outage). Fix: a per‑site toggle that bypasses the AI without ripping out numbers.

## A simple rollout plan for groups

- Map numbers and intents: list every phone number, per‑site hours, job types you’ll allow for auto‑booking, and where fleet/trade should land.
- Connect diaries per branch: read/write slots, courtesy cars and MOT bays as separate resources. Test conflict handling.
- Build routing rules: nearest‑with‑capacity, skills filters, sticky branch, overflow windows, and after‑hours flows.
- Script the edge cases: warranty, EVs, performance tyres, while‑you‑wait, and “car in today, update please.” Keep scripts short; rely on data, not monologues.
- Pilot with two contrasting sites: one busy urban, one smaller town. Measure conversion, transfers, and staff feedback for a fortnight.
- Train the humans: show how transcripts appear in the diary, how to warm‑transfer back to the AI, and how to re‑site a booking safely.
- Go group‑wide with a checklist: numbers pointed, hours loaded, kill‑switch known, reporting live, and a daily 10‑minute review for the first week.

AI reception that works at five sites looks boring: calls land in the right diary, promises are kept, and the dashboard shows where to tune the machine — if that’s the kind of boring you want, start here: /get-started or skim how peers run it at /case-studies.
