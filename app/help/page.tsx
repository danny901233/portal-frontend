import Link from 'next/link';
import HelpAssistant from '../components/HelpAssistant';

type GuideSubsection = {
  title: string;
  points: string[];
};

type GuideSection = {
  id: string;
  title: string;
  description?: string;
  points?: string[];
  subsections?: GuideSubsection[];
  examples?: Array<{ keyword: string; example: string; effect: string }>;
};

const quickLinks = [
  { label: 'Review Calls & Feedback', href: '/calls' },
  { label: 'Boolean Search Tips', href: '/help#advanced-search' },
  { label: 'Configure Agent & Knowledge', href: '/agent-configurations' },
  { label: 'Portal Troubleshooting', href: '/help#troubleshooting' },
  { label: 'Contact Support', href: 'mailto:hello@receptionmate.com' },
];

const guideSections: GuideSection[] = [
  {
    id: 'getting-started',
    title: 'Getting Started',
    description:
      'Confirm your access, choose the right garage context, and make sure the portal stays in sync with your ReceptionMate deployment.',
    points: [
      'Log in with your ReceptionMate credentials. The portal stores a short-lived token in secure storage; log out if you’re sharing a device.',
      'Immediately pick the garage you want to work on from the top bar. All calls, configuration, and metrics reflect the garage you select.',
      'If the garage selector looks empty, refresh the page once. Still not there? Sign out, sign back in, and contact hello@receptionmate.com if the issue persists.',
      'Bookmark /calls for direct access—this is the primary workspace for day-to-day operations.',
    ],
  },
  {
    id: 'dashboard-overview',
    title: 'Dashboard Overview',
    description:
      'High-level metrics help you spot trends before you dive into individual calls or configuration changes.',
    points: [
      'Volume indicators track total calls, resolved vs escalated interactions, and any spikes in unanswered calls.',
      'Sentiment and feedback widgets aggregate thumbs up/down to highlight quality shifts in the AI assistant’s performance.',
      'Each tile links directly to a filtered calls view; use these shortcuts when you need to investigate anomalies quickly.',
      'Download or screenshot cards during team reviews so everyone sees the same numbers and trends.',
    ],
  },
  {
    id: 'calls-workspace',
    title: 'Working Inside Calls',
    description:
      'The Calls page is the operational heart of the portal. Combine filters, Boolean search, and per-call actions to stay on top of customer conversations.',
    subsections: [
      {
        title: 'Filters & Sorting',
        points: [
          'Call Tag filter narrows the list to business-critical outcomes such as bookings, cancellations, or voicemail drops.',
          'Date range inputs accept partial ranges—set only a start date to view everything after that point.',
          'Duration sort surfaces short calls first. Combine with tags to find quick hang-ups or missed opportunities.',
          'Reset everything with Clear filters when your investigation is complete.',
        ],
      },
      {
        title: 'Boolean Search Moves',
        points: [
          'Search runs across summaries, transcripts, caller names, call IDs, tags, and feedback notes.',
          'Implicit AND: typing multiple words without operators returns calls containing all of them.',
          'Use parentheses to group logic when mixing AND/OR combinations. Quotes lock multi-word phrases.',
          'Prefix NOT to exclude unwanted results, e.g. NOT "no show" to hide cancellations.',
        ],
      },
      {
        title: 'Call Details & Actions',
        points: [
          'Open a call to access the full transcript, audio recording link, and metadata such as caller number and call duration.',
          'Copy the eight-digit Call ID from the detail page if you need to reference the conversation with ReceptionMate support.',
          'Add feedback while reviewing a call. The portal saves your input immediately and confirms once it is stored.',
          'Copy the call URL to share context with teammates. Anyone you share with must have access to the same garage.',
        ],
      },
    ],
  },
  {
    id: 'advanced-search',
    title: 'Advanced Boolean Search Reference',
    description:
      'Use these examples as a quick crib sheet when you need to carve out very specific call sets. The engine is case-insensitive.',
    examples: [
      {
        keyword: 'AND (default)',
        example: 'service brakes',
        effect: 'Returns calls mentioning both “service” and “brakes” anywhere in the searchable fields.',
      },
      {
        keyword: 'OR',
        example: '“tyre fitting” OR tyres',
        effect: 'Matches calls containing either the exact phrase “tyre fitting” or the word “tyres”.',
      },
      {
        keyword: 'NOT',
        example: 'MOT NOT cancelled',
        effect: 'Includes MOT calls while excluding any that reference cancellations.',
      },
      {
        keyword: 'Parentheses',
        example: 'service AND (booking OR estimate)',
        effect: 'Finds service calls that mention either bookings or estimates.',
      },
      {
        keyword: 'Quoted phrase',
        example: '"request a callback"',
        effect: 'Only returns calls where that precise phrase appears in the transcript or summary.',
      },
    ],
    points: [
      'Spacing around operators is optional. “serviceANDbrakes” will not work; keep words separated.',
      'Fallback behaviour: if the parser detects an error, the portal performs a simple keyword search instead of failing.',
      'Keep the query short and focused. Extremely long expressions may slow down filtering on older devices.',
    ],
  },
  {
    id: 'call-feedback',
    title: 'Call Feedback Workflow',
    description:
      'Structured feedback ensures the training team can continuously improve call handling accuracy.',
    points: [
      'Thumbs up signals that the outcome met expectations. The system records it instantly without further prompts.',
      'Thumbs down opens a modal that captures structured reasons (“Missed booking”, “Incorrect information”, etc.) and optional narrative notes.',
      'All feedback timestamps and author details stay tied to the call. Reopen any call later to review the history of adjustments.',
      'Use the feedback filters to build weekly QA loops—spot repeated issues and raise them with your ReceptionMate success manager.',
    ],
  },
  {
    id: 'agent-configuration',
    title: 'Configuring Your Agent',
    description:
      'Keep your AI assistant aligned with real-world operations by maintaining accurate configuration data.',
    subsections: [
      {
        title: 'Core Identity',
        points: [
          'Branch name, phone number, and address populate caller-facing scripts. Update them after any rebrand or relocation.',
          'Tone preference and response speed fine-tune how formal or upbeat the voice agent sounds on calls.',
        ],
      },
      {
        title: 'Operating Hours',
        points: [
          'The weekly hours grid supports open/close times per day and closed toggles for days off.',
          'Holiday closures accept free-form notes. Use them to block out seasonal shutdowns or bank holidays.',
        ],
      },
      {
        title: 'Escalation & Notifications',
        points: [
          'Set the call summary email address to deliver transcripts and highlights to the right inbox.',
          'Use workflow notes to document custom booking flows (loan cars, diagnostic checks, etc.) so the AI can route correctly.',
        ],
      },
    ],
  },
  {
    id: 'knowledge-base',
    title: 'Website Knowledge Base Management',
    description:
      'Teach the agent using curated pages from your public website. The portal separates discovery from ingestion so you stay in control.',
    subsections: [
      {
        title: 'Discovery Run',
        points: [
          'Enter the public domain (e.g. https://examplegarage.co.uk). The crawler stays on-domain and maps internal links.',
          'Monitor the page list as it populates. Titles, snippets, and detected contact details help you prioritise content.',
        ],
      },
      {
        title: 'Selection & Publishing',
        points: [
          'Tick only the pages that contain authoritative, up-to-date information.',
          'Use the select-all toggle sparingly—exclude marketing landing pages or duplicate service descriptions.',
          'Click Publish Selected to ingest the chosen pages. The backend chunks the content and stores it against your garage.',
        ],
      },
      {
        title: 'Ongoing Maintenance',
        points: [
          'Repeat discovery every time significant website content changes. The portal highlights how many new pages were processed.',
          'Remove outdated knowledge by unpublishing the page in your CMS and running a fresh ingest with the updated selection.',
          'Keep a checklist of mission-critical pages (services, pricing, FAQs, directions) and confirm they remain selected after each scan.',
        ],
      },
    ],
  },
  {
    id: 'monitoring',
    title: 'Monitoring & Quality Assurance',
    description:
      'Establish regular review cadences so issues are caught quickly and improvements are documented.',
    points: [
      'Daily: skim new calls, especially those tagged “booking” or “urgent”, to verify the AI followed through.',
      'Weekly: note any repeated feedback reasons and discuss them during team check-ins.',
      'Monthly: revisit agent configuration and knowledge base selections with stakeholders to validate accuracy.',
      'Document any process tweaks in the knowledge base so future staff understand why changes happened.',
    ],
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting & Maintenance',
    description:
      'If something feels off, try these quick fixes first. When you contact us, include call IDs, browser details, and screenshots so we can respond faster.',
    points: [
      'Refresh the page or sign out and back in to clear expired sessions. Use a private/incognito window if the issue persists.',
      'If the Calls page looks empty, confirm the correct garage is selected and that filters are cleared.',
      'For search surprises, re-check your Boolean expression (balanced brackets and quotation marks).',
      'Still stuck? Email hello@receptionmate.com with the page URL, time of the issue, and any call IDs affected.',
    ],
  },
  {
    id: 'security',
    title: 'Security & Access Control',
    description:
      'Protect customer information by following simple access hygiene.',
    points: [
      'Restrict portal access to trusted team members. All actions are tied to the logged-in user account.',
      'Sign out on shared devices and avoid browser autofill of credentials.',
      'If team members leave, update your account list and notify hello@receptionmate.com so old access can be removed.',
    ],
  },
];

export default function HelpPage() {
  return (
    <div className="space-y-10 text-slate-200">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold text-slate-100">ReceptionMate Portal Guide</h1>
        <p className="max-w-3xl text-sm text-slate-400">
          Bookmark this page as your single source of truth for operating ReceptionMate. It combines workflow guidance, search tips, and troubleshooting steps so teams onboard quickly and stay efficient.
        </p>
      </header>

      <HelpAssistant />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {quickLinks.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-sm font-medium text-slate-200 transition-colors hover:border-sky-500/60 hover:text-sky-200"
          >
            {item.label}
          </Link>
        ))}
      </section>

      <section className="space-y-6">
        {guideSections.map((section) => (
          <article
            key={section.id}
            id={section.id}
            className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 shadow-lg shadow-slate-950/20"
          >
            <h2 className="text-xl font-semibold text-slate-100">{section.title}</h2>
            {section.description ? <p className="mt-2 text-sm text-slate-400">{section.description}</p> : null}
            {section.points ? (
              <ul className="mt-4 space-y-2 text-sm text-slate-300">
                {section.points.map((point) => (
                  <li key={point} className="flex items-start gap-2">
                    <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-sky-500" aria-hidden="true" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {section.subsections
              ? section.subsections.map((subsection) => (
                  <div key={subsection.title} className="mt-5 space-y-2">
                    <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                      {subsection.title}
                    </h3>
                    <ul className="space-y-2 text-sm text-slate-300">
                      {subsection.points.map((point) => (
                        <li key={point} className="flex items-start gap-2">
                          <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-sky-500" aria-hidden="true" />
                          <span>{point}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              : null}
            {section.examples ? (
              <div className="mt-5 overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-800 text-left text-sm text-slate-300">
                  <thead className="bg-slate-900/80 text-xs uppercase tracking-wider text-slate-400">
                    <tr>
                      <th className="px-3 py-2">Operator</th>
                      <th className="px-3 py-2">Example</th>
                      <th className="px-3 py-2">What it does</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/80">
                    {section.examples.map((entry) => (
                      <tr key={`${entry.keyword}-${entry.example}`} className="hover:bg-slate-900/40">
                        <td className="px-3 py-2 font-semibold text-slate-200">{entry.keyword}</td>
                        <td className="px-3 py-2 text-slate-200">{entry.example}</td>
                        <td className="px-3 py-2">{entry.effect}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </article>
        ))}
      </section>

      <footer className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-300">
        <h2 className="text-lg font-semibold text-slate-100">Need more help?</h2>
        <p className="mt-2 max-w-3xl">
          Reach out to the ReceptionMate success team at{' '}
          <a href="mailto:hello@receptionmate.com" className="text-sky-300 hover:text-sky-200">
            hello@receptionmate.com
          </a>{' '}
          or reply to your onboarding email. Include call IDs, timestamps, browser version, and screenshots so we can resolve things quickly.
        </p>
      </footer>
    </div>
  );
}
