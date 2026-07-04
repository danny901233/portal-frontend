// Data for the /alternatives/[slug] comparison pages. Each competitor here
// generates a static page at /alternatives/<slug> targeting
// "<name> alternative" search intent.
//
// Be careful with claims: we lead with positioning ("AI vs human service")
// rather than specific pricing/feature digs that could be wrong or change.
// Anything written here should be true today AND defensible if challenged.

export type CompetitorCategory = 'human-service' | 'generic-ai';

export interface Competitor {
  slug: string;
  name: string;
  category: CompetitorCategory;
  // Used in the SEO title and H1: "ReceptionMate vs {name}"
  // and "Looking for a {name} alternative?"
  // Display name only — never inferred for legal text.
  displayName: string;
  // Short objective description of what they do — no jabs, just facts.
  oneLiner: string;
  // Lead with this — the real reason a garage owner is searching for an
  // alternative. Should match the search intent ("they're expensive",
  // "they don't know cars", etc.).
  whyConsiderAlternative: string;
  // French translations (professional, vouvoiement) for the /fr pages.
  oneLinerFr: string;
  whyConsiderAlternativeFr: string;
}

export const COMPETITORS: Competitor[] = [
  {
    slug: 'moneypenny',
    name: 'Moneypenny',
    displayName: 'Moneypenny',
    category: 'human-service',
    oneLiner:
      'UK-based human answering service founded in 2000, serving thousands of small businesses across multiple industries.',
    whyConsiderAlternative:
      'Moneypenny\'s receptionists are skilled, but they\'re generalists — answering for solicitors, dentists, accountants and garages with the same training. They take messages reliably, but they can\'t take a booking into Garage Hive, quote an MOT price, or read back a customer\'s service history while the caller is on the line.',
    oneLinerFr:
      'Service de télésecrétariat humain basé au Royaume-Uni, fondé en 2000, au service de milliers de petites entreprises dans de nombreux secteurs.',
    whyConsiderAlternativeFr:
      'Les réceptionnistes de Moneypenny sont compétentes, mais ce sont des généralistes — elles répondent pour des avocats, des dentistes, des comptables et des garages avec la même formation. Elles prennent les messages de façon fiable, mais elles ne peuvent pas enregistrer une réservation dans Garage Hive, chiffrer un contrôle technique, ni relire l\'historique d\'entretien d\'un client pendant que l\'appelant est en ligne.',
  },
  {
    slug: 'answerconnect',
    name: 'AnswerConnect',
    displayName: 'AnswerConnect',
    category: 'human-service',
    oneLiner:
      'Live-receptionist answering service serving small and mid-sized businesses across the UK and US.',
    whyConsiderAlternative:
      'AnswerConnect\'s human agents are reliable for message-taking, but they have no automotive specialism. A garage owner pays a premium for a UK voice that has to ask the customer to spell every reg plate, can\'t price an MOT, and can\'t see your diary in real time.',
    oneLinerFr:
      'Service de télésecrétariat avec réceptionnistes en direct, au service des petites et moyennes entreprises au Royaume-Uni et aux États-Unis.',
    whyConsiderAlternativeFr:
      'Les agents humains d\'AnswerConnect sont fiables pour la prise de messages, mais ils n\'ont aucune spécialisation automobile. Un garagiste paie un supplément pour une voix britannique qui doit demander au client d\'épeler chaque plaque d\'immatriculation, ne peut pas chiffrer un contrôle technique et ne voit pas votre planning en temps réel.',
  },
  {
    slug: 'ruby-receptionists',
    name: 'Ruby Receptionists',
    displayName: 'Ruby Receptionists',
    category: 'human-service',
    oneLiner:
      'US-headquartered virtual receptionist service that recently expanded into UK markets.',
    whyConsiderAlternative:
      'Ruby\'s agents are warm and well-trained — for American businesses. UK garages who try them quickly hit the wall: agents who don\'t know what a "cambelt" is, no integration with UK garage management systems, and pricing built around US working hours.',
    oneLinerFr:
      'Service de réceptionnistes virtuelles dont le siège est aux États-Unis, récemment étendu aux marchés britanniques.',
    whyConsiderAlternativeFr:
      'Les agents de Ruby sont chaleureux et bien formés — pour les entreprises américaines. Les garages britanniques qui les essaient se heurtent vite au mur : des agents qui ne savent pas ce qu\'est une « courroie de distribution », aucune intégration avec les systèmes de gestion de garage britanniques, et une tarification calquée sur les horaires de travail américains.',
  },
  {
    slug: 'alldaypa',
    name: 'AllDayPA',
    displayName: 'AllDayPA',
    category: 'human-service',
    oneLiner:
      'UK 24/7 telephone answering service supporting businesses across professional services, retail and trade.',
    whyConsiderAlternative:
      'AllDayPA delivers human coverage out-of-hours, but their model is built around generic message-taking and call-routing. The agent answering at 11pm has never seen your service menu and can\'t book a job — they leave you a voicemail-equivalent to action the next morning.',
    oneLinerFr:
      'Service de télésecrétariat téléphonique britannique disponible 24h/24 et 7j/7, au service d\'entreprises dans les services professionnels, le commerce de détail et l\'artisanat.',
    whyConsiderAlternativeFr:
      'AllDayPA assure une présence humaine en dehors des heures d\'ouverture, mais leur modèle repose sur la prise de messages et le routage d\'appels génériques. L\'agent qui répond à 23h n\'a jamais vu votre catalogue de prestations et ne peut pas enregistrer une intervention — il vous laisse l\'équivalent d\'un message vocal à traiter le lendemain matin.',
  },
  {
    slug: 'jodie',
    name: 'Jodie',
    displayName: 'Jodie',
    category: 'generic-ai',
    oneLiner:
      'AI receptionist platform marketing itself to small businesses across multiple industries including salons, dentists, professional services and garages.',
    whyConsiderAlternative:
      'Jodie is a horizontal product — the same agent answers for nail salons, dentists and law firms, with a "garage" preset bolted on. It can take a message and read a script, but it doesn\'t know UK MOT cycles, can\'t handle the way British customers phrase a reg plate, and doesn\'t integrate with Garage Hive or Tyresoft.',
    oneLinerFr:
      'Plateforme de réceptionniste IA qui se destine aux petites entreprises de nombreux secteurs, dont les salons de coiffure, les cabinets dentaires, les services professionnels et les garages.',
    whyConsiderAlternativeFr:
      'Jodie est un produit horizontal — le même agent répond pour des salons de manucure, des dentistes et des cabinets d\'avocats, avec un préréglage « garage » ajouté par-dessus. Il peut prendre un message et lire un script, mais il ne connaît pas les cycles de contrôle technique britanniques, ne gère pas la façon dont les clients britanniques énoncent une plaque d\'immatriculation, et ne s\'intègre ni à Garage Hive ni à Tyresoft.',
  },
  {
    slug: 'smith-ai',
    name: 'Smith.ai',
    displayName: 'Smith.ai',
    category: 'generic-ai',
    oneLiner:
      'US-headquartered AI-plus-human receptionist platform serving legal, real estate and small-business markets.',
    whyConsiderAlternative:
      'Smith.ai is built for North American professional services — lawyers, dentists, agencies. UK garages get a US-trained agent that mispronounces town names, doesn\'t understand "interim" or "MOT advisories", and bills in US dollars on a per-minute model designed for high-value calls, not workshop volume.',
    oneLinerFr:
      'Plateforme de réceptionniste alliant IA et humains, dont le siège est aux États-Unis, au service des secteurs juridique, immobilier et des petites entreprises.',
    whyConsiderAlternativeFr:
      'Smith.ai est conçu pour les services professionnels nord-américains — avocats, dentistes, agences. Les garages britanniques héritent d\'un agent formé aux États-Unis qui écorche les noms de villes, ne comprend pas « interim » ni les « points de contrôle technique », et facture en dollars américains selon un modèle à la minute pensé pour des appels à forte valeur, pas pour le volume d\'un atelier.',
  },
];
