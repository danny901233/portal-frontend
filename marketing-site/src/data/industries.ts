// Data for the /for/[slug] industry landing pages. Each entry generates a
// static page targeting "AI receptionist for {industry}" search intent.
// Add new industries here; the dynamic route picks them up automatically.
//
// French copy (…Fr fields) powers the /fr/for/[slug] pages. Keep slug + name
// unchanged; those are English-only identifiers.

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

  // ===== French translations (vouvoiement) for the /fr/for/[slug] pages =====
  displayNameFr: string;
  contextFr: string;
  painFr: string;
  highlightsFr: { title: string; body: string }[];
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
    displayNameFr: 'carrosseries',
    contextFr:
      'Vous dirigez une carrosserie spécialisée dans la réparation après sinistre. La plupart des demandes proviennent de conducteurs qui viennent d’avoir un accrochage — ils veulent un devis, une estimation, un créneau et des explications rassurantes, souvent au cours du même appel.',
    painFr:
      'Le téléphone d’une carrosserie sonne à des horaires imprévisibles, les appels sont plus longs à qualifier qu’une simple prise de rendez-vous d’entretien, et un appel manqué signifie généralement perdre la réparation au profit de la carrosserie suivante sur la liste de l’assureur.',
    highlightsFr: [
      {
        title: 'Qualifie les demandes de réparation sans votre estimateur',
        body: 'ReceptionMate recueille l’essentiel — véhicule, zone endommagée, quand et comment cela s’est produit, statut assurance — pour que votre estimateur ne rappelle que les bons dossiers.',
      },
      {
        title: 'Réserve les créneaux d’estimation directement dans votre agenda',
        body: 'Les rendez-vous d’estimation sont enregistrés directement dans Garage Hive ou votre système existant, avec une confirmation par SMS au client avant même qu’il ne raccroche.',
      },
      {
        title: 'Gère proprement les travaux mandatés par les assureurs',
        body: 'Étiquetez les appels par assureur ou donneur d’ordre pour obtenir en un clic le suivi du volume issu de l’assurance.',
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
    displayNameFr: 'centres de contrôle technique',
    contextFr:
      'Vous dirigez un centre de contrôle technique — parfois avec de l’entretien à côté. Votre téléphone est le plus sollicité au moment où vos clients reçoivent leur rappel d’échéance de contrôle technique.',
    painFr:
      'La saison du contrôle technique sature les lignes. Votre équipe est dans les baies. Chaque appel manqué représente une réservation de 45 à 100 £ qui finit chez un garage concurrent au bout de la rue.',
    highlightsFr: [
      {
        title: 'Consulte l’historique de contrôle technique en direct pendant l’appel',
        body: 'Le client donne l’immatriculation, ReceptionMate confirme la date d’expiration du contrôle technique et propose le prochain créneau conforme — fini les « je vérifie et je vous rappelle ».',
      },
      {
        title: 'Établit avec précision le tarif combiné contrôle technique + contre-visite',
        body: 'ReceptionMate lit votre grille tarifaire et annonce le bon coût combiné sans mobiliser votre équipe au téléphone.',
      },
      {
        title: 'Distingue les rappels « est-ce prêt ? » des nouvelles réservations',
        body: 'Les clients existants qui suivent une intervention obtiennent la bonne information ; les nouvelles réservations arrivent dans l’agenda. Deux tâches différentes, un seul agent.',
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
    displayNameFr: 'centres pneumatiques',
    contextFr:
      'Vous dirigez un centre de montage de pneus — parfois avec géométrie, freinage et contrôle technique à côté. Une grande partie de vos appels consistent à établir un devis puis à monter les pneus le jour même.',
    painFr:
      'Les clients qui appellent pour des pneus font le tour des garages pour trouver le meilleur prix sur le modèle qu’il leur faut, aujourd’hui. Si votre ligne est occupée, ils appellent le centre suivant. Et votre équipe est en plein montage quand l’appel arrive.',
    highlightsFr: [
      {
        title: 'Établit les prix des pneus à partir du stock Tyresoft en direct',
        body: 'Le client donne la dimension ou le véhicule, ReceptionMate annonce le bon pneu, la marque et le prix — directement depuis votre inventaire Tyresoft en temps réel.',
      },
      {
        title: 'Réserve des montages le jour même avec des horaires réalistes',
        body: 'ReceptionMate lit l’agenda de l’atelier et propose des créneaux réellement disponibles — pas des promesses de « on vous case » qui ne tiennent pas.',
      },
      {
        title: 'Enregistre chaque devis, même quand le client ne réserve pas',
        body: 'Les demandes de devis non abouties arrivent dans le portail sous forme de prospects — votre équipe peut rappeler les clients qui ont comparé sans se décider.',
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
    displayNameFr: 'groupes multi-sites',
    contextFr:
      'Vous dirigez un groupe de deux garages ou centres de service ou plus — une chaîne régionale, un opérateur multimarque ou un petit réseau national.',
    painFr:
      'Le volume d’appels entrants augmente avec le nombre d’agences, mais pas la capacité de votre réception centrale. Le suivi des appels manqués et du taux de conversion à l’échelle du groupe est au mieux approximatif.',
    highlightsFr: [
      {
        title: 'Routage intelligent entre les agences',
        body: 'ReceptionMate choisit la bonne agence en fonction de la localisation, du service demandé ou de la préférence du client — et y dirige la réservation.',
      },
      {
        title: 'Tableaux de bord de groupe prêts à l’emploi',
        body: 'Appels traités, réservations enregistrées, chiffre d’affaires gagné — consolidés par agence et sur l’ensemble du groupe. Sans tableurs.',
      },
      {
        title: 'Transferts vers une agence à la demande du client',
        body: 'Un client qui cherche un site précis par son nom y est orienté proprement, la réservation étant inscrite dans l’agenda de ce site.',
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
    displayNameFr: 'spécialistes des véhicules électriques',
    contextFr:
      'Vous intervenez sur des véhicules électriques — que vous soyez un spécialiste exclusivement VE ou un garage généraliste dont le volume de VE ne cesse de croître.',
    painFr:
      'Les demandes liées aux VE sont techniques : problèmes de recharge, santé de la batterie, mises à jour logicielles, gestion des véhicules lourds. Les réceptionnistes IA génériques trébuchent sur le vocabulaire ; les services humains ne font pas la différence entre un diagnostic OBD et un contrôle d’isolation haute tension.',
    highlightsFr: [
      {
        title: 'Entraîné au vocabulaire propre aux VE',
        body: 'BMS, freinage régénératif, recharge rapide en courant continu, architecture 400 V ou 800 V, mises à jour OTA — ReceptionMate maîtrise ce langage sans écorcher un terme sur deux.',
      },
      {
        title: 'Sait quelles interventions nécessitent des techniciens formés aux VE',
        body: 'ReceptionMate dirige les appels vers la disponibilité du bon technicien et ne réserve un rendez-vous que lorsqu’une baie qualifiée VE est libre.',
      },
      {
        title: 'Enregistre proprement les demandes liées à la recharge des VE',
        body: 'Installation de bornes à domicile, problèmes de bornes publiques, inquiétudes sur l’autonomie — le tout catégorisé et acheminé vers le bon service de votre entreprise.',
      },
    ],
  },
];
