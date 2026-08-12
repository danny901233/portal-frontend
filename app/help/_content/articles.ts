// Help centre content for the ReceptionMate portal.
// All copy lives here so writers can edit one file rather than hunting across pages.
//
// Each article supports a small set of block types — paragraphs, headings, bullets,
// numbered steps, callouts, and inline code blocks. Keeps the writing fast
// without pulling in an MDX toolchain.

export type Block =
  | { type: 'p'; text: string }
  | { type: 'h'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'callout'; tone: 'tip' | 'warn' | 'info'; text: string }
  | { type: 'code'; text: string };

export type Article = {
  slug: string;
  title: string;
  excerpt: string;
  minutes: number;
  body: Block[];
};

export type Collection = {
  slug: string;
  title: string;
  description: string;
  icon: string;          // simple icon name; rendered as inline SVG in the page
  accent: string;        // tailwind classes for the accent tile (e.g. 'bg-emerald-50 text-emerald-700')
  articles: Article[];
};

// ===========================================================================
// 1. GETTING STARTED
// ===========================================================================
const gettingStarted: Collection = {
  slug: 'getting-started',
  title: 'Getting started',
  description: 'New to ReceptionMate? Start here.',
  icon: 'rocket',
  accent: 'bg-brand-50 text-brand-700',
  articles: [
    {
      slug: 'what-is-receptionmate',
      title: 'What is ReceptionMate?',
      excerpt: 'A 60-second overview of what Leah does and how she fits into your garage.',
      minutes: 2,
      body: [
        { type: 'p', text: "ReceptionMate is an AI receptionist built specifically for UK automotive garages. Our voice agent (we call her Leah) answers your phone when your team can't — captures the booking, takes the customer's details, and sends the job straight to your team." },
        { type: 'h', text: "What Leah can do" },
        { type: 'ul', items: [
          'Answer every call, within one ring, 24/7',
          'Take customer name, vehicle registration, service requested and preferred time',
          'Quote prices from your service menu',
          'Book the customer straight into your diary (Automate tier) or capture the request as a job your team picks up (Assist tier)',
          'Send the customer an SMS confirmation as soon as the call ends',
          'Transfer complex enquiries to a human if it gets out of scope',
        ]},
        { type: 'h', text: "What she doesn't do" },
        { type: 'ul', items: [
          'Replace your existing receptionist — most garages use her for overflow, lunch hours, and out-of-hours',
          'Make outbound sales calls — Leah only handles inbound',
          'Handle complaints — anything sensitive gets transferred to your team',
        ]},
        { type: 'callout', tone: 'tip', text: 'Most garages start on Assist (live in minutes, no integration) and graduate to Automate (full booking-system integration) once they see the volume.' },
      ],
    },
    {
      slug: 'sign-up',
      title: 'Signing up',
      excerpt: 'Set up your account in two minutes.',
      minutes: 2,
      body: [
        { type: 'p', text: "Signing up takes a couple of minutes. You'll set up Direct Debit during the wizard — billing starts when you go live, not before. Cancel any time with one email." },
        { type: 'h', text: 'Sign up steps' },
        { type: 'ol', items: [
          'Visit receptionmate.co.uk and type your garage name into the "Find your garage" search.',
          'Pick your business from the Google results — we pre-fill your address, phone, hours and services.',
          'Enter your work email and click "Get started".',
          'Check your inbox for the login link and your temporary password.',
          'Sign in, change your password, and the setup wizard walks you through the rest — including a free test call so you can hear Leah before you go live.',
        ]},
        { type: 'callout', tone: 'info', text: "Can't find your garage on Google? Click 'Enter manually' on the signup page. We'll set up an account with what you type and you can fill the rest in via the setup wizard." },
      ],
    },
    {
      slug: 'setup-wizard',
      title: 'Completing the setup wizard',
      excerpt: 'The 10 steps that get Leah ready to take your calls.',
      minutes: 5,
      body: [
        { type: 'p', text: "On your first login you'll be shown the setup wizard — ten short steps that personalise Leah for your garage. You can pause at any point and come back; your progress is saved." },
        { type: 'h', text: 'The 10 steps' },
        { type: 'ol', items: [
          'Welcome — confirms your business name and branch.',
          'Branch details — phone, email, address, website.',
          'Opening hours — when your team is in. Leah handles overflow during these hours and acts as voicemail outside them.',
          'Voice — pick Leah, Tom, Sophie, Gemma, Isobel, Fraser or Amelia. Try each one in the preview.',
          'Greeting — the first line Leah says when picking up.',
          'Booking preferences — how far ahead Leah should book, lead time, drop-off rules.',
          'SMS booking links — whether confirmation texts go out automatically.',
          'Notifications — which email addresses get a copy of each captured call.',
          'Billing — your Direct Debit mandate setup via GoCardless.',
          'Complete — final review.',
        ]},
        { type: 'callout', tone: 'tip', text: 'You can revisit and edit any of these later from the Agent Setup page in the portal sidebar.' },
      ],
    },
    {
      slug: 'forward-your-calls',
      title: 'Forwarding your calls to ReceptionMate',
      excerpt: 'How to set up call forwarding for BT, Vodafone, EE, O2, and VoIP lines.',
      minutes: 3,
      body: [
        { type: 'p', text: "When your line is busy or unanswered, calls should roll to your ReceptionMate number. The exact dial sequence depends on your phone provider — pick yours below." },
        { type: 'h', text: 'BT (most landlines)' },
        { type: 'ol', items: [
          'From the garage phone, dial **61*[your ReceptionMate number]#** and press call.',
          'Wait for the confirmation tone.',
          'Hang up. Forwarding when unanswered is now active.',
        ]},
        { type: 'code', text: 'Example for BT: *61*0203 488 5500#' },
        { type: 'h', text: 'Vodafone, EE, O2 mobile lines' },
        { type: 'ol', items: [
          'Open your phone settings → Calls → Call forwarding.',
          'Turn on "When busy" and "When unanswered" and enter your ReceptionMate number.',
          'Save and place a test call — your own phone shouldn\'t pick up, ReceptionMate should.',
        ]},
        { type: 'h', text: 'VoIP / cloud phone systems (RingCentral, 8x8, Sipgate, etc.)' },
        { type: 'p', text: "Most VoIP systems let you set forwarding from the admin console. Look for 'Failover destination' or 'When agent unavailable'. Set it to your ReceptionMate number." },
        { type: 'callout', tone: 'warn', text: "If you're unsure, just send your provider a request: \"Please forward unanswered calls and busy calls from this number to [ReceptionMate number].\" They'll do it." },
      ],
    },
    {
      slug: 'first-test-call',
      title: 'Making your first test call',
      excerpt: 'Hear Leah answer your phone — call her yourself.',
      minutes: 2,
      body: [
        { type: 'p', text: 'Before you forward your real calls, place a test call yourself. This lets you hear how Leah sounds with your specific menu, accent handling, and booking flow.' },
        { type: 'ol', items: [
          'Find your ReceptionMate number in the welcome email or in the portal under Settings.',
          'Call it from your mobile.',
          'Try a normal request first — "I want to book an MOT".',
          'Then try something awkward — a half-spelled registration plate, an out-of-scope service, an abrupt manner.',
          'Hang up and open the portal — your test call should be in the Calls tab within seconds.',
        ]},
        { type: 'callout', tone: 'tip', text: 'Push the agent. The best time to find rough edges is now, not when a real customer hits them. Tell us what felt off and we\'ll tune the prompt.' },
      ],
    },
    {
      slug: 'assist-vs-automate',
      title: 'Assist vs Automate — which is right for me?',
      excerpt: 'The two tiers, what they include, who they suit.',
      minutes: 3,
      body: [
        { type: 'p', text: 'Every customer picks one of two tiers. The right tier mostly comes down to whether you want Leah to pull prices and slots from your booking system, or work from what you train her on.' },
        { type: 'h', text: 'Assist — £200/month' },
        { type: 'ul', items: [
          'Leah answers every call and captures the booking request — name, vehicle, service, preferred time, callback number.',
          'She quotes prices from the service menu you train her on (Agent Setup → Training).',
          "The captured request lands in your portal and (optionally) is texted to your team's mobile.",
          "Your team then opens the job in your existing booking system manually.",
          'Live in minutes — no integration required.',
          "Best for: small workshops, single-receptionist garages, anyone whose booking system Leah can\'t (yet) talk to.",
        ]},
        { type: 'h', text: 'Automate — custom pricing' },
        { type: 'ul', items: [
          'Everything in Assist, plus:',
          'Leah books the job directly into your diary by talking to your booking system (Garage Hive, HubSpot, etc.).',
          'Holds the bay, picks the right slot.',
          "Quotes prices live from the diary integration — whatever you've set in Garage Hive (or your system) is what Leah quotes. You don\'t maintain a second menu in ReceptionMate.",
          'Customer hangs up with a confirmed appointment, not just a request.',
          'Up to 24 hours to set up the integration on your specific booking system.',
          'Best for: busier garages, multi-branch operations, anyone running Garage Hive or another supported system.',
        ]},
        { type: 'callout', tone: 'info', text: "Most customers start on Assist. When you're ready to upgrade to Automate, email hello@receptionmate.co.uk — we'll get the integration set up within 24 hours." },
      ],
    },
  ],
};

// ===========================================================================
// 2. CONFIGURING YOUR AGENT
// ===========================================================================
const configuringAgent: Collection = {
  slug: 'configuring-leah',
  title: 'Configuring Leah',
  description: 'Settings that change how Leah talks, what she knows, and how she handles calls.',
  icon: 'sliders',
  accent: 'bg-violet-50 text-violet-700',
  articles: [
    {
      slug: 'company-information',
      title: 'Company information',
      excerpt: 'Your branch name, phone, address and website — used in greetings and "where are you" questions.',
      minutes: 2,
      body: [
        { type: 'p', text: "Company information is everything Leah needs to know about your business at the most basic level. She'll use it when a caller asks where you're based, your opening hours, or your website address." },
        { type: 'h', text: 'Where to set it' },
        { type: 'p', text: 'Agent Setup → Company information.' },
        { type: 'ul', items: [
          'Branch name — how Leah refers to your garage during the call.',
          'Branch phone — the public number customers know.',
          'Email address — where booking confirmations and notifications are sent.',
          'Branch address — what Leah says if a caller asks where you are.',
          'Website — used if a caller asks "do you have a website?"',
        ]},
        { type: 'callout', tone: 'tip', text: "If you have multiple branches, set this per-branch. Use the branch selector in the portal nav to switch between them." },
      ],
    },
    {
      slug: 'opening-hours',
      title: 'Opening hours and holidays',
      excerpt: 'Tell Leah when you\'re open so she knows when to book and when to take messages.',
      minutes: 2,
      body: [
        { type: 'p', text: "Opening hours control what Leah says and does at different times of day." },
        { type: 'ul', items: [
          'During opening hours: Leah answers overflow calls. If your team picks up first, the call never reaches her.',
          'Outside opening hours: Leah is your voicemail. She tells the caller you\'re closed, captures their details, and books them in for when you reopen (or takes a message).',
        ]},
        { type: 'h', text: 'How to set them' },
        { type: 'ol', items: [
          'Open Agent Setup → Opening hours.',
          'Toggle each day open or closed.',
          'For open days, set the start and end times.',
          'Add holiday closures (e.g. Christmas Day) in the Holiday Closures box — one date per line.',
          'Save.',
        ]},
      ],
    },
    {
      slug: 'greeting',
      title: 'Customising the greeting',
      excerpt: 'Control the first line Leah says when she picks up.',
      minutes: 2,
      body: [
        { type: 'p', text: "The greeting is what callers hear in the first 3-4 seconds — it sets the tone for the whole call." },
        { type: 'h', text: 'Default greeting' },
        { type: 'p', text: "By default Leah uses something like: \"Good [morning/afternoon] [garage name], you're through to Leah — how can I help?\"" },
        { type: 'h', text: 'Customising it' },
        { type: 'p', text: "Go to Agent Setup → Greeting and type your preferred opening line. You can include placeholders like [GREETING] (morning/afternoon/evening) and [BRANCH_NAME] which Leah will fill in." },
        { type: 'callout', tone: 'tip', text: "Keep it under 12 words. Long greetings annoy customers; short ones make Leah feel responsive." },
      ],
    },
    {
      slug: 'faqs',
      title: 'Adding F&Qs — frequently asked questions',
      excerpt: 'Teach Leah the questions your customers actually ask.',
      minutes: 3,
      body: [
        { type: 'p', text: "F&Qs are short answers to questions your customers ask all the time. When a caller asks one of these, Leah delivers your exact answer instead of guessing." },
        { type: 'h', text: 'Examples that work well' },
        { type: 'ul', items: [
          '"Do you take walk-ins?" → "We try to fit walk-ins around booked work but it\'s always best to ring first."',
          '"Where can I park?" → "There\'s parking right outside our front entrance and along Main Street."',
          '"Do you do diagnostics?" → "Yes, we have full diagnostic equipment. Standard diagnostic is £165 plus VAT."',
          '"What do I do with my keys?" → "Drop your keys in the secure key box next to the main door — no need to come in."',
        ]},
        { type: 'h', text: 'How to add one' },
        { type: 'ol', items: [
          'Open Agent Setup → F&Qs.',
          'Click "Add F&Q".',
          'Type the question (or a paraphrase) in the first field.',
          "Type the exact answer you want Leah to say in the second.",
          'Save. The next call onwards, Leah will use your answer.',
        ]},
      ],
    },
    {
      slug: 'training',
      title: 'Training Leah on your business',
      excerpt: 'How Leah learns your services, pricing, and policies.',
      minutes: 3,
      body: [
        { type: 'p', text: "On signup we scrape your website to give Leah a starting point. You can refine her knowledge from Agent Setup → Training." },
        { type: 'h', text: 'What to add' },
        { type: 'ul', items: [
          'Your service menu (MOT, interim service, full service, etc.) with current pricing.',
          'Vehicles you do or do not handle (cars, vans, motorbikes, HGVs, electrics).',
          'Specialisms (e.g. "we\'re the only Land Rover specialist in the area").',
          'Anything you wish your customers knew before they called.',
        ]},
        { type: 'h', text: 'How Leah uses it' },
        { type: 'p', text: "Whenever a caller asks something general about your services, prices or capabilities, Leah pulls from this knowledge to answer. The better trained she is, the fewer transfers she'll need to make to a human." },
        { type: 'callout', tone: 'info', text: "If you're on Automate, Leah quotes prices live from your diary integration (Garage Hive etc.) instead of from this Training menu — so you don\'t need to maintain prices in two places. The Training menu is still useful for everything that isn't a priced service (capabilities, specialisms, policies)." },
      ],
    },
    {
      slug: 'custom-rules',
      title: 'Custom rules',
      excerpt: 'Hard-coded behaviours — "never do X" or "always do Y".',
      minutes: 3,
      body: [
        { type: 'p', text: "Custom rules are absolute instructions that override Leah's default behaviour. Use them sparingly — each rule adds context she has to remember on every call." },
        { type: 'h', text: 'Good examples of rules' },
        { type: 'ul', items: [
          '"Never quote a price for diagnostic work without checking with a technician."',
          '"If a caller mentions a Tesla, always transfer to a human."',
          '"Always offer 9am and 11am slots before 8am."',
          '"If the caller mentions an insurance claim, capture the policy number."',
        ]},
        { type: 'h', text: 'Limits' },
        { type: 'p', text: "You can have up to 20 rules, each up to 500 characters. If you need more, fold related rules together." },
        { type: 'callout', tone: 'warn', text: "Don't use rules for things you can do via Bookings, Transfers, or Smart Questions — those settings exist for a reason and handle their use cases better." },
      ],
    },
    {
      slug: 'smart-questions',
      title: 'Smart questions — data captured on every call',
      excerpt: 'Choose what Leah always asks for, even when the caller doesn\'t volunteer it.',
      minutes: 3,
      body: [
        { type: 'p', text: "Smart Questions tell Leah what details she must collect before ending a call. By default she asks for name, registration, service requested and callback number." },
        { type: 'h', text: 'Examples you can add' },
        { type: 'ul', items: [
          'Mileage on the vehicle (useful for service interval pricing)',
          'Year of registration (for warranty work)',
          'Insurance company (for accident repairs)',
          'How did you hear about us (marketing attribution)',
          'Preferred contact method (call, text, or WhatsApp)',
        ]},
        { type: 'p', text: "Each captured field appears in the call detail in the portal and (where you've integrated) is passed straight to your booking system." },
      ],
    },
    {
      slug: 'identity-voice',
      title: 'Identity, voice and tone',
      excerpt: 'Pick which voice answers your calls and how she comes across.',
      minutes: 2,
      body: [
        { type: 'p', text: "Agent Setup → Identity & voice lets you choose Leah's voice and personality." },
        { type: 'h', text: 'Voice options' },
        { type: 'ul', items: [
          'Leah — clear UK female, warm. Default.',
          'Tom — UK male, professional.',
          'Sophie — UK female, younger, casual.',
          'Gemma — UK female, northern accent.',
          'Isobel — UK female, refined.',
          'Fraser — UK male, Scottish.',
          'Amelia — UK female, older, very formal.',
        ]},
        { type: 'h', text: 'Tone' },
        { type: 'p', text: "Pick from Standard (default, polite professional), Upbeat (more energetic), or Professional (more formal, fewer pleasantries)." },
        { type: 'callout', tone: 'tip', text: "If you change voice, make a test call. Voices read slightly differently — particularly for vehicle registrations and prices." },
      ],
    },
    {
      slug: 'pronunciations',
      title: 'Tricky word pronunciations',
      excerpt: 'Teach Leah how to say words she gets wrong.',
      minutes: 2,
      body: [
        { type: 'p', text: "Some words look one way and sound another — local place names, family-business surnames, vehicle models. Pronunciations let you fix them." },
        { type: 'h', text: 'Examples' },
        { type: 'ul', items: [
          'Loughborough → "luff-bruh"',
          'Pontardulais → "pont-ar-doo-lice"',
          'Featherstonehaugh → "fan-shaw"',
          'Peugeot → "per-zhoh"',
        ]},
        { type: 'p', text: "Go to Agent Setup → Pronunciations, add the word and how it sounds. Leah will use your version from the next call onwards." },
      ],
    },
    {
      slug: 'booking-preferences',
      title: 'Booking preferences and lead time',
      excerpt: 'How far ahead Leah books, and how she handles drop-offs.',
      minutes: 3,
      body: [
        { type: 'p', text: 'Booking preferences keep Leah within the rules of how you actually run the diary.' },
        { type: 'h', text: 'Lead time' },
        { type: 'p', text: "How many days ahead the earliest available booking should be. Set to 1 if you can usually fit a job the next day; set to 7 if you need a week's notice." },
        { type: 'h', text: 'Drop-off bookings' },
        { type: 'p', text: 'Some garages let customers drop their car off in the morning and pick up later. If you do, enable drop-off bookings and write the message Leah should say (e.g. "drop your vehicle off between 8 and 10:30 in the morning").' },
        { type: 'h', text: 'Fast-fit only' },
        { type: 'p', text: 'If you only do tyres, exhausts and brakes (fast-fit), turn this on. Leah will steer callers away from service or diagnostic enquiries and recommend a full-service garage instead.' },
      ],
    },
    {
      slug: 'transfers',
      title: 'Setting up call transfers',
      excerpt: 'When Leah should put callers through to a human, and which number.',
      minutes: 3,
      body: [
        { type: 'p', text: "Some calls need a human. Set the transfer number and Leah will route certain calls there." },
        { type: 'h', text: 'When Leah transfers' },
        { type: 'ul', items: [
          'Caller specifically asks to speak to a person',
          'The enquiry is out of scope (e.g. recovery, insurance claim, complaint)',
          'Leah hits her limits — anything she\'s genuinely unsure of',
        ]},
        { type: 'h', text: 'Where to configure' },
        { type: 'p', text: 'Agent Setup → Transfers → Transfer number. Set the mobile or landline that should ring when Leah transfers. Leave blank to disable transfers entirely.' },
      ],
    },
    {
      slug: 'integrations',
      title: 'Integrations — Garage Hive, HubSpot, Tyresoft',
      excerpt: 'Connect Leah to your booking system so she can actually book jobs.',
      minutes: 3,
      body: [
        { type: 'p', text: "Integrations turn Leah from a job-capturer (Assist) into a real-time booker (Automate). They're the difference between a booking landing in your portal and a booking landing in your diary — and they're also where Leah gets her live pricing from on the call." },
        { type: 'h', text: 'Garage Hive' },
        { type: 'p', text: "Garage Hive integration is set up by our team — there are a few credentials and IDs to wire up, and we like to test the end-to-end booking flow before we hand it over." },
        { type: 'p', text: "Once it's live, Leah pulls your service catalogue and prices straight from Garage Hive on every call. Update a service or price in Garage Hive and Leah quotes the new amount on the next call — no need to also update anything in ReceptionMate." },
        { type: 'p', text: "Email hello@receptionmate.co.uk with the subject \"Garage Hive setup\" and let us know your Garage Hive instance name. We'll get back to you within one working day to schedule the integration." },
        { type: 'callout', tone: 'info', text: 'Setup usually completes within 24 hours of you getting in touch. No downtime — your existing setup keeps working until we flip the switch.' },
        { type: 'h', text: 'HubSpot' },
        { type: 'p', text: "Used for capturing leads as tickets in your HubSpot inbox. Provide an API token and an owner ID. We send each captured booking as a new ticket in HubSpot." },
        { type: 'h', text: 'Tyresoft' },
        { type: 'p', text: "If your garage uses Tyresoft for tyre booking, we have a dedicated tyre-focused agent script that talks to your Tyresoft inventory directly. Get in touch and we'll switch you over." },
      ],
    },
  ],
};

// ===========================================================================
// 3. CALLS & BOOKINGS
// ===========================================================================
const callsAndBookings: Collection = {
  slug: 'calls-and-bookings',
  title: 'Calls & bookings',
  description: 'Reading the Calls page, listening back, rating Leah\'s performance.',
  icon: 'phone',
  accent: 'bg-emerald-50 text-emerald-700',
  articles: [
    {
      slug: 'reading-the-calls-page',
      title: 'Reading the Calls page',
      excerpt: 'Everything visible on the Calls tab and how to find what you need.',
      minutes: 3,
      body: [
        { type: 'p', text: 'The Calls tab is where the day actually lives. Every call Leah handles appears here in real time.' },
        { type: 'h', text: 'KPI strip' },
        { type: 'ul', items: [
          'Total calls — in the current filter window.',
          'Confirmed bookings — calls where Leah captured a booking.',
          'Avg duration — average length of all calls.',
          'Staff time saved — total time across all calls (time your team didn\'t have to spend on the phone).',
        ]},
        { type: 'h', text: 'Filtering and search' },
        { type: 'p', text: 'Filter by call tag, date range, and search by keyword. The search supports Boolean operators — see the Boolean search article.' },
        { type: 'h', text: 'Per-call actions' },
        { type: 'ul', items: [
          'View Summary — the AI-generated summary of what happened on the call.',
          'View Details — the full call detail page with transcript, recording, captured data, and integrations log.',
          '👍 / 👎 — rate the call. Used to flag good or bad performance for our team to review.',
        ]},
      ],
    },
    {
      slug: 'recordings-and-transcripts',
      title: 'Recordings and transcripts',
      excerpt: 'Listening back and reading the full conversation.',
      minutes: 2,
      body: [
        { type: 'p', text: "Every call is recorded and transcribed. Both are stored in the portal for 12 months." },
        { type: 'h', text: 'Recordings' },
        { type: 'p', text: "If the Recording column is empty, click 'Load Recording' — the audio file is fetched on demand. You can play it directly in the browser." },
        { type: 'h', text: 'Transcripts' },
        { type: 'p', text: "Click View Details to see the full back-and-forth between Leah and the caller, with timestamps. Useful when you want to understand exactly what was said." },
        { type: 'callout', tone: 'info', text: "Recordings are stored encrypted. GDPR rights apply — customers can request copies or deletions via hello@receptionmate.co.uk." },
      ],
    },
    {
      slug: 'confirmed-bookings',
      title: 'Confirmed bookings — what they mean',
      excerpt: 'The distinction between a captured request and a confirmed booking.',
      minutes: 2,
      body: [
        { type: 'p', text: 'Not every call ends in a confirmed booking. Understanding the distinction matters for measuring Leah\'s performance.' },
        { type: 'h', text: 'Confirmed booking' },
        { type: 'p', text: 'A call where Leah captured a customer, vehicle, service and time slot — AND (for Automate customers) the job was successfully written into your diary.' },
        { type: 'h', text: 'Captured request' },
        { type: 'p', text: 'A call where Leah captured the customer\'s details and intent but didn\'t finalise a slot — usually because they needed to check their schedule, or the call was about pricing, or your team needs to follow up.' },
        { type: 'h', text: 'How to filter' },
        { type: 'p', text: "On the Calls page, set Call Tag to 'Confirmed Booking' to see only the calls where the booking went through cleanly." },
      ],
    },
    {
      slug: 'rating-calls',
      title: 'Rating calls and giving feedback',
      excerpt: 'Use 👍 / 👎 to flag what Leah did well — and what she didn\'t.',
      minutes: 2,
      body: [
        { type: 'p', text: 'Every call has a thumbs-up and thumbs-down button. We use these to spot patterns — both to improve Leah and to flag accounts that need attention.' },
        { type: 'h', text: 'When to thumbs-down' },
        { type: 'ul', items: [
          'Leah misunderstood the caller and captured wrong details',
          'She quoted the wrong price',
          'She failed to transfer when she should have',
          'The booking didn\'t make it through to your booking system',
          'Anything that lost you the customer',
        ]},
        { type: 'h', text: 'When you thumbs-down' },
        { type: 'p', text: 'A modal opens asking why. Pick from the reasons or write your own. Our team looks at thumbs-downs daily — if there\'s a pattern, we\'ll tune your specific agent.' },
        { type: 'h', text: 'Thumbs-up' },
        { type: 'p', text: 'Less critical but still useful — we look at the ratio. A high thumbs-up rate tells us your specific config is working.' },
      ],
    },
    {
      slug: 'boolean-search',
      title: 'Searching calls with Boolean operators',
      excerpt: 'Find specific calls with AND, OR, NOT and quoted phrases.',
      minutes: 2,
      body: [
        { type: 'p', text: 'The Calls page search supports proper Boolean syntax. Use it when you need to find specific call types fast.' },
        { type: 'h', text: 'Operators' },
        { type: 'ul', items: [
          'AND — both terms must appear. e.g. MOT AND service',
          'OR — either term can appear. e.g. tyre OR tyres',
          'NOT — exclude calls with the term. e.g. MOT NOT cancelled',
          'Quotes — exact phrase. e.g. "brake pads"',
          'Parentheses — group conditions. e.g. (MOT OR service) AND NOT cancelled',
        ]},
        { type: 'h', text: 'Examples' },
        { type: 'code', text: '"check engine light" AND NOT diagnostic' },
        { type: 'p', text: 'Finds every call where the customer mentioned the check engine light but no diagnostic was booked. Probably calls you want to follow up.' },
      ],
    },
    {
      slug: 'csv-exports',
      title: 'Downloading call data as CSV',
      excerpt: 'Export confirmed bookings for spreadsheets, accounting, or reporting.',
      minutes: 2,
      body: [
        { type: 'p', text: 'You can export your confirmed bookings as a CSV file from the Dashboard.' },
        { type: 'ol', items: [
          'Open the Dashboard.',
          'Set the date range to what you want to export.',
          'Click "Download Confirmed Bookings CSV".',
          'Open the CSV in Excel, Google Sheets or import to your accounting system.',
        ]},
        { type: 'p', text: 'The CSV includes: date, customer name, phone, vehicle reg, service requested, slot booked, and captured revenue.' },
      ],
    },
  ],
};

// ===========================================================================
// 4. MESSAGES & WEBCHAT (CONNECT)
// ===========================================================================
const messagesAndWebchat: Collection = {
  slug: 'messages-and-webchat',
  title: 'Messages & webchat',
  description: 'Connect — webchat on your site, WhatsApp, Facebook, Instagram.',
  icon: 'chat',
  accent: 'bg-sky-50 text-sky-700',
  articles: [
    {
      slug: 'installing-connect-widget',
      title: 'Installing the Connect webchat widget',
      excerpt: 'One snippet to add the chat widget to any website.',
      minutes: 3,
      body: [
        { type: 'p', text: 'Connect is our webchat companion to the voice agent. Once installed, visitors to your website can chat with Leah just like they would over the phone.' },
        { type: 'h', text: 'Install' },
        { type: 'ol', items: [
          'In the portal, open Integrations → Widget.',
          'Copy the script snippet.',
          'Paste it into your website\'s HTML before the closing </body> tag. Most CMSes (Wix, WordPress, Squarespace) have a "Custom code" section for this.',
          'Save and reload your site. The chat bubble appears in the corner.',
        ]},
        { type: 'h', text: 'Customising the look' },
        { type: 'p', text: 'Open Integrations → Widget → Customise. You can change the colour, icon, position (left/right) and your logo. Changes go live immediately.' },
      ],
    },
    {
      slug: 'whatsapp-integration',
      title: 'Connecting WhatsApp',
      excerpt: 'Receive WhatsApp messages from customers in your portal inbox.',
      minutes: 4,
      body: [
        { type: 'p', text: "Customers can message your business on WhatsApp and Leah will respond — capturing bookings, answering F&Qs, transferring when needed." },
        { type: 'h', text: 'What you need' },
        { type: 'ul', items: [
          'A WhatsApp Business account linked to your phone number.',
          'Admin access to a Meta Business account.',
        ]},
        { type: 'h', text: 'Setup steps' },
        { type: 'ol', items: [
          'Open Integrations → Messaging in the portal.',
          'Click Connect WhatsApp.',
          'You\'ll be redirected to Meta\'s WhatsApp Business setup flow — log in with your Facebook/Meta admin account.',
          'Pick the WhatsApp Business Account you want to use, select your phone number, and approve our app.',
          'Send a test message to your number — it should appear in the Messages tab in the portal within seconds.',
        ]},
      ],
    },
    {
      slug: 'facebook-instagram',
      title: 'Connecting Facebook Messenger and Instagram Direct',
      excerpt: 'Handle Facebook and Instagram DMs alongside calls and WhatsApp.',
      minutes: 3,
      body: [
        { type: 'p', text: 'Facebook Messenger and Instagram DMs feed into the same Messages tab as WhatsApp and Connect webchat.' },
        { type: 'ol', items: [
          'In Integrations → Messaging, click Connect Facebook (or Instagram).',
          'Log in with the Facebook account that manages your Page.',
          'Grant our app permission to read and reply to messages on the Page.',
          'Pick the Page (Facebook) or business account (Instagram) you want to use.',
          'Test by sending a DM to your own Page — it should land in the Messages tab.',
        ]},
        { type: 'callout', tone: 'info', text: 'Instagram requires your Instagram account to be a Business Account linked to a Facebook Page. Personal accounts can\'t connect.' },
      ],
    },
    {
      slug: 'reading-conversations',
      title: 'Reading conversations in the Messages tab',
      excerpt: 'How the unified inbox works.',
      minutes: 2,
      body: [
        { type: 'p', text: 'The Messages tab is one unified inbox for every chat channel — webchat, WhatsApp, Facebook, Instagram. Each conversation shows the channel icon so you know where it came from.' },
        { type: 'h', text: 'Statuses' },
        { type: 'ul', items: [
          'Active — Leah is currently handling the conversation.',
          'Attention — Leah has flagged it for human review (e.g. transfer requested, complex enquiry).',
          'Resolved — the conversation is closed.',
        ]},
        { type: 'p', text: 'Use the Attention filter to see what needs your team\'s eyes today.' },
      ],
    },
    {
      slug: 'outbound-campaigns',
      title: 'Outbound message campaigns',
      excerpt: 'Send templated messages to customers for service reminders, follow-ups, MOT reminders.',
      minutes: 4,
      body: [
        { type: 'p', text: "Outbound is for proactive customer contact — service reminders, MOT due dates, post-service follow-up." },
        { type: 'h', text: 'Setting up a campaign' },
        { type: 'ol', items: [
          'Open Outbound in the portal.',
          'Click New Campaign.',
          'Pick a template (or create one).',
          'Upload your recipient list as a CSV — name, phone/WhatsApp number, and any merge fields like vehicle reg or service type.',
          'Schedule the send date and time.',
          'Review and launch.',
        ]},
        { type: 'callout', tone: 'warn', text: 'Make sure your recipients have opted in to receive messages from you. Sending unsolicited messages is against WhatsApp\'s terms and UK PECR rules.' },
      ],
    },
    {
      slug: 'message-templates',
      title: 'Message templates',
      excerpt: 'Reusable message bodies for outbound campaigns and quick replies.',
      minutes: 3,
      body: [
        { type: 'p', text: 'Templates are reusable message bodies. WhatsApp requires templates to be pre-approved by Meta for any message you send outside an active conversation.' },
        { type: 'h', text: 'Creating a template' },
        { type: 'ol', items: [
          'Open Templates in the portal.',
          'Click New Template.',
          'Type the message body. Use {{1}}, {{2}} etc. for merge fields (e.g. "Hi {{1}}, your MOT for {{2}} is due on {{3}}").',
          'Pick a category — service reminder, marketing, transactional.',
          'Submit. Meta usually approves within an hour for WhatsApp.',
        ]},
        { type: 'p', text: 'Approved templates show with a green tick. Rejected ones show the reason — usually too marketing-heavy or missing context.' },
      ],
    },
    {
      slug: 'sms-booking-links',
      title: 'SMS booking links — how they work',
      excerpt: 'Why customers sometimes get a text with a link to confirm a booking.',
      minutes: 2,
      body: [
        { type: 'p', text: "If Leah can't fully confirm a booking on a call — usually because she needs the customer to pick from several slots — she'll text them a link to a booking page." },
        { type: 'p', text: 'The page shows the available slots Leah found, and the customer picks one with a single tap. The confirmation flows back into your portal and (for Automate) into your diary.' },
        { type: 'h', text: 'Where to enable / disable' },
        { type: 'p', text: 'Agent Setup → Booking → Enable SMS booking links. On by default for Automate customers.' },
        { type: 'h', text: 'Tracking' },
        { type: 'p', text: 'SMS Booking Links sent and converted are visible on the Dashboard.' },
      ],
    },
  ],
};

// ===========================================================================
// 5. BILLING & ACCOUNT
// ===========================================================================
const billingAndAccount: Collection = {
  slug: 'billing-and-account',
  title: 'Billing & account',
  description: 'Plans, invoices, Direct Debit, team members.',
  icon: 'card',
  accent: 'bg-amber-50 text-amber-700',
  articles: [
    {
      slug: 'pricing-plans',
      title: 'Understanding your plan and pricing',
      excerpt: 'What you\'re paying for, the included minutes, and what overage looks like.',
      minutes: 3,
      body: [
        { type: 'p', text: 'ReceptionMate is billed monthly per branch. Most plans include:' },
        { type: 'ul', items: [
          'Monthly subscription — base cost (£200/month for Assist).',
          'Included call minutes — typically 400 minutes per month.',
          'Per-minute overage — cost of any minutes used above the included allowance (typically £0.25/minute).',
          'VAT — added at 20%.',
        ]},
        { type: 'h', text: 'Multi-branch' },
        { type: 'p', text: 'Each branch is billed separately. If you have multiple branches under one customer account, you\'ll see line items per branch on the invoice.' },
      ],
    },
    {
      slug: 'direct-debit-setup',
      title: 'Setting up Direct Debit',
      excerpt: 'How to add a UK bank account for ongoing billing via GoCardless.',
      minutes: 3,
      body: [
        { type: 'p', text: 'ReceptionMate uses GoCardless to collect monthly payments via UK Direct Debit. You set the mandate up as part of the onboarding wizard, before going live.' },
        { type: 'ol', items: [
          'During onboarding (or later from the Billing tab) click "Set up Direct Debit". You\'ll be redirected to GoCardless.',
          'Enter your business name, account number and sort code.',
          'Confirm. Your first payment will be taken once your agent is live and your first month begins.',
        ]},
        { type: 'callout', tone: 'tip', text: 'The mandate covers all future payments. You can cancel any time via your bank or via the portal.' },
      ],
    },
    {
      slug: 'reading-your-invoice',
      title: 'Reading your invoice',
      excerpt: 'What every line on a ReceptionMate invoice means.',
      minutes: 2,
      body: [
        { type: 'p', text: "Invoices are emailed monthly and visible in the portal under Billing." },
        { type: 'h', text: 'Line items' },
        { type: 'ul', items: [
          'Monthly subscription — your base plan cost for the month.',
          'Call minutes used — total minutes Leah handled.',
          'Overage charges — any minutes above your included allowance × per-minute rate.',
          'SMS charges — SMS messages sent (typically £0.99 each, charged at cost).',
          'VAT — 20% added to the subtotal.',
          'Total — the amount taken via Direct Debit.',
        ]},
      ],
    },
    {
      slug: 'updating-bank-details',
      title: 'Updating your bank details',
      excerpt: 'Switch the bank account your Direct Debit comes from.',
      minutes: 2,
      body: [
        { type: 'p', text: 'You can update your bank details at any time via the portal.' },
        { type: 'ol', items: [
          'Open Billing → Update payment method.',
          'You\'ll be redirected to GoCardless to set up the new mandate.',
          'Once the new mandate is active, your next Direct Debit will come from the new account.',
        ]},
        { type: 'callout', tone: 'warn', text: 'Make sure the new mandate is active before the next billing date — otherwise the existing one will be used.' },
      ],
    },
    {
      slug: 'team-members',
      title: 'Managing team members and roles',
      excerpt: 'Add staff to your account and set what they can see and do.',
      minutes: 3,
      body: [
        { type: 'p', text: 'You can invite team members from the Team tab in the portal.' },
        { type: 'h', text: 'Roles' },
        { type: 'ul', items: [
          'User — can see and rate calls, view messages, view dashboard. Cannot change agent settings or billing.',
          'Manager — everything Users can do, plus configure the agent and manage other team members.',
        ]},
        { type: 'h', text: 'Multi-branch access' },
        { type: 'p', text: 'You can grant each team member access to specific branches. Useful for multi-branch operations where a branch manager only needs to see their own location.' },
      ],
    },
    {
      slug: 'cancelling',
      title: 'Cancelling or pausing',
      excerpt: 'Get in touch and we\'ll walk you through it.',
      minutes: 1,
      body: [
        { type: 'p', text: "How cancellation or pausing works depends on the contract you signed — some plans are rolling monthly, others have a minimum term, and some include multi-branch arrangements. We'll talk you through what applies to your specific account." },
        { type: 'h', text: 'Get in touch' },
        { type: 'p', text: "Email hello@receptionmate.co.uk and tell us whether you'd like to cancel, pause, or just talk through your options. We aim to reply within one working hour." },
        { type: 'callout', tone: 'info', text: 'Your call history and transcripts stay accessible in the portal for 30 days after cancellation, then are permanently deleted.' },
      ],
    },
  ],
};

// ===========================================================================
// 6. TROUBLESHOOTING
// ===========================================================================
const troubleshooting: Collection = {
  slug: 'troubleshooting',
  title: 'Troubleshooting',
  description: 'Common issues and how to fix them.',
  icon: 'lifebuoy',
  accent: 'bg-rose-50 text-rose-700',
  articles: [
    {
      slug: 'agent-missed-booking',
      title: 'The agent missed a booking',
      excerpt: 'What to do when Leah failed to capture a customer.',
      minutes: 3,
      body: [
        { type: 'p', text: 'It happens — usually for one of a few specific reasons. Here\'s what to check.' },
        { type: 'h', text: 'Find the call first' },
        { type: 'p', text: 'Open the Calls page. Filter by the date and the inbound number, or search by registration plate if you have it. Listen to the recording.' },
        { type: 'h', text: 'Common causes' },
        { type: 'ul', items: [
          'Registration plate misheard — the caller\'s accent or background noise caused the wrong reg. Add the customer to Smart Questions to capture differently next time.',
          'Service out of scope — Leah pushed back because it wasn\'t in your trained menu. Update Training with the missing service.',
          'Customer wanted a slot you don\'t have — Leah offered options but the caller said no. This is often legitimate.',
          'Caller hung up halfway through — Leah may have been too slow or asked too many questions. Tell us via thumbs-down on the call.',
        ]},
        { type: 'callout', tone: 'tip', text: 'Thumbs-down every missed booking. We look at these every weekday and tune your specific agent if there\'s a pattern.' },
      ],
    },
    {
      slug: 'recordings-wont-load',
      title: 'Call recordings won\'t load',
      excerpt: 'When the Recording column shows "Load Recording" forever.',
      minutes: 2,
      body: [
        { type: 'p', text: 'Recordings load on demand from Twilio. There are a few reasons they might not appear.' },
        { type: 'ul', items: [
          'The call was less than 5 seconds — too short to record. Common for misdials.',
          'The customer phone number was blocked or anonymous — we can\'t fetch the recording for those.',
          'The call happened more than 12 months ago — recordings are deleted after 12 months for GDPR compliance.',
          'A temporary glitch — try refreshing the page and clicking Load Recording again.',
        ]},
        { type: 'callout', tone: 'info', text: 'Recording still won\'t load? Email hello@receptionmate.co.uk with the call ID and we\'ll investigate.' },
      ],
    },
    {
      slug: 'forwarding-not-working',
      title: 'My call wasn\'t forwarded',
      excerpt: 'When the customer rang you and never hit Leah.',
      minutes: 3,
      body: [
        { type: 'p', text: 'If your team picks up first, the call won\'t reach Leah — that\'s by design. But if no one\'s answering and the call still doesn\'t roll over:' },
        { type: 'h', text: 'Check your forwarding sequence' },
        { type: 'ol', items: [
          'From your garage landline, dial *#61# and press call.',
          'You should hear the number your unanswered calls forward to — that should be your ReceptionMate number.',
          'If it\'s not, re-set forwarding with *61*[your ReceptionMate number]# — see Forwarding your calls article.',
        ]},
        { type: 'h', text: 'Check your provider hasn\'t reset it' },
        { type: 'p', text: 'Some providers reset call forwarding after a line maintenance event. If you suspect this, just re-set the forwarding sequence above.' },
      ],
    },
    {
      slug: 'booking-not-in-diary',
      title: 'The booking didn\'t appear in my diary',
      excerpt: 'Automate customers: when a confirmed booking didn\'t make it to Garage Hive/HubSpot.',
      minutes: 3,
      body: [
        { type: 'p', text: "This usually means the integration call failed. We have logs of every integration attempt — and they're in the call detail." },
        { type: 'ol', items: [
          'Open the call in question (Calls → View Details).',
          'Scroll to the Integrations Log section.',
          'Look for the failed call — there\'ll be an error message.',
          'Common causes: stale API key, hit a rate limit, invalid customer ID, garage hive instance offline.',
          'Email us the call ID and we\'ll get it across to your booking system manually + tune the agent so it doesn\'t happen again.',
        ]},
      ],
    },
    {
      slug: 'agent-sounded-wrong',
      title: 'Customer says the agent sounded wrong',
      excerpt: 'Wrong price, wrong service, wrong information — what to do.',
      minutes: 3,
      body: [
        { type: 'p', text: "If a customer rings back saying Leah quoted them the wrong price or service, we need to find what she said exactly." },
        { type: 'ol', items: [
          'Find the call in the Calls tab.',
          'Read the transcript — what did she actually say?',
          'If she quoted a price that\'s out of date, update Training with the current price.',
          'If she said you do something you don\'t (e.g. air-conditioning regassing when you don\'t), update Training to reflect what you actually offer.',
          'Thumbs-down the call with a note about what was wrong — we adjust your specific agent within 24 hours.',
        ]},
      ],
    },
    {
      slug: 'getting-help',
      title: 'Getting more help',
      excerpt: 'When to email us and what to include.',
      minutes: 2,
      body: [
        { type: 'p', text: "For anything not covered in these guides, email hello@receptionmate.co.uk." },
        { type: 'h', text: 'What to include' },
        { type: 'ul', items: [
          'Your business name and branch (or Garage ID from the top-bar)',
          'Call ID if your question is about a specific call',
          'Customer name and phone if it\'s about a specific case',
          'Screenshots help a lot',
        ]},
        { type: 'p', text: 'We respond Mon-Fri 9-6 UK time, typically within an hour during business hours.' },
      ],
    },
  ],
};

// ===========================================================================
// EXPORT
// ===========================================================================
export const collections: Collection[] = [
  gettingStarted,
  configuringAgent,
  callsAndBookings,
  messagesAndWebchat,
  billingAndAccount,
  troubleshooting,
];

// Lookup helpers
export function getCollection(slug: string): Collection | undefined {
  return collections.find((c) => c.slug === slug);
}

export function getArticle(collectionSlug: string, articleSlug: string): Article | undefined {
  return getCollection(collectionSlug)?.articles.find((a) => a.slug === articleSlug);
}

// Search across all articles
export type SearchHit = { collection: Collection; article: Article; matchedIn: 'title' | 'excerpt' | 'body' };
export function searchArticles(query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  for (const collection of collections) {
    for (const article of collection.articles) {
      if (article.title.toLowerCase().includes(q)) {
        hits.push({ collection, article, matchedIn: 'title' });
        continue;
      }
      if (article.excerpt.toLowerCase().includes(q)) {
        hits.push({ collection, article, matchedIn: 'excerpt' });
        continue;
      }
      const bodyText = article.body
        .map((b) => ('text' in b ? b.text : 'items' in b ? b.items.join(' ') : ''))
        .join(' ')
        .toLowerCase();
      if (bodyText.includes(q)) {
        hits.push({ collection, article, matchedIn: 'body' });
      }
    }
  }
  return hits;
}
