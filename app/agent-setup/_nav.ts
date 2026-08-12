export interface AgentSetupNavItem {
  href: string;
  label: string;
  description: string;
  staffOnly?: boolean;
  // Only shown to garages that have the messaging (chat) product. The layout
  // resolves access via /internal-api/garages/:id/messaging-access.
  messagingOnly?: boolean;
}

/**
 * Shared nav for /agent-setup. Used by both:
 *   - the left rail inside the agent-setup layout
 *   - the hover-flyout tray on the main app sidebar's "Agent Configurations" item
 *
 * Merged structure per Gabriel 2026-06-15. The unmerged sub-routes (/greeting,
 * /faqs, /transfers, /pronunciations, /identity-voice, /smart-questions) still
 * serve directly for any old links/bookmarks — they're just not in this nav.
 */
export const AGENT_SETUP_NAV: AgentSetupNavItem[] = [
  { href: '/agent-setup/company-information', label: 'Company information', description: 'Branch name, contact, address' },
  { href: '/agent-setup/opening-hours',       label: 'Opening hours',       description: 'When the agent answers' },
  { href: '/agent-setup/voice',               label: 'Identity, voice & greeting', description: 'How the agent sounds + first line + pronunciations' },
  { href: '/agent-setup/questions',           label: 'Smart questions & F&Qs',     description: 'What to ask + common Q&A' },
  { href: '/agent-setup/rules',               label: 'Rules',               description: 'Custom rules the agent must follow' },
  { href: '/agent-setup/bookings-transfers',  label: 'Bookings & transfers', description: 'Booking behavior + where to send calls' },
  { href: '/agent-setup/messaging',           label: 'Messaging',           description: 'Chat agent behaviour + human handover', messagingOnly: true },
  { href: '/agent-setup/training',            label: 'Training',            description: 'Teach the agent about you' },
  { href: '/agent-setup/notifications',       label: 'Notifications',       description: 'Who gets emailed after a call' },
  { href: '/agent-setup/integrations',        label: 'Integrations',        description: 'HubSpot' },
  { href: '/agent-setup/routing',             label: 'Routing',             description: 'Agent assignment', staffOnly: true },
];
