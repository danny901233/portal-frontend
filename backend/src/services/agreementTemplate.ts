// Service agreement template — full SaaS contract content rendered to HTML.
//
// CANONICAL SOURCE: this file IS the template that customers sign. The
// `renderAgreementHtml()` function takes commercial terms and produces the
// rendered HTML that is shown to the customer + snapshotted into the database.
//
// IMPORTANT — version this when the agreement text changes
// Bump TEMPLATE_VERSION whenever the contract content is edited so that we can
// answer "which version did X customer sign?". Customers who have already
// signed keep their snapshot regardless of template changes.
//
// NOTE — clause numbering matches the PDF as provided. Some inconsistencies
// (clause 6.5 cites Clause 12, but Termination is now Clause 13; sub-clauses
// in clauses 9, 12, 13 are mis-numbered) are intentional — they mirror the
// source document verbatim. Fix the source, then bump TEMPLATE_VERSION here.

export const TEMPLATE_VERSION = '1.4';

export type LicenceTier = 'assist' | 'automate' | 'connect';

export const LICENCE_DETAILS: Record<LicenceTier, { name: string; description: string }> = {
  assist: {
    name: 'Assist',
    description:
      'AI voice agent that catches calls, captures booking requests and notifies your team. Includes 400 minutes per branch; £0.25 per connected minute thereafter. Excludes diary integration.',
  },
  automate: {
    name: 'Automate',
    description:
      'AI voice agent integrated with your diary so calls become confirmed bookings. Includes 600 minutes per branch; £0.25 per connected minute thereafter.',
  },
  connect: {
    name: 'Connect',
    description:
      'AI messaging agent (web chat, WhatsApp, Facebook, Instagram). Includes 500 AI messaging conversations per branch; £0.25 per message thereafter. SMS charged separately at £0.25 per message.',
  },
};

/**
 * What each licence includes, PER BRANCH. Billing measures every branch against its own
 * allowance, so these are per-branch numbers and the contract totals them explicitly rather than
 * leaving the customer to guess whether they pool.
 */
const LICENCE_USAGE: Record<LicenceTier, { terms: string; minutes?: number; messages?: number }> = {
  automate: {
    minutes: 600,
    terms:
      'The <strong>Automate</strong> licence includes <strong>600 minutes</strong> of AI-handled calls <strong>per branch</strong>; £0.25 per connected minute applies thereafter.',
  },
  assist: {
    minutes: 400,
    terms:
      'The <strong>Assist</strong> licence includes <strong>400 minutes</strong> of AI-handled calls <strong>per branch</strong>; £0.25 per connected minute applies thereafter. Assist <strong>excludes</strong> diary integration.',
  },
  connect: {
    messages: 500,
    terms:
      'The <strong>Connect</strong> licence includes <strong>500</strong> AI messaging conversations <strong>per branch</strong>; £0.25 per message applies thereafter. SMS charges are separate and not included within the messaging allowance; SMS messages are charged at £0.25 per message.',
  },
};

const NUM = new Intl.NumberFormat('en-GB');

export interface AgreementInputs {
  clientName: string;
  setupFeeGbp: number;
  licenceFeeGbp: number;       // per centre per month — the VOICE licence
  messagingFeeGbp?: number;    // per centre per month — the Connect messaging licence, if any
  centresCount: number;
  licences: LicenceTier[];
  goLiveDate: Date | null;
  // What free period was sold. Both absent = none, and the contract then says nothing about a
  // trial — it used to promise everyone 14 days regardless of what was agreed.
  freeTrialDays?: number | null;      // a free trial of N days
  freeUntilBookings?: number | null;  // free until the Nth confirmed booking
  effectiveDate: Date | null;  // set when signed
  signedByName?: string | null;
  signedByPosition?: string | null;
  signatureImage?: string | null; // PNG data URL captured from the canvas
}

const GBP = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const FMT_DATE = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });

const fmtDate = (d: Date | null) => (d ? FMT_DATE.format(d) : '—');

/**
 * How the free period is described, or null when none was sold.
 *
 * Three shapes, mirroring what staff pick at onboarding: nothing, a number of days, or a number
 * of confirmed bookings. The last isn't a period of time at all, so it can't share wording with
 * the other two.
 */
function freePeriod(inputs: AgreementInputs): {
  /** e.g. "a 14-day free trial" — goes in the list of what the Agreement comprises. */
  noun: string;
  /** e.g. "the free trial" — for referring back to it. */
  ref: string;
  /** When the first fee lands, in words. */
  firstCharge: string;
  /** The cancel-at-no-cost sentence. */
  cancel: string;
} | null {
  const days = inputs.freeTrialDays ?? 0;
  const bookings = inputs.freeUntilBookings ?? 0;
  if (days > 0) {
    return {
      noun: `a <strong>${days}-day free trial</strong>`,
      ref: 'the free trial',
      firstCharge: `The first monthly Licence Fee is charged on day <strong>${days + 1}</strong> unless the Client cancels during the free trial, in which case no charge is made.`,
      cancel: `During the free trial the Client may cancel at any time at no cost and shall not be charged.`,
    };
  }
  if (bookings > 0) {
    const b = `<strong>${bookings}</strong> confirmed booking${bookings === 1 ? '' : 's'}`;
    return {
      noun: `a <strong>free period</strong> continuing until the Services have produced ${b} for the Client (the &ldquo;Free Period&rdquo;)`,
      ref: 'the Free Period',
      firstCharge: `The first monthly Licence Fee is charged once the Services have produced ${b}; if that does not occur, no Licence Fee is charged.`,
      cancel: `During the Free Period the Client may cancel at any time at no cost and shall not be charged.`,
    };
  }
  return null;
}

/** Renders the full agreement HTML with commercial terms substituted in. */
export function renderAgreementHtml(inputs: AgreementInputs): string {
  const licenceList = inputs.licences
    .map((l) => `<li><strong>${LICENCE_DETAILS[l].name}</strong> — ${LICENCE_DETAILS[l].description}</li>`)
    .join('');

  // The deal can carry two licences at different prices — e.g. Automate £399 + Connect £125 per
  // branch. Billing raises them as separate lines per branch, so the contract totals the same way.
  const free = freePeriod(inputs);

  // Only the licences they bought — this used to list all three, so an Automate customer read
  // the Assist terms as though they applied.
  const usageList = inputs.licences.map((l) => `<li>${LICENCE_USAGE[l].terms}</li>`).join('');

  // With more than one branch, spell out the totals AND that they don't pool. This is the exact
  // point a customer and an overage invoice fall out.
  const totalMinutes = inputs.licences.reduce((n, l) => n + (LICENCE_USAGE[l].minutes ?? 0), 0) * inputs.centresCount;
  const totalMessages = inputs.licences.reduce((n, l) => n + (LICENCE_USAGE[l].messages ?? 0), 0) * inputs.centresCount;
  const totals = [
    totalMinutes ? `<strong>${NUM.format(totalMinutes)} minutes</strong>` : null,
    totalMessages ? `<strong>${NUM.format(totalMessages)} messaging conversations</strong>` : null,
  ].filter(Boolean);
  const allowanceNote =
    inputs.centresCount > 1 && totals.length
      ? `<p>Across the <strong>${inputs.centresCount}</strong> branches onboarded under this Agreement that is
      ${totals.join(' and ')} in total. Allowances are <strong>per branch and are not pooled</strong>: each
      branch's allowance applies to that branch alone, and unused allowance is not transferable between
      branches or carried into the following month.</p>`
      : `<p>Allowances are per branch and are not carried into the following month.</p>`;
  const messagingFee = inputs.messagingFeeGbp ?? 0;
  const perBranch = inputs.licenceFeeGbp + messagingFee;
  const monthlyTotal = perBranch * inputs.centresCount;
  const setupFeeStr = inputs.setupFeeGbp > 0 ? GBP.format(inputs.setupFeeGbp) : '£0 (waived)';
  const licenceFeeStr = GBP.format(inputs.licenceFeeGbp);
  const messagingFeeStr = GBP.format(messagingFee);
  const perBranchStr = GBP.format(perBranch);
  const monthlyTotalStr = GBP.format(monthlyTotal);

  // With one fee, say it plainly. With two, itemise — a customer must be able to read the
  // contract and reconcile it line-by-line against the invoice.
  const feeSentence = messagingFee > 0
    ? `the subscription fees shall be <strong>${licenceFeeStr}</strong> per month per branch for the
       voice licence and <strong>${messagingFeeStr}</strong> per month per branch for the Connect
       messaging licence — <strong>${perBranchStr}</strong> per branch per month in total`
    : `the subscription fee shall be <strong>${licenceFeeStr}</strong> per month per branch`;

  return `
<article class="rm-agreement">
  <header class="rm-agreement-header">
    <div class="rm-agreement-logo">
      <img src="https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png" alt="ReceptionMate" />
    </div>
    <h1>Software as a Service (SaaS) Agreement</h1>
    <p class="rm-agreement-date">Date: ${fmtDate(inputs.effectiveDate ?? new Date())}</p>
  </header>

  <section>
    <h2>Introduction</h2>
    <p>
      This agreement outlines the terms of a strategic partnership between
      <strong>ReceptionMate Ltd</strong> (the &ldquo;Provider&rdquo;) and
      <strong>${escapeHtml(inputs.clientName)}</strong> (the &ldquo;Client&rdquo;)
      regarding the provision of ReceptionMate&rsquo;s AI-powered handling services.
    </p>
  </section>

  <section>
    <h2>1. Definitions</h2>
    <p>In this Agreement, the following terms shall have the meanings set out below:</p>
    <ul>
      <li><strong>&ldquo;Services&rdquo;</strong> means the ReceptionMate AI Agent and related software components provided by the Provider on a subscription basis for call answering and enquiry handling.</li>
      <li><strong>&ldquo;Platform&rdquo;</strong> means the cloud-based ReceptionMate system made available via web, telephony, and API integration.</li>
      <li><strong>&ldquo;Authorised Users&rdquo;</strong> means the Client&rsquo;s employees or representatives who are permitted to use the Services.</li>
      <li><strong>&ldquo;Client Data&rdquo;</strong> means any data, audio, transcripts, or information inputted by the Client or its customers during use of the Services.</li>
      <li><strong>&ldquo;Initial Period&rdquo;</strong> means the initial three-month period during which the Services are provided.</li>
      <li><strong>&ldquo;Effective Date&rdquo;</strong> means the date of the last signature below.</li>
    </ul>
  </section>

  <section>
    <h2>2. Purpose and scope</h2>
    <p>
      The Provider agrees to supply, and the Client agrees to subscribe to, the ReceptionMate AI Agent Services for use in managing inbound customer enquiries, bookings, and related communications in connection with the Client&rsquo;s automotive operations.
    </p>
  </section>

  <section>
    <h2>3. Term</h2>
    <p><strong>3.1</strong> This Agreement shall commence on the agreed &ldquo;Go Live&rdquo; date${
      inputs.goLiveDate ? ` (<strong>${fmtDate(inputs.goLiveDate)}</strong>)` : ''
    } and shall comprise: ${
      free
        ? `(a) ${free.noun}; (b) an initial fixed term of <strong>three (3) months</strong> (the &ldquo;Proof Period&rdquo;) commencing at the end of ${free.ref}; and (c) upon expiry of the Proof Period, a <strong>minimum term of twelve (12) months</strong> (the &ldquo;Contract Term&rdquo;) into which this Agreement shall automatically continue.`
        : `(a) an initial fixed term of <strong>three (3) months</strong> (the &ldquo;Proof Period&rdquo;); and (b) upon expiry of the Proof Period, a <strong>minimum term of twelve (12) months</strong> (the &ldquo;Contract Term&rdquo;) into which this Agreement shall automatically continue.`
    }</p>
    <p><strong>3.2</strong> ${
      free
        ? `${free.cancel} After ${free.ref} the Client is committed to the Proof Period and the subsequent Contract Term and may terminate only in accordance with Clause 13.`
        : `The Client is committed to the Proof Period and the subsequent Contract Term and may terminate only in accordance with Clause 13.`
    }</p>
    <p><strong>3.3</strong> At the end of the Contract Term, and at the end of each subsequent term, this Agreement shall renew automatically for a further fixed term of twelve (12) months unless either Party gives not less than thirty (30) days&rsquo; written notice before the end of the then-current term.</p>

    <p>The Provider shall:</p>
    <ol type="a">
      <li>Host and maintain access to the ReceptionMate Platform;</li>
      <li>Provide AI voice agents for inbound call handling, booking management, and data capture;</li>
      <li>Integrate the Platform with the Client&rsquo;s diary or garage management system, where technically feasible;</li>
      <li>Provide support and performance reporting; and</li>
      <li>Ensure the Services are available 24 hours a day, subject to scheduled maintenance.</li>
    </ol>
  </section>

  <section>
    <h2>5. Fees and Payment</h2>
    <p><strong>5.1 Setup Fee.</strong> A setup fee of <strong>${setupFeeStr}</strong> is due upon signing this Agreement.</p>
    ${
      free
        ? `<p>
      <strong>5.2 Free Period.</strong> ${
        inputs.freeTrialDays
          ? `The first <strong>${inputs.freeTrialDays}</strong> days from the Go Live date are provided <strong>free of charge</strong>.`
          : `The Services are provided <strong>free of charge</strong> until ${free.ref} ends.`
      } The Client&rsquo;s payment method is securely authorised upon signing, but
      <strong>no charge is taken during ${free.ref}</strong>. ${free.firstCharge}
    </p>`
        : `<p>
      <strong>5.2 Commencement of Charges.</strong> No free period applies under this Agreement. The first
      monthly Licence Fee is charged upon completion of payment setup, and monthly thereafter.
    </p>`
    }
    <p>
      <strong>5.3 Licence Fee.</strong> ${free ? `Following ${free.ref}, ` : 'From the Commencement Date, '}${feeSentence}, payable monthly
      in advance throughout the Proof Period and the Contract Term. The number of branches being onboarded
      under this Agreement is <strong>${inputs.centresCount}</strong>, giving a total monthly subscription of
      <strong>${monthlyTotalStr}</strong> exclusive of VAT.
    </p>
    <p>The licences included under this Agreement are:</p>
    <ul>${licenceList}</ul>

    <p><strong>5.4 Usage Charges.</strong></p>
    <ul>${usageList}</ul>
    ${allowanceNote}

    <p><strong>5.5</strong> All fees are exclusive of VAT and payable within 14 days of invoice.</p>
  </section>

  <section>
    <h2>6. Late Payment</h2>
    <p><strong>6.1</strong> All invoices issued by the Provider are payable within fourteen (14) days of the invoice date unless otherwise agreed in writing; payment is made by Direct Debit.</p>
    <p><strong>6.2</strong> If any undisputed amount remains unpaid after the due date, the Provider may:</p>
    <ol type="a">
      <li>charge interest on the outstanding sum at a rate of 4% per annum above the Bank of England base rate, accruing daily from the due date until payment is received in full; and</li>
      <li>recover from the Client all reasonable costs of collection, including legal fees.</li>
    </ol>
    <p><strong>6.3</strong> If payment remains outstanding for more than thirty (30) days, the Provider reserves the right, upon giving at least five (5) days&rsquo; written notice, to suspend or restrict access to the Services until all overdue amounts are settled.</p>
    <p><strong>6.4</strong> Suspension of the Services for non-payment shall not relieve the Client of its obligation to pay the outstanding sums, nor extend any agreed subscription term.</p>
    <p><strong>6.5</strong> If payment remains outstanding for more than sixty (60) days, the Provider may treat the non-payment as a material breach and terminate this Agreement in accordance with Clause 13 (Termination).</p>
  </section>

  <section>
    <h2>7. Client Obligations</h2>
    <p>The Client shall:</p>
    <ol type="a">
      <li>Provide accurate business information, service lists, and booking rules required for setup;</li>
      <li>Ensure call routing and telephony settings are correctly configured to forward missed calls to the AI agent;</li>
      <li>Provide feedback and performance data during the term;</li>
      <li>Comply with applicable laws relating to the use of the Services.</li>
    </ol>
  </section>

  <section>
    <h2>8. Intellectual Property</h2>
    <p>All intellectual property rights in the ReceptionMate Platform, AI models, and related software remain the exclusive property of the Provider.</p>
    <p>The Client is granted a limited, non-exclusive, non-transferable licence to use the Services for its internal business purposes only.</p>
  </section>

  <section>
    <h2>9. Data Protection</h2>
    <p><strong>9.1</strong> Both Parties shall comply with the UK GDPR and the Data Protection Act 2018.</p>
    <p><strong>9.2</strong> The Provider acts as a Data Processor and will process Client Data solely for the purpose of providing the Services.</p>
    <p><strong>9.3</strong> The Provider shall implement appropriate technical and organisational measures to safeguard Client Data and shall not share it with third parties except as necessary to deliver the Services or as required by law.</p>
  </section>

  <section>
    <h2>10. Confidentiality</h2>
    <p>Each Party undertakes to keep confidential all proprietary or confidential information disclosed by the other Party and to use such information only for the purposes of fulfilling this Agreement.</p>
  </section>

  <section>
    <h2>11. Case Study Consent</h2>
    <p>The Client grants the Provider permission to reference its name, logo, and monetary results in case studies, marketing materials, and presentations to prospective clients, provided that no personally identifiable information or sensitive data is disclosed.</p>
  </section>

  <section>
    <h2>12. Limitation of Liability</h2>
    <p><strong>12.1</strong> The Provider&rsquo;s total liability under this Agreement shall not exceed the total fees paid by the Client during the preceding three (3) months.</p>
    <p><strong>12.2</strong> Neither Party shall be liable for any indirect, special, or consequential losses including loss of profit, revenue, or goodwill.</p>
  </section>

  <section>
    <h2>13. Termination</h2>
    <p><strong>13.1</strong> ${free ? `The Client may cancel at any time during ${free.ref} at no cost. Thereafter the` : 'The'} Client is committed to the Proof Period and the Contract Term and may not terminate for convenience during those periods. Should the Client cease to use the Services, or seek to exit, before the end of the then-current committed term other than for cause, the remaining Licence Fees for that term shall remain payable.</p>
    <p><strong>13.2</strong> Following the Contract Term, and during any subsequent renewal term, either Party may terminate on not less than thirty (30) days&rsquo; written notice given before the end of the then-current term, in accordance with Clause 3.3.</p>
    <p><strong>13.3</strong> Either Party may terminate immediately if the other Party commits a material breach that remains unremedied after 10 days of written notice, or upon the other Party&rsquo;s insolvency.</p>
  </section>

  <section>
    <h2>14. Force Majeure</h2>
    <p>Neither Party shall be liable for any failure or delay caused by circumstances beyond its reasonable control, including acts of God, network failures, or telecommunications outages.</p>
  </section>

  <section>
    <h2>15. Entire Agreement</h2>
    <p>This Agreement constitutes the entire understanding between the Parties and supersedes all prior proposals or discussions relating to its subject matter.</p>
    <p>Any amendment must be made in writing and signed by authorised representatives of both Parties.</p>
  </section>

  <section>
    <h2>16. Governing Law and Jurisdiction</h2>
    <p>This Agreement shall be governed by and construed in accordance with the laws of England and Wales, and the Parties submit to the exclusive jurisdiction of the courts of England and Wales.</p>
  </section>

  <section class="rm-signatures">
    <h2>Signatures</h2>
    <div class="rm-sig-grid">
      <div class="rm-sig-block">
        <p class="rm-sig-label">For ${escapeHtml(inputs.clientName)}:</p>
        <p><strong>Name:</strong> ${escapeHtml(inputs.signedByName ?? '____________________________')}</p>
        <p><strong>Position:</strong> ${escapeHtml(inputs.signedByPosition ?? '____________________________')}</p>
        <div class="rm-sig-line">
          <p style="margin:0 0 4px"><strong>Signature:</strong></p>
          ${
            inputs.signatureImage
              ? `<img src="${inputs.signatureImage}" alt="Signature of ${escapeHtml(inputs.signedByName ?? '')}" class="rm-sig-img" />`
              : inputs.signedByName
              ? `<em>Signed electronically by ${escapeHtml(inputs.signedByName)}</em>`
              : '____________________________'
          }
        </div>
        <p><strong>Date:</strong> ${fmtDate(inputs.effectiveDate)}</p>
      </div>
      <div class="rm-sig-block">
        <p class="rm-sig-label">For ReceptionMate Ltd:</p>
        <p><strong>Name:</strong> Daniel Tyldesley</p>
        <p><strong>Position:</strong> Director</p>
        <p><strong>Signature:</strong> <em>Signed on behalf of ReceptionMate Ltd</em></p>
        <p><strong>Date:</strong> ${fmtDate(inputs.effectiveDate)}</p>
      </div>
    </div>
  </section>
</article>
`;
}

/** CSS used to render the agreement consistently in the portal AND the PDF generator. */
export const AGREEMENT_CSS = `
.rm-agreement { font-family: 'Inter', -apple-system, system-ui, sans-serif; color: #0f172a; line-height: 1.6; }
.rm-agreement-header { text-align: left; border-bottom: 2px solid #e2e8f0; padding-bottom: 1rem; margin-bottom: 2rem; }
.rm-agreement-logo { display: inline-flex; align-items: center; justify-content: center; background: #3426cf; padding: 8px 14px; border-radius: 10px; margin-bottom: 0.75rem; }
.rm-agreement-logo img { height: 28px; width: auto; display: block; }
.rm-agreement-header h1 { margin: 0; font-size: 1.75rem; color: #3426cf; }
.rm-agreement-date { margin: 0.5rem 0 0; font-size: 0.875rem; color: #64748b; }
.rm-agreement section { margin: 2rem 0; }
.rm-agreement h2 { font-size: 1.125rem; color: #0f172a; margin: 0 0 0.75rem; }
.rm-agreement p { margin: 0.5rem 0; }
.rm-agreement ul, .rm-agreement ol { margin: 0.5rem 0 0.5rem 1.25rem; padding: 0; }
.rm-agreement li { margin: 0.25rem 0; }
.rm-signatures { border-top: 2px solid #e2e8f0; padding-top: 1.5rem; margin-top: 2.5rem; }
.rm-sig-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; margin-top: 1rem; }
.rm-sig-block { background: #f8fafc; padding: 1.25rem; border-radius: 0.75rem; border: 1px solid #e2e8f0; }
.rm-sig-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em; color: #475569; margin: 0 0 0.5rem; font-weight: 600; }
.rm-sig-line { margin: 0.5rem 0; }
.rm-sig-img { display: block; max-width: 100%; height: auto; max-height: 110px; background: #ffffff; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; }
@media (max-width: 640px) { .rm-sig-grid { grid-template-columns: 1fr; } }
`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
