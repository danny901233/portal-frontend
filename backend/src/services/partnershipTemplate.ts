// Partnership service agreement template (e.g. FixMyCar marketplace deal).
// Rendered with the shared AGREEMENT_CSS (rm-* classes) for consistent portal + PDF output.
// Fixed commercial terms are baked into the wording; only the signer + dates vary.

export interface PartnershipInputs {
  clientName: string;
  effectiveDate: Date | null; // set when signed
  signedByName?: string | null;
  signedByPosition?: string | null;
  signatureImage?: string | null; // PNG data URL from the signature canvas
}

const FMT_DATE = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
const fmtDate = (d: Date | null) => (d ? FMT_DATE.format(d) : '—');

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderPartnershipHtml(inputs: PartnershipInputs): string {
  const client = esc(inputs.clientName);
  return `
<article class="rm-agreement">
  <header class="rm-agreement-header">
    <div class="rm-agreement-logo"><img src="https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png" alt="ReceptionMate" /></div>
    <h1>Service Agreement</h1>
    <p class="rm-agreement-date">Date: ${fmtDate(inputs.effectiveDate ?? new Date())}</p>
  </header>

  <section>
    <h2>Parties</h2>
    <p><strong>Provider:</strong> ReceptionMate Ltd, company no. 16839506, Studio 9, 50&ndash;54 St. Paul&rsquo;s Square, Birmingham B3 1QS (VAT 494543753).</p>
    <p><strong>Client:</strong> ${client}, company no. 07455738, 1st Floor Suite 3, 100 Longwater Avenue, Green Park, Reading, Berkshire RG2 6GP.</p>
  </section>

  <section>
    <h2>Introduction</h2>
    <p>This Agreement sets out the terms of a partnership between <strong>ReceptionMate Ltd</strong> (the &ldquo;Provider&rdquo;) and <strong>${client}</strong> (the &ldquo;Client&rdquo;) for the provision of ReceptionMate&rsquo;s AI-powered booking-protection services across the Client&rsquo;s marketplace.</p>
  </section>

  <section>
    <h2>1. Definitions</h2>
    <ul>
      <li><strong>&ldquo;Services&rdquo;</strong> means the ReceptionMate AI agents and related software that confirm, protect and follow up the Client&rsquo;s bookings, including masked customer communications, reminders, cancellation handling and rebooking.</li>
      <li><strong>&ldquo;Booking&rdquo;</strong> means a booking placed through the Client&rsquo;s marketplace; a <strong>&ldquo;Managed Booking&rdquo;</strong> is one handled by the Services.</li>
      <li><strong>&ldquo;Commission&rdquo;</strong> means the fee the Client earns in respect of a Booking.</li>
      <li><strong>&ldquo;Completion&rdquo;</strong> means the relevant job being carried out, at which point the Client earns its Commission.</li>
      <li><strong>&ldquo;Initial Period&rdquo;</strong> means the three (3) month trial period during which the Services are first provided.</li>
      <li><strong>&ldquo;Effective Date&rdquo;</strong> means the date of the last signature below.</li>
    </ul>
  </section>

  <section>
    <h2>2. Purpose and scope</h2>
    <p><strong>2.1</strong> The Provider agrees to supply, and the Client agrees to use, the Services to protect and grow the Client&rsquo;s bookings: confirming bookings, keeping customer and garage communications on a masked channel, reducing no-shows, saving cancellations, verifying attendance after the job, and rebooking customers for their next service.</p>
    <p><strong>2.2</strong> The Services operate in the pre-arrival window and the post-job follow-up. Once a vehicle is dropped off, the garage and customer deal directly. On-site work and any additional work carried out at the garage are out of scope.</p>
  </section>

  <section>
    <h2>3. Term</h2>
    <p><strong>3.1</strong> This Agreement commences on the agreed go-live date and continues for the Initial Period of three (3) months.</p>
    <p><strong>3.2</strong> After the Initial Period, this Agreement continues on a rolling monthly basis and will be reviewed by the Parties. Either Party may terminate in accordance with Clause 13.</p>
  </section>

  <section>
    <h2>4. Provider responsibilities</h2>
    <p>The Provider shall: (a) host and maintain the Platform; (b) provide AI voice, WhatsApp and SMS agents for booking confirmation, masked communications, reminders, cancellation handling, post-job follow-up and rebooking; (c) integrate with the Client&rsquo;s booking system where technically feasible; (d) handle WhatsApp template approval and messaging compliance; (e) provide weekly performance reporting during the Initial Period; and (f) make the Services available 24 hours a day, subject to scheduled maintenance.</p>
  </section>

  <section>
    <h2>5. Fees and payment</h2>
    <p><strong>5.1 Setup fee.</strong> A one-off setup and integration fee of <strong>&pound;2,500</strong> is due on signing this Agreement.</p>
    <p><strong>5.2 Service fee.</strong> The Provider shall charge <strong>3% of the Commission</strong> earned by the Client on each Managed Booking, charged on Completion of the relevant job. No fee is charged on bookings that do not complete.</p>
    <p><strong>5.3 Minimum monthly charge.</strong> A minimum charge of <strong>&pound;2,500 per month</strong> applies. Where the Service Fee for a month is less than the minimum, the minimum is payable; where it is greater, the Service Fee applies.</p>
    <p><strong>5.4 Messaging and voice.</strong> Customer messaging (WhatsApp and SMS) is included. AI voice calls are included up to a fair-usage allowance of <strong>10,000 connected minutes per month</strong>; connected minutes beyond the allowance are charged at <strong>&pound;0.25 per minute</strong>.</p>
    <p><strong>5.5 Invoicing.</strong> The setup fee is payable on signing. The Service Fee (or minimum) is invoiced monthly in arrears, based on Managed Bookings that reached Completion in the month. All fees are exclusive of VAT and payable within fourteen (14) days of invoice.</p>
  </section>

  <section>
    <h2>6. Late payment</h2>
    <p><strong>6.1</strong> If any undisputed amount remains unpaid after its due date, the Provider may charge interest at 4% per annum above the Bank of England base rate, accruing daily until paid.</p>
    <p><strong>6.2</strong> If payment remains outstanding for more than thirty (30) days, the Provider may, on five (5) days&rsquo; written notice, suspend the Services until overdue amounts are settled. Suspension does not relieve the Client of its obligation to pay.</p>
  </section>

  <section>
    <h2>7. Client responsibilities</h2>
    <p>The Client shall: (a) provide API access to its booking system so the Provider can confirm, reschedule and rebook; (b) capture customer opt-in to messaging at the point of booking; (c) provide the Commission information needed to calculate the Service Fee; (d) provide reasonable feedback and performance data during the term; and (e) comply with applicable laws relating to its use of the Services.</p>
  </section>

  <section>
    <h2>8. Intellectual property</h2>
    <p>All intellectual property rights in the Platform, AI models and related software remain the exclusive property of the Provider. The Client is granted a limited, non-exclusive, non-transferable licence to use the Services for its internal business purposes during the term.</p>
  </section>

  <section>
    <h2>9. Data protection</h2>
    <p><strong>9.1</strong> Both Parties shall comply with the UK GDPR and the Data Protection Act 2018.</p>
    <p><strong>9.2</strong> In respect of customer data, the Client is the Data Controller and the Provider is the Data Processor, processing such data solely to provide the Services.</p>
    <p><strong>9.3</strong> The Provider shall implement appropriate technical and organisational measures to safeguard customer data and shall not share it with third parties except as necessary to deliver the Services or as required by law. The Parties shall enter into a separate Data Processing Agreement.</p>
  </section>

  <section>
    <h2>10. Confidentiality</h2>
    <p>Each Party shall keep confidential all proprietary or confidential information disclosed by the other and use it only for the purposes of this Agreement. Commercial terms, including fees, are confidential to the Parties.</p>
  </section>

  <section>
    <h2>11. Publicity</h2>
    <p>Neither Party shall use the other&rsquo;s name or logo in marketing or public materials without that Party&rsquo;s prior written approval. The Provider may refer to aggregate, anonymised performance results that do not identify the Client or its customers.</p>
  </section>

  <section>
    <h2>12. Limitation of liability</h2>
    <p><strong>12.1</strong> The Provider&rsquo;s total liability under this Agreement shall not exceed the total fees paid by the Client in the preceding three (3) months.</p>
    <p><strong>12.2</strong> Neither Party shall be liable for any indirect, special or consequential losses, including loss of profit, revenue or goodwill.</p>
  </section>

  <section>
    <h2>13. Termination</h2>
    <p><strong>13.1</strong> Either Party may terminate at any time after the Initial Period on thirty (30) days&rsquo; written notice.</p>
    <p><strong>13.2</strong> Either Party may terminate immediately if the other commits a material breach that remains unremedied ten (10) days after written notice.</p>
  </section>

  <section>
    <h2>14. Force majeure</h2>
    <p>Neither Party shall be liable for any failure or delay caused by circumstances beyond its reasonable control, including network failures or telecommunications outages.</p>
  </section>

  <section>
    <h2>15. Entire agreement</h2>
    <p>This Agreement is the entire understanding between the Parties and supersedes all prior proposals or discussions on its subject matter. Any amendment must be in writing and signed by authorised representatives of both Parties.</p>
  </section>

  <section>
    <h2>16. Governing law</h2>
    <p>This Agreement is governed by the laws of England and Wales, and the Parties submit to the exclusive jurisdiction of the courts of England and Wales.</p>
  </section>

  <section class="rm-signatures">
    <h2>Signatures</h2>
    <div class="rm-sig-grid">
      <div class="rm-sig-block">
        <p class="rm-sig-label">For ${client}:</p>
        <p><strong>Name:</strong> ${esc(inputs.signedByName ?? '____________________________')}</p>
        <p><strong>Position:</strong> ${esc(inputs.signedByPosition ?? '____________________________')}</p>
        <div class="rm-sig-line">
          <p style="margin:0 0 4px"><strong>Signature:</strong></p>
          ${
            inputs.signatureImage
              ? `<img src="${inputs.signatureImage}" alt="Signature of ${esc(inputs.signedByName ?? '')}" class="rm-sig-img" />`
              : inputs.signedByName
              ? `<em>Signed electronically by ${esc(inputs.signedByName)}</em>`
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
</article>`;
}
