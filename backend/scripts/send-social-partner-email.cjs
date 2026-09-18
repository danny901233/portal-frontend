// One-off: email Dan the garage social-media partner/prospect analysis.
//   node scripts/send-social-partner-email.cjs            # dry run, prints the subject + recipients
//   node scripts/send-social-partner-email.cjs --send
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
const SEND = process.argv.includes('--send');
const TO = ['dan@receptionmate.co.uk'];

const tier1 = [
  ['Krause Autos Body Shop', 'TikTok @krause.autos.bodyshop', '1.5K followers · 2.2M / 192K / 182K views', 'Sandy, Beds', '01767 692798', '', 'Absurd view-to-follower ratio. Already posts phone-themed skits ("When you get a call saying your favourite customer is in the garage").'],
  ['AMG The Garage', 'TikTok @amgthegarage', '1.2K followers · 137K–251K views', 'Gosport', '', '', 'Posts booking chaos AND "AI is going to take over your job". Half the script writes itself.'],
  ['The Norfolk Tech', 'TikTok @thenorfolktech', '5.6K followers · 55K–82K views', 'Norfolk', '', '', '~12x view-to-follower ratio. Face-to-camera technician.'],
  ['MotorSorted', 'TikTok @motorsorted · FB MotorSorted · motorsorted.com', '6.7K TikTok + 2.3K FB on only 6 posts', 'Burton-upon-Trent', '', '', 'OPENING AUTUMN 2026. Whole channel is "follow the build". Needs a phone system from day one and the install IS the content.'],
  ['Station Garage / MCFixit', 'FB Station Garage · IG @stationgaragehyde · YouTube', '13K FB + 1.6K IG · 254K views', 'Hyde SK14 2JP', '0161 368 4160', 'service@stationgaragehyde.co.uk', 'Green-screen studio, 45 years trading. Owner Mark presents.'],
  ['Lowes Garage', 'TikTok @lowesgarageworcs', '7K followers · 5K–9K, one at 179.6K', 'Worcestershire', '', '', '"Mechanics with a great sense of humour" — team comedy format.'],
];

const tier2 = [
  ['AutoTekz Ltd', 'TikTok @autotekzltd · FB Auto Tekz Cambridge', '32.2K TikTok + 56K FB (~90K) · 184K–876K views', 'Cambridge', '0800 020 9847 / 01223 481165', 'has a published collabs & management email', 'Real garage, huge reach, explicitly open to collabs. ALREADY runs a Carly affiliate — will likely want cash.'],
  ['KFA Vehicle Repair', 'TikTok @kfarepair', '16.5K followers · one video 3.9M', 'Bellshill, Scotland', '01698 767117', '', 'Scotland’s wet belt specialists. AS SEEN ON WHEELER DEALERS WORLD TOUR. Does live streams.'],
  ['Baz Meredith', 'IG @baz_meredith · YouTube 130K subs', '20.9K IG + 130K YT · 136M channel views', 'UK', '', '', 'Biggest genuine UK garage creator in the set. 2024 award-winning creator, working mechanic. Most expensive.'],
  ['The Grumpy Technician (Martin Hind)', 'TikTok @grumpygarageowner · linktr.ee/martinhind', '57.5K followers · 2.1M likes · 75K–84K views', 'UK', '', '', 'Garage-owner opinion content — perfect audience. Already monetising (Showcase + Subscription).'],
  ['Dans Automotive Services', 'IG @dansautomotiveservices', '11.1K, verified', 'UK', '', '', 'Bio literally says "If your brand loves speed, storytelling & fun, let’s talk." Actively inviting brand deals.'],
  ['Serks Motorworks (Serkan Mustafa) + Marky Daley', 'IG @serks_motorworks / @serksmotorwork / @md1_marky', '25.7K + 19.6K + 70.4K (~90K) · 6.6M top view', 'UK', '', '', 'Owner-led, huge reach — but race builds and drag racing, so enthusiast audience not garage owners.'],
];

const tier3 = [
  ['RMS Diagnostics', 'FB RMS Diagnostics — "Digital creator"', '16K followers', 'Sandwich, Kent', '', '', 'Auto electrician who "creates content as I go". Runs Technical Skool LIVE TRAINING for technicians. In Garage Hive Community + On The Ramp Podcast + Garage Owners Network. His audience IS your buyer.'],
  ['Matt Cleevely', 'FB (Garage Hive Community)', '3,244 pts, top contributor since 2021', 'Cheltenham', '', '', 'Cleevely Motors / Cleevely EV. Speaks on stage at trade events.'],
  ['Barry Lawson', 'FB (Garage Hive Community)', '8,562 pts ALL-STAR, member since 2019', 'Scotland', '', '', 'Highest GH community score seen anywhere in the set. Top opinion leader among garage owners.'],
  ['Nev Smith', 'FB (Garage Hive Community)', '5,214 pts ALL-STAR, since 2018', 'UK', '', '', 'Another top GH community voice.'],
  ['Gavin Parry', 'FB (Garage Hive Community)', '4,605 pts top contributor, 1,821 friends', 'Wales', '', '', 'Services Autocentre.'],
  ['Woodyard Garage Group', 'FB Woodyard Garage Group', '5.8K · 85.5K top reel', 'Bromsgrove & Redditch', '', '', 'Proper studio with mic and acoustic panels. Posts TRADE topics (Block Exemption, PCP rules) not car content.'],
  ['Karl Payne', 'FB — "Digital creator" profile', '1,800 friends', 'Forge Garage Winton, Bournemouth', '01202 375001', '', 'GARAGE AWARDS WINNER. Makes his own promo graphics.'],
  ['Lee Robinson', 'FB (Garage Hive Community) — "Digital creator"', '1,277 friends', 'UK', '', '', 'GH Community member AND a digital creator — integration already works, so zero friction.'],
];

const skip = [
  ['Petrolheadonism', '183K IG', 'Supercar events/community brand, not a garage. Consumer audience.'],
  ['GVE London', '1.4M TikTok', 'Supercar dealership. Enormous but wrong audience and far too big.'],
  ['Acklam Cars / Auto 100 / The Car Group / Sturgess', '92.2K / 16.2K / 66.7K / 1.3K', 'Prestige dealers and a finance broker — not repair garages.'],
  ['Mathewsons Classic Cars', '41.5K IG', 'Home of Bangers & Cash. Auctions, not servicing.'],
  ['Grace Roberts (@graceautos_)', '125K IG · 53.3M top view', 'Pro creator with a talent agency. Will want real money, and isn’t a garage.'],
  ['Harrisen & Co / Tom’s Auto / RCJ Mobile Mechanics', '339.6K / 1.6K / 1.1M', 'US and Caribbean. Wrong country.'],
  ['Chris Slix / Mossey', '140K FB / 15.2K IG · 6.2M views', 'Big creators with no garage to install into. Chris already does brand deals (joinvoy).'],
  ['The Dreadlock Mechanic', '127.7K, 7.2M likes', 'Right audience but views have collapsed to 1–6K. Now podcast/meme, not workshop.'],
  ['AutoNet VIP', '14K followers, 247–387 views', 'That audience is dead.'],
  ['Unico’s Garage / JnJ Detailing / Two Shades', '17.5K / 99.8K / verified', 'Wrapping, tint and PPF — not servicing, so the diary story doesn’t land.'],
  ['Hilton Garage UK', '21.8K', 'UK’s largest car supermarket. Has its own marketing team.'],
];

const prospects = [
  ['Nexa Max Garages (Andrew Stetsovsky)', 'FB @nmgarages · nexamaxgarages.co.uk', 'London', '', '', 'HOT — GH all-star, actively asking about AI phone answer quality in the community thread.'],
  ['Philip Raby', 'FB (Garage Hive Community)', 'UK', '', '', 'HOT — already using Steady Bow as "a glorified answer service". Competitive displacement.'],
  ['Prestige German Engines', 'IG @prestigegermanengines', 'Whittlesey PE7 2EY', '07757 687777', 'prestigeengines@icloud.com', '12.1K, verified. BMW/Mini independent, 200+ 5-star reviews, NEW PREMISES + hiring = good timing.'],
  ['VW-Group Specialist Ltd', 'IG @vwgspecialist · FB VWGSpecialist LTD', 'Kings Norton, Birmingham', '0121 389 0227', '', '4.9K IG + 2.9K FB. COVENTRY BRANCH OPENING — multi-branch deal. (Not the same business as VGS Performance Swindon, who are already a customer.)'],
  ['Peugeotech', 'TikTok @peugeotech_uk', 'Buckinghamshire', '07778 113420', '', '8K followers. Bio literally says "To book in please call" — perfect fit.'],
  ['Alcomoto Limited', 'TikTok @alcomoto', 'South of England', '', '', '12.8K, very polished consistent template. Performance/Prestige/EV/diagnostic specialist.'],
  ['Milltop Motorsport', 'TikTok @milltopmotorsport', 'UK', '', '', '5.75K. Posts "phones are getting louder" — phone pain already in their content. Has a video-ideas whiteboard.'],
  ['Naz Motor Clinic', 'TikTok @nazmotorclinic', 'London & Kent', '', '', '5.9K. Takes enquiries by DM — natural ReceptionMate story.'],
  ['Fife Autotech Ltd', 'FB Fife Autotech', 'Glenrothes, Fife', '', '', '7.2K, one reel at 760K. Independent VW/Audi/Seat/Skoda specialist.'],
  ['Oly Autos', 'FB Oly Autos · IG olyautosltd', 'London', '', '', '20K. Established vehicle repair centre, owner presents.'],
  ['SGR Automotive', 'TikTok @sgr.automotive', 'Manchester', '0161 694 7331', '', 'Mobile mechanic — strong story (can’t answer the phone under a car).'],
  ['Glasgow Prestige Auto Repairs', 'TikTok @glasgowprestigeau', 'Glasgow', '', '', '1.5K. Wet belt/MOT/brakes/recovery.'],
  ['Corley Ash Garage', 'TikTok @corley.ash.garage', 'Coventry', '024 7509 9158', '', '228 followers but one video at 530.6K. Keen.'],
  ['Melrod Customs', 'TikTok @melrodcustom', 'London', '', '', '4.2K, pinned series 102K–149K.'],
  ['DMR Vehicle Care', 'IG @dmr_vehiclecare', 'Bromley BR2 6DQ', '+44 7510 949123', '', 'Verified body shop, owner presents, RUNS IG ADS (has budget).'],
  ['IC Automotive (IC Autos)', 'IG @ic_automotiveltd · icautos.co.uk', 'St Helens WA10 3LF', '01744 345187', '', 'Ian Cunliffe. RAC & AA approved. Makes fun POV content despite small following.'],
  ['S and J Autos LTD', 'IG @sandjautos · sjautoslimited.co.uk', 'Redditch B98 0DP', '0121 817 9225', 'info@sjautosltd.com', 'AWARD WINNERS 3 years running incl. Exceptional Customer Satisfaction. Just moved premises.'],
  ['Autocare MOT & Service Centre', 'IG @autocare_mot · autocarerepairs.co.uk', 'Bethnal Green, London', '', '', 'BMW & Mercedes approved, online booking + WhatsApp. Digitally forward.'],
  ['BVR Automotive', 'FB BVR Automotive · bvrautomotive.co.uk', 'Stoke-on-Trent ST3 1PJ', '01782 599007', 'service@bvrautomotive.co.uk', 'VW/Seat/Skoda/Audi specialist with a van fleet.'],
  ['Transmatic', 'IG @transmatic_ltd', 'Manchester M45 8EH', '', '', '3.2K. Automatic transmission specialists.'],
  ['Star Garage Mansfield', 'FB · stargaragemansfield.co.uk', 'Mansfield Woodhouse NG19 9LF', '01623 904724', 'admin@stargaragemansfield.co.uk', '1.6K, 100% recommend from 68 reviews.'],
  ['Auto Care Centre', 'FB · autocarecentre.net', 'Windsor SL4 5EL', '01753 850539', '', '2.8K.'],
  ['Binley Woods Service Centre', 'FB', 'Coventry CV2 5DB', '024 7654 2202', '', '3.5K. "Warwickshire’s Leading Independent Garage".'],
  ['Castle Vehicle Servicing', 'FB · IG @castlevehicleservicing', 'Northampton NN5 7QP', '01604 961851', '', '526 FB / 644 IG.'],
  ['Peter Motors LTD', 'FB PETER MOTORS (verified)', 'Croydon CR0 3AA', '07841 978386', 'petermotorscroydon@gmail.com', '4.1K.'],
  ['Moorfield German Motors', 'FB', 'Leeds LS19 7BN', '0113 250 8333', '', '2.5K. VW/Audi specialist.'],
  ['AutoTechnik BMW & Mini', 'FB', 'Lutterworth LE17 4HE', '01455 698481', '', '2.2K.'],
  ['Performance Remapping WM', 'FB (runs FB ads)', 'Willenhall WV12 4LF', '0121 798 0697', '', '2.3K. Already spends on marketing.'],
  ['Fast Fit LTD', 'FB', 'Birmingham B6 7HH', '0121 716 2140', '', '1.7K.'],
  ['Morgan Motors', 'FB', 'Carmarthen SA31 1SL', '01267 241745', '', '1.7K. MOT/tyres/sales.'],
  ['J.L Autos', 'FB', 'Tamworth B79 9DJ', '07495 132480', '', '1.8K, 100% recommend.'],
  ['Lynch Lane Car Care', 'FB', 'Weymouth DT4 9DU', '01305 789789', '', '1.5K.'],
  ['SURE Vehicle Centre', 'FB', 'Sunderland SR4 6UA', '07588 728228', '', '1.1K.'],
  ['The Motor Company / Duke St Motors', 'FB', 'Leicester LE3 1UY', '0116 287 0792', '', '955, two sites, 100% recommend.'],
  ['J&P Auto’s', 'FB', 'Cardiff CF11 6NN', '029 2039 6758', '', '626. Trading since 1986.'],
  ['Thetford Tyres Ltd', 'FB', 'Thetford IP24 3HZ', '01473 948049', '', '3.5K. Tyre workshop — Tyresoft fit.'],
  ['Platinum Tyres', 'IG @platinumtyresltd + TikTok', 'Doncaster DN1 3ER', '01302 712718', '', 'MOBILE TYRE 24/7 EMERGENCY — perfect out-of-hours story. Fun content.'],
  ['Knowsley Tyres', 'IG', 'Prescot L34 1NL', '0151 837 0424', '', 'Open 7 days + 24hr mobile callout.'],
  ['Lodge Bank Garage', 'IG @lodgebank', 'Darwen', '', '', '502 followers, 335 posts, good branded templates. "Message to Book".'],
  ['Ultimate Vehicle Servicing', 'FB', 'Peterborough PE3 7PN', '01733 262681', '', '323.'],
  ['Motormech Guildford', 'FB', 'Guildford GU2 7YB', '', '', '346. Bosch accredited.'],
  ['AC Automotive Wiltshire', 'FB (Andy Chell)', 'Melksham SN12 7RE', '07554 383135', '', '412. Mobile + workshop.'],
  ['BM Auto Services', 'IG @bm_auto_services · bmautoservices.co.uk', 'Maidstone, Kent', '07871 860062', '', '240. Mobile mechanic.'],
  ['Alpine Garage & MOT Centre', 'FB', 'Sittingbourne ME10 2JW', '01795 423784', '', '141.'],
  ['Elite Garages Helston', 'FB', 'Helston', '01326 562656', '', 'Part of the Elite Garages CHAIN — multi-site opportunity.'],
  ['Ignition AutoCare', 'TikTok @ignitionautocarecas', 'Castleford', '', '', 'Brand new account, Bosch Car Service.'],
  ['J.P. D’Arcy Car Care & Performance', 'FB · IG @j.p.darcy_garage · jpdarcy.com', 'Little Island, Cork, IRELAND', '+353 87 754 6385', '', '3.6K. BMW/Mercedes, 9 staff, IMI Level 4 hybrid/EV.'],
  ['Pravin Patel', 'FB (GH Community) · harrowservice.co.uk', 'Harrow, London', '', '', 'GH Community + MOT Testers & Managers Open Forum.'],
  ['Ben Thompson', 'FB (GH Community)', 'A1 Autocentre', '', '', 'GH Community + On The Ramp Podcast + MOT Testers.'],
  ['Alex Powell', 'FB', 'Grandstand Auto Services, Hereford', '', '', 'Director.'],
  ['Ryan Ginifer / Joshua Reynolds / Rich Maitland-Price / Stephen Browne / Simon Croft / Paul Emmott', 'FB (GH Community)', 'UK', '', '', 'Garage Hive Community contributors — warm, integration already works.'],
];

const other = [
  ['Equipment4garages', 'IG @equipment4garages (verified), 6,654', 'CHANNEL PARTNER — garage equipment supplier operating nationwide. Their entire audience is garage owners. Exhibits at events.'],
  ['JHM Butt & Company Ltd', 'FB, 5.9K · jhmbuttco.com · Doncaster DN11 8QA', 'CHANNEL PARTNER — garage equipment, established 1971, covers Derbyshire/Manchester/Lincs/Yorkshire/Birmingham.'],
  ['Sara-Mai John — Madre', 'LinkedIn, co-founder', 'AGENCY — "Social media marketing for the automotive aftermarket, £25m+ generated for client brands." Could run this whole creator programme rather than be in it.'],
  ['Dave Clack', 'LinkedIn, RM plc, Wantage', 'HIRING, not a prospect — Automotive Sales & BD, SaaS, 20+ years automotive. #OpenToWork.'],
  ['Tony Mason', 'LinkedIn, Maidstone', 'HIRING — SaaS Sales & Marketing Manager, automotive technology. #OpenToWork.'],
  ['Kevern Thompson', 'LinkedIn, Northampton', 'HIRING — Leadership / data-led business development / mentor-coach. #OpenToWork.'],
];

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const H = [];
const T = [];

H.push('<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1d1a72;max-width:820px">');
H.push('<h1 style="font-size:22px;margin:0 0 4px">Garage social media — partner shortlist &amp; prospect list</h1>');
H.push('<p style="color:#555;margin:0 0 20px">From the 152 screenshots in Documents/Garages social media — about 60 distinct businesses and people once duplicates are stripped out.</p>');
T.push('GARAGE SOCIAL MEDIA — PARTNER SHORTLIST & PROSPECT LIST');
T.push('From the 152 screenshots in Documents/Garages social media — about 60 distinct businesses/people.\n');

H.push('<div style="background:#f4f3ff;border-left:4px solid #3426cf;padding:12px 16px;margin:0 0 24px">');
H.push('<strong>The thing that changes the shortlist:</strong> ReceptionMate’s buyer is a garage owner, so follower count is the wrong sort. An account with 1.4M supercar-enthusiast followers sells nothing; one with 5K followers who are all technicians sells a lot. Everything below is sorted on audience, not size.');
H.push('</div>');
T.push('THE THING THAT CHANGES THE SHORTLIST: ReceptionMate\'s buyer is a garage owner, so follower count is the wrong sort. An account with 1.4M supercar-enthusiast followers sells nothing; one with 5K followers who are all technicians sells a lot. Sorted on audience, not size.\n');

function table(title, blurb, rows, cols) {
  H.push(`<h2 style="font-size:18px;margin:28px 0 4px;border-bottom:2px solid #3426cf;padding-bottom:4px">${esc(title)}</h2>`);
  if (blurb) H.push(`<p style="color:#555;margin:0 0 12px">${blurb}</p>`);
  H.push('<table style="border-collapse:collapse;width:100%;font-size:13.5px">');
  H.push('<tr>' + cols.map((c) => `<th style="text-align:left;background:#efeefb;padding:6px 8px;border:1px solid #ddd;white-space:nowrap">${esc(c)}</th>`).join('') + '</tr>');
  for (const r of rows) {
    H.push('<tr>' + r.map((cell, i) => `<td style="padding:6px 8px;border:1px solid #ddd;vertical-align:top${i === 0 ? ';font-weight:600' : ''}">${esc(cell) || '&mdash;'}</td>`).join('') + '</tr>');
  }
  H.push('</table>');
  T.push('\n== ' + title.toUpperCase() + ' ==');
  if (blurb) T.push(blurb.replace(/<[^>]+>/g, ''));
  for (const r of rows) T.push('- ' + r.filter(Boolean).join(' | '));
}

const COLS = ['Who', 'Handles', 'Reach', 'Where', 'Phone', 'Email', 'Why'];
table('Tier 1 — approach these first', 'Real garage, already posting video weekly, owner on camera, and small enough that free software is genuinely worth something to them. <strong>Krause and AMG are the standouts</strong> — tiny followings, viral reach, and they already make content about the exact problem we solve.', tier1, COLS);
table('Tier 2 — bigger reach, but they will want cash as well', 'Worth approaching, but go in expecting to pay on top of the free subscription.', tier2, COLS);
table('Tier 3 — the one I would push hardest', 'Low follower counts, but their audience <em>is</em> the buyer. Probably the best return per pound of the three tiers.', tier3, COLS);
table('Skip for partnership', 'Big numbers, wrong fit — recorded so we do not revisit them.', skip, ['Who', 'Reach', 'Why not']);
table('Sales prospects', 'Everyone else worth a call. Roughly ordered by how warm they look.', prospects, ['Who', 'Handles / site', 'Where', 'Phone', 'Email', 'Notes']);
table('Three other piles that turned up', '', other, ['Who', 'Where', 'What they actually are']);

H.push('<h2 style="font-size:18px;margin:28px 0 8px;border-bottom:2px solid #3426cf;padding-bottom:4px">Two things worth acting on this week</h2>');
H.push('<p><strong>1. A live sales situation in the Garage Hive Community.</strong> One screenshot is a thread about AI phone answering. Philip Raby says he already uses Steady Bow &ldquo;as a glorified answer service, works really well &mdash; customers love it&rdquo;. Andrew Stetsovsky (Nexa Max Garages, GH all-star contributor) is asking &ldquo;are you happy with the answer quality? Are your customers happy?&rdquo; &mdash; that is a competitor inside our own integration’s community with a warm prospect asking the exact qualifying question. Someone also mentions an &ldquo;AI session at The Blend&rdquo;, which sounds like a speaking or exhibiting slot.</p>');
H.push('<p><strong>2. Three of the LinkedIn profiles are a hiring shortlist, not prospects.</strong> Dave Clack, Tony Mason and Kevern Thompson are all automotive-SaaS salespeople marked #OpenToWork.</p>');
T.push('\n== TWO THINGS WORTH ACTING ON THIS WEEK ==');
T.push('1. Live sales situation in the Garage Hive Community: Philip Raby already uses Steady Bow as "a glorified answer service"; Andrew Stetsovsky (Nexa Max Garages, GH all-star) is asking about answer quality. Competitor inside our own integration\'s community, warm prospect asking the qualifying question. Also a mention of an "AI session at The Blend".');
T.push('2. Dave Clack, Tony Mason and Kevern Thompson are automotive-SaaS salespeople marked #OpenToWork — a hiring shortlist, not prospects.');

H.push('<h2 style="font-size:18px;margin:28px 0 8px;border-bottom:2px solid #3426cf;padding-bottom:4px">Caveats</h2>');
H.push('<ul><li>None of the shortlist are existing customers. VWGS Performance in the portal is <em>VGS Performance</em> in Swindon (01793) &mdash; a different business from VW-Group Specialist in Birmingham (0121).</li>');
H.push('<li>Follower counts come from screenshots taken between June and September 2026, so some will have moved.</li>');
H.push('<li>Phone numbers and emails are only listed where they were visible in the screenshot. Blanks are not dead ends &mdash; most have a website or DM.</li></ul>');
T.push('\n== CAVEATS ==');
T.push('- None of the shortlist are existing customers. VWGS Performance in the portal is VGS Performance, Swindon (01793) — a different business from VW-Group Specialist, Birmingham (0121).');
T.push('- Follower counts are from screenshots taken June–September 2026, so some will have moved.');
T.push('- Contact details only where visible in the screenshot; blanks are not dead ends.');
H.push('</div>');

const html = H.join('\n');
const text = T.join('\n');
const subject = 'Garage social media — partner shortlist & prospect list (60 accounts)';

(async () => {
  const { sendEmail } = await import('../dist/utils/email.js');
  console.log('To:', TO.join(', '));
  console.log('Subject:', subject);
  console.log('Tier1', tier1.length, '| Tier2', tier2.length, '| Tier3', tier3.length, '| Skip', skip.length, '| Prospects', prospects.length, '| Other', other.length);
  if (!SEND) return console.log('\nDry run — pass --send to actually send.');
  const ok = await sendEmail({ to: TO, subject, html, text });
  console.log(ok ? 'SENT' : 'FAILED');
})().catch((e) => { console.error(e); process.exit(1); });
