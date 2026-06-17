// Data for the /for/[slug] industry landing pages. Each entry generates a
// static page targeting "AI receptionist for {industry}" search intent.
// Add new industries here; the dynamic route picks them up automatically.

export interface Industry {
  slug: string;
  name: string;
  // Used in H1, SEO title, etc.
  // e.g. "Bodyshops" / "MOT Centres" / "Tyre Specialists"
  displayName: string;
  // First-person plural — "you" is the bodyshop/MOT centre/etc reading.
  // Used in the hero subhead. Should set the scene: "You run a [thing] doing X".
  context: string;
  // The specific pain that this audience faces with phone calls.
  pain: string;
  // 3 short bullets specific to this industry — capabilities the AI shines at.
  highlights: { title: string; body: string }[];
}

export const INDUSTRIES: Industry[] = [
  {
    slug: 'bodyshops',
    name: 'Bodyshops',
    displayName: 'bodyshops',
    context:
      'You run an accident-repair bodyshop. Most enquiries come from drivers who just had a knock — they want a quote, an estimate, a slot, and reassurance, often all in the same call.',
    pain:
      'Bodyshop phones spike at unpredictable hours, the calls take longer to triage than a service booking, and missing one usually means losing the repair to the next bodyshop on the insurance panel.',
    highlights: [
      {
        title: 'Triages damage enquiries without your estimator',
        body: 'ReceptionMate captures the basics — vehicle, damage area, when and how it happened, insurance status — so your estimator only callbacks the right jobs.',
      },
      {
        title: 'Books estimate slots straight into your diary',
        body: 'Estimate appointments go directly into Garage Hive or your existing system, with the customer confirmed by text before they hang up.',
      },
      {
        title: 'Handles insurer-instructed work cleanly',
        body: 'Tag calls by insurer or work-provider so reporting on insurance-led volume is one click away.',
      },
    ],
  },
  {
    slug: 'mot-centres',
    name: 'MOT Centres',
    displayName: 'MOT centres',
    context:
      'You run an MOT centre — possibly with servicing alongside it. Your phone is busiest the moment customers get their MOT-due reminders.',
    pain:
      'MOT season floods the phones. Your team is in the bays. Every missed call is a £45–£100 booking that ends up at a competitor garage down the road.',
    highlights: [
      {
        title: 'Pulls live MOT history during the call',
        body: 'Caller gives the reg, ReceptionMate confirms the MOT expiry and offers the next compliant slot — no more "let me check and call you back".',
      },
      {
        title: 'Quotes MOT + retest combined fees accurately',
        body: 'Reads your menu pricing and quotes the right combined cost without your team being on the phone.',
      },
      {
        title: 'Handles "is it ready?" callbacks separately from bookings',
        body: 'Existing customers checking on a job get the right info; new bookings flow into the diary. Two different jobs, one agent.',
      },
    ],
  },
  {
    slug: 'tyre-specialists',
    name: 'Tyre Specialists',
    displayName: 'tyre shops',
    context:
      'You run a tyre fit centre — possibly with alignment, brakes and MOTs alongside. A lot of your calls are quote-then-fit-same-day.',
    pain:
      'Tyre callers ring around for the best price on the model they need, today. If your phone is engaged, they ring the next shop. The team is mid-fitment when the call comes in.',
    highlights: [
      {
        title: 'Quotes tyre prices from live Tyresoft stock',
        body: 'Caller gives the size or vehicle, ReceptionMate quotes the right tyre, brand and price — straight from your live Tyresoft inventory.',
      },
      {
        title: 'Books same-day fits with realistic timings',
        body: 'Reads the workshop diary and offers genuinely available slots — not "we\'ll squeeze you in" promises that fall over.',
      },
      {
        title: 'Captures every quote, even when the customer doesn\'t book',
        body: 'Unmissed quote enquiries go into the portal as leads — your team can call back the customers who shopped around but didn\'t commit.',
      },
    ],
  },
  {
    slug: 'multi-site-groups',
    name: 'Multi-Site Groups',
    displayName: 'multi-site groups',
    context:
      'You run a group of two or more garages or service centres — a regional chain, a multi-brand operator, or a small national.',
    pain:
      'Inbound call volume scales with branch count, but your central reception capacity doesn\'t. Group-wide reporting on missed calls and conversion is patchy at best.',
    highlights: [
      {
        title: 'Smart routing across branches',
        body: 'ReceptionMate picks the right branch based on location, service requested, or customer preference — and routes the booking there.',
      },
      {
        title: 'Group dashboards out of the box',
        body: 'Calls answered, bookings captured, revenue won — rolled up per branch and across the group. No spreadsheets.',
      },
      {
        title: 'Branch handovers when callers ask',
        body: 'A caller looking for a specific site by name gets pointed there cleanly, with the booking written into that site\'s diary.',
      },
    ],
  },
  {
    slug: 'ev-specialists',
    name: 'EV Specialists',
    displayName: 'EV specialists',
    context:
      'You service electric vehicles — either as an EV-only specialist or as a generalist garage with growing EV volume.',
    pain:
      'EV enquiries are technical: charging issues, battery health, software updates, heavy-vehicle handling. Generic AI receptionists fumble the vocabulary; human services don\'t know the difference between an OBD scan and a high-voltage isolation check.',
    highlights: [
      {
        title: 'Trained on EV-specific vocabulary',
        body: 'BMS, regen, DC fast charging, 400V vs 800V architecture, OTA updates — ReceptionMate handles the language without mispronouncing every other term.',
      },
      {
        title: 'Knows which jobs need EV-trained technicians',
        body: 'Routes calls to the right technician availability and books appointments only when an EV-qualified bay is free.',
      },
      {
        title: 'Captures EV charging enquiries cleanly',
        body: 'Home charger install enquiries, public charger issues, range concerns — categorised and routed to the right part of your business.',
      },
    ],
  },
];
