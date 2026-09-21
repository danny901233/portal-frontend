/**
 * 30 simulated conversations per diary, against TEST ACCOUNTS ONLY.
 *
 * An LLM plays the customer, pursuing a goal turn by turn; the unified chat agent answers
 * with its real prompt, real tools and the real diary. A second LLM then judges the whole
 * transcript against what a good conversation looks like.
 *
 * Scripted turn-by-turn tests were what the voice merge relied on for too long, and they
 * could not see the things customers actually complain about — repetition, waffle, being
 * asked the same thing twice. This can.
 *
 *   npx tsx src/services/chatDiaries/__harness__/runConversations.ts <diary> [count]
 */

import OpenAI from 'openai';
import { PrismaClient } from '@prisma/client';
import { getUnifiedChatResponse, invalidateUnifiedSession } from '../../unifiedChatAgent.js';

// Before anything imports the agent: take_message notifies staff, and a 30-conversation run
// would otherwise send 30 pushes to real phones. The benchmark reads the same flag.
process.env.CHAT_SCENARIO_RUN = '1';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const SIM_MODEL = process.env.SIM_MODEL || 'gpt-4.1-mini';
const prisma = new PrismaClient();

const TEST_GARAGES: Record<string, string> = {
  garagehive: '844385bf-199d-426f-8b1e-caaa98cdc21e',
  tyresoft: 'a72e3f2f-dc68-42d8-b4b0-9d9eea48cc1b',
  bookar: '8e9548b0-9f23-4344-816e-a24605998759',
  poole: '5314e15a-0969-4f69-ba83-53c2e0250368',
};

const MAX_TURNS = 12;

interface Scenario { label: string; goal: string; expect: string; diaries?: string[] }

const CUSTOMER = 'You are Dan, a real customer messaging a garage. Your car is V20ALA and '
  + 'your number is 07976500282. Your postcode is CB23 9AZ, house number 55, mileage about '
  + '25000. Write ONE short message at a time, the way a person types — no lists, no '
  + 'narration. If you are asked something you have already answered, say so plainly ("I\'ve '
  + 'already given you that") and do not repeat yourself a third time. When your goal is met '
  + 'or clearly cannot be, reply with exactly DONE.';

/** Common to every diary — shared machinery, so a regression shows up on all four. */
const COMMON: Scenario[] = [
  { label: 'Book a routine service', goal: 'Book a full service, soonest you can get.',
    expect: 'Quotes only from the garage price list, offers real times, and confirms a booking.' },
  { label: 'Book an MOT', goal: 'Book an MOT, you prefer a morning.',
    expect: 'Books an MOT and reads the date back with the weekday, OR follows the garage\'s own rule if it does not take MOT-only bookings. Following a configured rule is correct.' },
  { label: 'Ask a price then book', goal: 'Ask what a full service costs, then book it if it sounds fair.',
    expect: 'Gives a price only from a tool, never estimates, then books it.' },
  { label: 'Two jobs at once', goal: 'You want an MOT AND the brakes looked at, same visit.',
    expect: 'Keeps BOTH jobs together on one booking and mentions both at the end. Losing either silently is the failure.' },
  { label: 'Does not know what is needed', goal: 'Your car is due something but you do not know what. Ask them to advise.',
    expect: 'Helps without demanding the customer remember their own service history, and books something sensible or takes a message.' },
  { label: 'Fault, not a service', goal: 'There is a grinding noise from the front when you brake.',
    expect: 'Asks about the symptom before quoting, and books a diagnostic or equivalent rather than an unrelated job.' },
  { label: 'Wants a day they are closed', goal: 'Ask for Sunday. Take whatever is offered instead.',
    expect: 'Says Sunday is not available and offers real alternatives instead of inventing one.' },
  { label: 'Changes the date', goal: 'Pick a slot, then change your mind and ask for a later day.',
    expect: 'Re-checks availability and confirms the new day without losing the booking.' },
  { label: 'Will not give a number', goal: 'Refuse to give a phone number when asked.',
    expect: 'Does not promise a call back it cannot make, and still records the request.' },
  { label: 'Something they cannot do', goal: 'Ask for a full respray.',
    expect: 'Says plainly it cannot book that and takes a message, rather than booking it under something else.' },
  { label: 'Asks opening hours', goal: 'Ask what time they open on Saturday. Book nothing.',
    expect: 'Answers from the garage\'s configured hours and does not invent times.' },
  { label: 'Gives the reg unprompted', goal: 'Give your registration in your very first message.',
    expect: 'Uses the registration it was given and never asks for it again.' },
  { label: 'Very short answers', goal: 'Answer in one or two words throughout.',
    expect: 'Keeps making progress without repeating questions or stalling.' },
  { label: 'Asks about an existing booking', goal: 'Ask what time you are booked in for.',
    expect: 'Either looks it up if the diary can, or takes a message — never invents a time.' },
  { label: 'Mishears the postcode', goal: 'Give your postcode, then correct it when read back wrong.',
    expect: 'Asks for the postcode on its own if it asks at all, and does not ask twice. If this garage needs no address it should not ask at all.' },
  { label: 'Asks for the cheapest option', goal: 'Ask what the cheapest way to get the car serviced is.',
    expect: 'Quotes only real figures and never invents a cheaper one.' },
  { label: 'Wants it today', goal: 'Ask if you can bring it in today.',
    expect: 'Answers honestly about the earliest it can actually do, without inventing a slot.' },
  { label: 'Two vehicles', goal: 'Ask about booking two different cars in.',
    expect: 'Handles it without confusing the two registrations.' },
  { label: 'Changes their mind mid-booking', goal: 'Start booking a service, then switch to just an MOT.',
    expect: 'Switches cleanly without asking for the registration again.' },
  { label: 'Silence then a question', goal: 'Send "hello?" first, then ask to book a service.',
    expect: 'Answers warmly and gets on with the booking.' },
  { label: 'Complains about a past job', goal: 'Complain that work last month did not fix the problem.',
    expect: 'Does not try to book it away — takes a message so a person deals with it.' },
  { label: 'Asks where they are', goal: 'Ask for the address and whether there is parking.',
    expect: 'Answers from the garage information it has, and does not invent details.' },
  { label: 'Books for someone else', goal: 'You are booking on behalf of your partner.',
    expect: 'Takes the booking without confusing whose details are whose.' },
  { label: 'Asks for a callback', goal: 'Ask someone to ring you instead of doing it by message.',
    expect: 'Takes a message with a number and does not promise a call it has not logged.' },
  { label: 'Gives a wrong registration first', goal: 'Give ZZ99ZZZ first, then correct it to V20ALA.',
    expect: 'Recovers and books on the corrected registration; the earlier mistake must not break the booking.' },
];

const TYRE: Scenario[] = [
  { label: 'Two front tyres', goal: 'You need the two front tyres replacing, premium.',
    expect: 'Reads the tyre size back from the vehicle record rather than asking for the sidewall, asks the quality tier before offering, quotes real prices and books a fitting.' },
  { label: 'Tyres and an MOT', goal: 'Two front tyres AND an MOT on the same visit.',
    expect: 'Puts both on ONE job and confirms them together.' },
  { label: 'Does not know the size', goal: 'You want two front tyres but have no idea of the size.',
    expect: 'Looks the size up from the registration and reads it back for confirmation.' },
  { label: 'Size not in stock', goal: 'Insist you need 999/99 R99.',
    expect: 'Says plainly it has nothing in that size and offers a callback, never substituting another size.' },
  { label: 'Asks for the cheapest tyre', goal: 'Ask for the cheapest tyres they do.',
    expect: 'Asks the tier or offers budget honestly, and never calls a budget brand premium.' },
];

const SERVICE: Scenario[] = [
  { label: 'Unusual one-off job', goal: 'Ask for a cambelt change.',
    expect: 'Books it under a catch-all if it is not listed, saying the team will confirm the price, rather than refusing.' },
  { label: 'Earliest possible slot', goal: 'Ask for the soonest appointment there is.',
    expect: 'Offers the genuinely earliest slot the diary returned.' },
  { label: 'Move an existing booking', goal: 'Ask to move your booking to a different day.',
    expect: 'Moves it if the diary can, otherwise takes a message — never claims a change it did not make.' },
  { label: 'Cancel a booking', goal: 'Ask to cancel a booking you made last week.',
    expect: 'Cancels it if the diary can, otherwise takes a message — never claims a cancellation it did not make.' },
  { label: 'Asks if they know the car', goal: 'Ask whether they have seen your car before.',
    expect: 'Answers honestly about what it can and cannot see, without implying records it does not have.' },
];

function scenariosFor(diary: string): Scenario[] {
  const extra = diary === 'tyresoft' ? TYRE : SERVICE;
  return [...COMMON, ...extra].slice(0, 30);
}

async function customerTurn(goal: string, transcript: string[]): Promise<string> {
  const res = await openai.chat.completions.create({
    model: SIM_MODEL,
    messages: [
      { role: 'system', content: `${CUSTOMER}\n\nYOUR GOAL: ${goal}` },
      { role: 'user', content: transcript.length
        ? `The conversation so far:\n${transcript.join('\n')}\n\nYour next message:`
        : 'Send your first message.' },
    ],
  });
  return (res.choices[0]?.message?.content || 'DONE').trim();
}

async function judge(scn: Scenario, transcript: string[]): Promise<{ pass: boolean; why: string }> {
  const res = await openai.chat.completions.create({
    model: SIM_MODEL,
    messages: [
      { role: 'system', content: 'You judge a garage receptionist conversation against what a '
        + 'good one looks like. Be strict about repetition, invented prices or times, and '
        + 'claiming something was booked or passed on when it was not. Following the garage\'s '
        + 'own configured rule is CORRECT, not a failure. Reply with PASS or FAIL then one '
        + 'sentence of reason.' },
      { role: 'user', content: `WHAT GOOD LOOKS LIKE: ${scn.expect}\n\nTRANSCRIPT:\n${transcript.join('\n')}` },
    ],
  });
  const out = (res.choices[0]?.message?.content || 'FAIL no verdict').trim();
  return { pass: /^PASS/i.test(out), why: out.replace(/^(PASS|FAIL)[:\s-]*/i, '').slice(0, 150) };
}

async function runOne(garageId: string, scn: Scenario, n: number): Promise<{ pass: boolean; why: string; turns: number }> {
  const conversationId = `harness-${Date.now()}-${n}-${Math.random().toString(36).slice(2, 8)}`;
  const transcript: string[] = [];
  let turns = 0;
  try {
    for (let i = 0; i < MAX_TURNS; i += 1) {
      const msg = await customerTurn(scn.goal, transcript);
      if (/^DONE\b/i.test(msg)) break;
      transcript.push(`Customer: ${msg}`);
      const reply = await getUnifiedChatResponse(garageId, msg, conversationId,
                                                 { phone: '07976500282' });
      transcript.push(`Agent: ${reply.content}`);
      turns += 1;
    }
  } catch (e: any) {
    return { pass: false, why: `threw: ${String(e?.message || e).slice(0, 120)}`, turns };
  } finally {
    invalidateUnifiedSession(conversationId);
  }
  if (!transcript.length) return { pass: false, why: 'no conversation happened', turns };
  const v = await judge(scn, transcript);
  // Keep the transcript of anything that failed. Judging gives one sentence, and two rounds
  // of prompt changes were made off that sentence alone and moved nothing.
  if (!v.pass) {
    const fs = await import('fs');
    fs.mkdirSync('/tmp/conv_transcripts', { recursive: true });
    fs.writeFileSync(`/tmp/conv_transcripts/${process.argv[2]}-${String(n).padStart(2, '0')}.txt`,
      `SCENARIO: ${scn.label}\nEXPECTED: ${scn.expect}\nVERDICT: ${v.why}\n\n${transcript.join('\n')}\n`);
  }
  return { ...v, turns };
}

async function main() {
  const diary = process.argv[2];
  const limit = Number(process.argv[3] || 30);
  const garageId = TEST_GARAGES[diary];
  if (!garageId) throw new Error(`unknown diary "${diary}"`);

  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT name FROM "Garage" WHERE id = $1`, garageId);
  const name = String(rows[0]?.name || '');
  if (!/test/i.test(name)) throw new Error(`REFUSING: "${name}" is not a test garage`);
  console.log(`\n=== ${diary} — ${name}`);

  const scns = scenariosFor(diary).slice(0, limit);
  let pass = 0;
  for (const [i, scn] of scns.entries()) {
    const r = await runOne(garageId, scn, i + 1);
    if (r.pass) pass += 1;
    console.log(`  [${String(i + 1).padStart(2)}] ${r.pass ? ' ok ' : 'FAIL'}  `
      + `${scn.label} (${r.turns} turns)${r.pass ? '' : ` — ${r.why}`}`);
  }
  console.log(`\n  ${diary}: ${pass}/${scns.length} passed`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
