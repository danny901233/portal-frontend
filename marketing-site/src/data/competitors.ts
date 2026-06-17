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
  },
];
