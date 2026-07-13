---
title: "Inside a Garage Hive–AI receptionist link: call flow, fields and fixes"
description: "Plain-English breakdown of how an AI receptionist books into Garage Hive: call flow, data fields, setup pitfalls and the right questions to ask vendors."
publishedAt: 2026-07-13
author: auto
tags: ["Garage Hive", "AI receptionist", "Integrations"]
heroImage: "/blog/inside-a-garage-hive-ai-receptionist-link-call-flow-fields-and-fixes.png"
heroImageAlt: "Illustration for \"Inside a Garage Hive–AI receptionist link: call flow, fields and fixes\""
---

AI receptionists built for UK garages, like ReceptionMate, now plug straight into Garage Hive so calls can be answered, qualified and booked without waiting for a human. This guide explains what actually happens during a call, which fields get pushed into Garage Hive, common setup mistakes, and the questions worth asking before switching it on.

## What actually happens during the call

Here’s the typical live flow when the integration is enabled:

1) Call answered and intent identified  
The AI answers under your name, confirms it’s the right garage and works out what the caller wants: MOT, service, tyres, repair, quote, callback, or something else.

2) Caller and vehicle captured  
It asks for essentials: full name, mobile number, vehicle reg (VRM). If the caller won’t give a VRM, it can still take a message or book a generic slot (not ideal).

3) Lookup and match in Garage Hive  
Using the phone and VRM, the system checks for an existing customer and vehicle. If found, it uses those records. If not, it will create them.

4) Job type and duration chosen  
The AI maps the caller’s request to a pre-approved list of job types and durations you’ve provided (e.g. MOT 45m, Interim Service 1h30, MOT+Service 2h15, Puncture Repair 30m). No guessing: it only books what you’ve allowed.

5) Availability checked in your diary  
The integration reads free/busy in Garage Hive and, if configured, the specific calendars/resources (ramps, MOT bay, EV ramp, tyre bay, technician groups). It offers the nearest suitable slots inside your opening hours and booking windows.

6) Booking created and confirmed  
When the caller accepts a time, it creates a booking in Garage Hive with the right customer, vehicle, job type(s), resource, duration and notes. It can send a confirmation by SMS/email with your wording.

7) Notes, disclaimers and next steps  
Any extra details (warning lights, noises, “customer will wait”, “needs collection”, locking wheel nut) are saved against the booking. Some garages choose “provisional + review” for the first week, then move to confirmed once happy.

A simple example:  
Caller needs an MOT and interim service on AB12 CDE. The AI verifies name and mobile, finds no existing record, uses VRM lookup for make/model, books the combined job for 2h15 on Tuesday 10:30 in the MOT bay + Service ramp, adds “customer will wait; locking wheel nut present”, sends confirmation, and your Garage Hive diary shows the job instantly.

## The fields that land in Garage Hive (and where)

Exact objects and labels vary by Garage Hive setup, but this is the usual mapping:

- Customer  
  - Full name  
  - Mobile (primary), secondary phone if provided  
  - Email (for confirmations)  
  - Marketing consent flag (yes/no), and consent timestamp  
  - Postcode/address if you choose to collect it

- Vehicle  
  - VRM (mandatory for most flows)  
  - Make/model/derivative from VRM lookup (where enabled)  
  - Fuel type/engine if available from lookup  
  - Mileage (optional, but handy)  
  - MOT due date (if provided or fetched via your usual process)

- Booking/Job  
  - Job type(s) from your approved list (e.g. MOT, Interim Service)  
  - Duration and buffers  
  - Date/time  
  - Resource/diary (MOT bay, tyre bay, EV ramp, technician group)  
  - Booking status (provisional or confirmed, per your policy)  
  - Notes/complaint description, customer wait/collection/delivery, courtesy car required  
  - Price estimate or “TBC” (your choice; most garages avoid quoting on complex jobs)

- Communications and audit  
  - Call summary note and who booked it (AI tag)  
  - Confirmation message content (SMS/email)  
  - Source channel (e.g. Inbound call, Out-of-hours) for reporting

- Dedupe rules  
  - Match by phone and VRM before creating new customer/vehicle  
  - If conflict, attach the booking and flag for review rather than create duplicates

## Setup mistakes that cause messy diaries

- Letting the AI book “anything”  
  Start with 6–12 safe job types you’re happy to fill automatically. Avoid open-ended repairs, diagnostics and quotes at first.

- No duration discipline  
  Agree standard durations and add buffers. MOT+Service combos need their own timings; don’t rely on “MOT 45m + Service 90m” addition if resources are different.

- Resource mapping gaps  
  Tie job types to the right calendars (MOT bay vs general ramp vs tyre bay). If you allow MOTs to land in the wrong diary, you’ll learn the hard way.

- Courtesy car capacity ignored  
  If a booking has “courtesy car required”, ensure the AI checks availability before confirming. Otherwise you’ll be rearranging all morning.

- Duplicate customers and vehicles  
  Decide matching rules upfront (VRM + mobile preferred). If the caller gives a landline but you hold a mobile, the system may create a duplicate unless configured.

- Over-promising on quotes  
  Don’t let the AI price complex work. Use ranges or “advisor to confirm” and park those jobs in a review queue.

- Open hours and bank holidays  
  Keep Garage Hive calendars accurate. If opening hours differ by site or day, reflect that so the AI doesn’t offer Sunday slots or book over training days.

- Confirmation templates not updated  
  Your confirmation should state arrival time, location, cancellation policy, and what to bring (locking wheel nut, keys, service book if relevant). Skipping this drives no-shows and delays.

## Guardrails that make week one smooth

- Require VRM and mobile for any confirmed booking; otherwise take a message.  
- Limit to MOT, services, punctures and simple tyres for the first fortnight.  
- Use provisional status for complex combos until a human reviews.  
- Offer only the next 14–21 days to keep control of parts and staffing.  
- Enable SMS/email confirmations and 24-hour reminders with a reschedule link.  
- Add “notes must include customer wait/collection” so reception isn’t surprised.  
- Review the AI-booked queue at 8:30 and 16:30 for the first week; tighten rules based on what you find.  
- Tag AI bookings with a clear source so you can report on show rate and upsells.

## Questions to put to any AI receptionist vendor

- Availability logic  
  How do you read Garage Hive availability: simple free/busy, or resource-level (MOT bay, tyre bay, tech groups)? Can you respect booking caps per job type and courtesy car limits?

- Matching and dedupe  
  What rules prevent duplicate customers/vehicles? Can we choose “attach to closest match, flag for review” rather than create new?

- Job type mapping  
  Who sets durations and buffers? Can we block certain jobs or require human approval for diagnostics, clutches, timing belts, EV HV work?

- Cancellations and reschedules  
  Can the AI move or cancel bookings and free the slot in Garage Hive? What’s the audit trail?

- Data capture and consent  
  Do you record marketing consent with timestamp and store call recordings/transcripts in line with GDPR? Can customers opt out easily?

- VRM and pricing  
  Do you use VRM lookup? Can we avoid hard prices and use templates or ranges? How do you handle service schedules if asked?

- Multi-site handling  
  Can the AI route calls to the right site and book into the correct Garage Hive company/diary with site-specific hours and job lists?

- Out-of-hours behaviour  
  Is booking still live after hours? Can we switch to “message only” outside certain windows?

- Fail-safes and alerts  
  What happens if Garage Hive is unavailable? Do you queue bookings and notify us? Can we get a daily digest of AI-booked jobs?

- Security and access  
  How is the Garage Hive API key stored? Can we restrict permissions to “create/update bookings only”? Is access logged?

- Change control  
  How quickly can we update job types, durations, and scripts? Who owns testing and sign-off before going live?

Done right, an AI receptionist can put clean, accurate work straight into Garage Hive without creating chaos — if you set tight rules, map job types to the right resources, and hold the vendor to clear answers on the above; to see how this looks in the real world, browse the [case studies](/case-studies).
