import { brandedEmailShell } from '../utils/email.js';

/**
 * The "getting ready" email a GarageHive garage receives on signing.
 *
 * It used to be one paragraph asking them to add an "Other" service package. The bulk of it now
 * is the Garage Link Advanced setup, because that is the one piece of the connection nobody but
 * the garage can do: ReceptionMate has to be registered as an Entra application inside their own
 * Garage Hive and granted consent by a Microsoft 365 administrator. No amount of work on our side
 * substitutes for it, and "ask Garage Hive to turn it on" is not actionable — so the steps are
 * here in full, with the client ID and the three permission sets they have to type in.
 *
 * Kept as a pure builder, separate from the sending, so the copy is testable without a database
 * or a mail transport. The placeholders in the hand-built original ({{FIRST_NAME}},
 * {{GROUP_PARAGRAPH}}) are substituted here and asserted gone in gettingReadyEmail.test.ts — an
 * unsubstituted one reaching a customer is the kind of fault nobody spots until they mention it.
 *
 * `clientId` is a parameter and never a literal. The email tells the garage which application to
 * approve; if that string drifts from the GARAGEHIVE_CLIENT_ID we actually authenticate with,
 * they grant consent to something we do not use and the connection fails with nothing to show
 * why. One source, passed in.
 */

export const GH_OTHER_GUIDE_URL =
  'https://garagehive-co.slite.com/app/docs/YzHdXMeW8CwmE3/How-to-Set-Up-an-Other-Service-Package-for-Custom-Online-Bookings';

// Typed into Business Central by hand, so they are reproduced exactly. The phonebook one is the
// one that matters most: without it an incoming call cannot be matched to a customer record,
// which is the entire point of this email.
export const GH_PERMISSION_SETS = ['GHV PHONEBOOK API', 'D365 FULL ACCESS', 'GHV GH FULL ACCESS'] as const;

export type GettingReadyInput = {
  garageName: string;
  /** From Agreement.signedByName or Business.contactName. Empty is fine — the greeting adapts. */
  firstName: string;
  branchCount: number;
  clientId: string;
};

/** Escape data before it goes into the HTML body. firstName arrives from Agreement.signedByName
 *  — free text the signatory types on the sign page — so it is not ours to trust. Not a serious
 *  XSS vector (mail clients do not execute script, and this goes to the garage's own manager),
 *  but it is untrusted data in an HTML document, and the everyday form of the bug is a garage
 *  called "Smith & Sons" rendering wrongly. The plain-text part is deliberately NOT escaped. */
const esc = (v: string): string =>
  v.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const P = 'margin:0;font-size:15px;line-height:1.65;color:#0f172a;';
const MUTED = 'color:#64748b;';

const row = (inner: string, pad = '26px 32px 0') =>
  `<tr><td style="padding:${pad};">${inner}</td></tr>`;

const stepHeading = (n: number, label: string) =>
  row(
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>`
    + `<td style="border-top:1px solid #e9eaf5;padding-top:16px;">`
    + `<p style="margin:0;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:#3426cf;">`
    + `Step ${n} &nbsp;&middot;&nbsp; ${label}</p></td></tr></table>`,
    '30px 32px 0',
  );

const numbered = (n: number, inner: string) =>
  row(
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>`
    + `<td width="32" style="vertical-align:top;padding-top:1px;">`
    + `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>`
    + `<td width="24" height="24" align="center" style="background-color:#3426cf;color:#ffffff;border-radius:12px;font-size:13px;font-weight:700;line-height:24px;">${n}</td>`
    + `</tr></table></td>`
    + `<td style="font-size:15px;line-height:1.6;color:#0f172a;">${inner}</td>`
    + `</tr></table>`,
    '18px 32px 0',
  );

const panel = (inner: string, accent = '#3426cf') =>
  row(
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#f7f7fb;border-left:4px solid ${accent};border-radius:6px;">`
    + `<tr><td style="padding:14px 18px;font-size:15px;line-height:1.6;color:#0f172a;">${inner}</td></tr></table>`,
    '24px 32px 0',
  );

const mono = (label: string, value: string) =>
  row(
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#f7f7fb;border:1px solid #e9eaf5;border-radius:10px;">`
    + `<tr><td style="padding:14px 18px;">`
    + `<p style="margin:0 0 4px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#8b90b0;">${label}</p>`
    + `<p style="margin:0;font-family:'Courier New',monospace;font-size:15px;color:#0f172a;word-break:break-all;">${value}</p>`
    + `</td></tr></table>`,
    '12px 32px 0',
  );

/** Replies land as a Ticket in /admin/tickets. This email asks the reader to reply TWICE — the
 *  tenant ID and environment name come back that way — and sendEmail defaults the reply address
 *  to noreply@, which would drop both on the floor. It lives here, beside the copy that makes
 *  the promise, so the two cannot drift apart. */
export const GETTING_READY_REPLY_TO = 'hello@receptionmate.co.uk';

export function buildGettingReadyEmail(input: GettingReadyInput): {
  subject: string;
  html: string;
  text: string;
  replyTo: string;
} {
  const { garageName, firstName, branchCount, clientId } = input;
  const name = firstName.trim();
  const greeting = name ? `Hi ${name},` : 'Hi,';            // plain text, as typed
  const greetingHtml = name ? `Hi ${esc(name)},` : 'Hi,';   // html, escaped

  // Only for a group. A single-site garage told about "branches" reads as a mistake, and a group
  // NOT told reads as though all ten steps are repeated per branch.
  const groupHtml = branchCount > 1
    ? `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#0f172a;">You only need to do this once — the same approval covers all ${branchCount} of your branches.</p>`
    : '';
  const groupText = branchCount > 1
    ? `You only need to do this once - the same approval covers all ${branchCount} of your branches.\n\n`
    : '';

  const permsHtml = GH_PERMISSION_SETS
    .map((p, i) => `<p style="margin:${i === 0 ? '0' : '8px 0 0'};font-family:'Courier New',monospace;font-size:14px;font-weight:700;color:#0f172a;">${p}</p>`)
    .join('');

  const body = [
    row(
      `<h1 style="margin:0;font-size:21px;font-weight:700;color:#0f172a;line-height:1.3;">Getting ready for ReceptionMate</h1>`
      + `<p style="margin:6px 0 0;font-size:15px;color:#64748b;">A couple of things to set up in your Garage Hive, about five minutes</p>`,
      '32px 32px 0',
    ),
    row(
      `<p style="${P}">${greetingHtml}</p>`
      + `<p style="margin:14px 0 0;font-size:15px;line-height:1.65;color:#0f172a;">Thanks for signing up. To get your ReceptionMate receptionist ready, there are a couple of things to set up in Garage Hive &mdash; please follow the steps below. It takes about five minutes.</p>`
      + `<p style="margin:14px 0 0;font-size:15px;line-height:1.65;color:#0f172a;">Once they are done, your receptionist will be able to:</p>`
      + `<ul style="margin:12px 0 0;padding-left:22px;font-size:15px;line-height:1.65;color:#0f172a;">`
      + `<li style="margin-bottom:7px;">greet returning customers by name</li>`
      + `<li style="margin-bottom:7px;">already know which vehicle they are ringing about, without asking for the reg</li>`
      + `<li>offer outstanding advisory work from their last health check</li>`
      + `</ul>`,
    ),
    panel('It all happens inside your own Garage Hive. There is no downtime, and nothing changes about how your team works day to day.'),
    row(
      `<h2 style="margin:0 0 8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:#8b90b0;">Before you start</h2>`
      + `<p style="${P}">You will need someone who can sign in to Garage Hive as an administrator. The last step also needs your Microsoft 365 administrator to approve it &mdash; often the same person, but if your IT is handled externally it is worth having them to hand, because that approval is the step this usually stalls on.</p>`,
    ),

    stepHeading(1, 'Add ReceptionMate as an approved application'),
    numbered(1, 'Sign in to Garage Hive.'),
    numbered(2, `Click the magnifying glass (search) at the top right, type <strong>Microsoft Entra applications</strong> and open that page. <span style="${MUTED}">On older versions it is called "Azure Active Directory Applications" &mdash; same page, same steps.</span>`),
    numbered(3, 'Click <strong>New</strong>.'),
    numbered(4, 'Paste this into the <strong>Client ID</strong> field:'),
    mono('Client ID', esc(clientId)),
    numbered(5, 'In the <strong>Description</strong> field, put <strong>ReceptionMate</strong>.'),

    stepHeading(2, 'Switch on the three permissions'),
    numbered(
      6,
      `Find the <strong>User Permission Sets</strong> section towards the bottom of the same screen, click <strong>Add</strong>, and add all three of these:`
      + `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-top:12px;background-color:#f7f7fb;border:1px solid #e9eaf5;border-radius:10px;">`
      + `<tr><td style="padding:14px 18px;">${permsHtml}</td></tr></table>`
      + `<p style="margin:12px 0 0;">All three are needed. The phonebook one is what lets us match an incoming call to the right customer, so recognition will not work without it.</p>`
      + `<p style="margin:10px 0 0;${MUTED}">If Business Central will not let you add SUPER, that is expected &mdash; it does not allow that one on an application, and it is not needed here.</p>`,
    ),

    stepHeading(3, 'Enable it and grant access'),
    numbered(7, 'Set the <strong>State</strong> field to <strong>Enabled</strong>.'),
    numbered(
      8,
      `Click <strong>Grant Consent</strong> at the top of the screen. Depending on your version the button may read <strong>Grant Permissions</strong> or <strong>Grant Access</strong> instead &mdash; it is the same thing.`
      + `<p style="margin:10px 0 0;">A Microsoft sign-in window will open. Sign in with your Microsoft 365 administrator account and accept.</p>`,
    ),
    panel(
      `<strong>This is the step that actually lets us in</strong>, so it is worth checking it completed. If you see a message about needing an administrator to approve, that account does not have the right permissions &mdash; whoever manages your Microsoft 365 will need to do this part.`,
      '#b45309',
    ),

    stepHeading(4, 'Send us two details'),
    row(`<p style="${P}">Last bit, and then you are done. We just need to know which Garage Hive account to point at.</p>`),
    numbered(9, 'Click the <strong>question mark</strong> at the top right of Garage Hive, choose <strong>Help &amp; Support</strong>, and scroll down to the "Report a problem" section.'),
    numbered(
      10,
      `Reply to this email with the two values shown there:`
      + `<ul style="margin:10px 0 0;padding-left:22px;">`
      + `<li style="margin-bottom:6px;"><strong>Microsoft Entra tenant ID</strong> <span style="${MUTED}">(a long string of letters and numbers)</span></li>`
      + `<li><strong>Environment name</strong> <span style="${MUTED}">(usually "Production")</span></li>`
      + `</ul>`
      + `<p style="margin:12px 0 0;${MUTED}">Newer versions have a "Copy the text below" link in that section &mdash; if you see it, click that and paste the whole lot into your reply, and we will pick out what we need.</p>`,
    ),
    row(`${groupHtml}<p style="${P}">We will finish the connection at our end, test it, and email you to confirm it is live.</p>`),

    // Carried over from the version of this email that existed before the Advanced steps. Still
    // needed: without an "Other" package the agent cannot book a job that matches no standard
    // service, and it is a Garage Hive setup task like the rest, so it belongs in the same email.
    row(
      `<h2 style="margin:0 0 8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:#8b90b0;">One more thing, whenever suits</h2>`
      + `<p style="${P}">Add an <strong>&ldquo;Other&rdquo;</strong> service package in Garage Hive, so the agent can book custom jobs that do not match a standard service. Garage Hive's guide walks you through it &mdash; <a href="${GH_OTHER_GUIDE_URL}" style="color:#3426cf;font-weight:600;">How to set up an &ldquo;Other&rdquo; service package</a>.</p>`,
    ),

    row(
      `<h2 style="margin:0 0 8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:#8b90b0;">What this gives us</h2>`
      + `<p style="${P}">So you know exactly where you stand: we read your customer and vehicle records, so the agent knows who is calling and what they drive. The only thing we ever write back is an opt-out flag on a customer's record, if they ask us to stop contacting them &mdash; that way Garage Hive stays the single source of truth for your customer list.</p>`,
    ),
    row(
      `<p style="${P}">Any questions at all, or if you would rather I talked someone through it on the phone, just reply to this and I will pick it up.</p>`
      + `<p style="margin:16px 0 0;font-size:15px;line-height:1.65;color:#0f172a;">Thanks,<br/><strong>Dan Tyldesley</strong><br/><span style="${MUTED}">ReceptionMate</span></p>`,
    ),
    row(
      `<div style="font-size:14px;line-height:1.6;color:#64748b;text-align:center;"><a href="mailto:hello@receptionmate.co.uk" style="color:#3426cf;text-decoration:none;">hello@receptionmate.co.uk</a></div>`,
      '26px 32px 8px',
    ),
  ].join('');

  // Written out rather than stripped from the HTML: a tag-stripped version of a table-based
  // email is unreadable, and this is what a plain-text client actually shows.
  const text = [
    greeting,
    '',
    'Thanks for signing up. To get your ReceptionMate receptionist ready, there are a couple of',
    'things to set up in Garage Hive - please follow the steps below. It takes about five minutes.',
    '',
    'Once they are done, your receptionist will be able to greet returning customers by name,',
    'already know which vehicle they are ringing about, and offer outstanding advisory work from',
    'their last health check. It all happens inside your own Garage Hive - no downtime, and',
    'nothing changes about how your team works day to day.',
    '',
    'BEFORE YOU START',
    'You will need someone who can sign in to Garage Hive as an administrator. The last step also',
    'needs your Microsoft 365 administrator to approve it - often the same person, but if your IT',
    'is handled externally it is worth having them to hand, because that approval is the step this',
    'usually stalls on.',
    '',
    'STEP 1 - ADD RECEPTIONMATE AS AN APPROVED APPLICATION',
    '1. Sign in to Garage Hive.',
    '2. Click the magnifying glass (search) at the top right, type "Microsoft Entra applications"',
    '   and open that page. On older versions it is called "Azure Active Directory Applications"',
    '   - same page, same steps.',
    '3. Click New.',
    `4. Paste this into the Client ID field:  ${clientId}`,
    '5. In the Description field, put: ReceptionMate',
    '',
    'STEP 2 - SWITCH ON THE THREE PERMISSIONS',
    '6. Find the User Permission Sets section towards the bottom of the same screen, click Add,',
    '   and add all three of these:',
    ...GH_PERMISSION_SETS.map((p) => `     ${p}`),
    '   All three are needed. The phonebook one is what lets us match an incoming call to the',
    '   right customer, so recognition will not work without it.',
    '   If Business Central will not let you add SUPER, that is expected - it does not allow that',
    '   one on an application, and it is not needed here.',
    '',
    'STEP 3 - ENABLE IT AND GRANT ACCESS',
    '7. Set the State field to Enabled.',
    '8. Click Grant Consent at the top of the screen. Depending on your version the button may',
    '   read Grant Permissions or Grant Access instead - it is the same thing. A Microsoft',
    '   sign-in window will open; sign in with your Microsoft 365 administrator account and',
    '   accept.',
    '   This is the step that actually lets us in, so it is worth checking it completed. If you',
    '   see a message about needing an administrator to approve, that account does not have the',
    '   right permissions - whoever manages your Microsoft 365 will need to do this part.',
    '',
    'STEP 4 - SEND US TWO DETAILS',
    '9. Click the question mark at the top right of Garage Hive, choose Help & Support, and',
    '   scroll down to the "Report a problem" section.',
    '10. Reply to this email with the two values shown there:',
    '      Microsoft Entra tenant ID (a long string of letters and numbers)',
    '      Environment name (usually "Production")',
    '    Newer versions have a "Copy the text below" link in that section - if you see it, click',
    '    that and paste the whole lot into your reply, and we will pick out what we need.',
    '',
    groupText + 'We will finish the connection at our end, test it, and email you to confirm it is live.',
    '',
    'ONE MORE THING, WHENEVER SUITS',
    'Add an "Other" service package in Garage Hive, so the agent can book custom jobs that do not',
    `match a standard service. Garage Hive's guide: ${GH_OTHER_GUIDE_URL}`,
    '',
    'WHAT THIS GIVES US',
    'We read your customer and vehicle records, so the agent knows who is calling and what they',
    "drive. The only thing we ever write back is an opt-out flag on a customer's record, if they",
    'ask us to stop contacting them - that way Garage Hive stays the single source of truth for',
    'your customer list.',
    '',
    'Any questions at all, or if you would rather I talked someone through it on the phone, just',
    'reply to this and I will pick it up.',
    '',
    'Thanks,',
    'Dan Tyldesley',
    'ReceptionMate',
    'hello@receptionmate.co.uk',
  ].join('\n');

  return {
    subject: `Getting ${garageName.replace(/[\r\n]+/g, ' ').trim()} ready for ReceptionMate`,
    html: brandedEmailShell(body),
    text,
    replyTo: GETTING_READY_REPLY_TO,
  };
}
