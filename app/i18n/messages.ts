// Portal i18n dictionary. Client-side, cookie/localStorage-driven (no URL
// changes) — the language toggle updates a React context and every component
// using useT() re-renders. Keys are grouped by area; resolve with dot paths
// e.g. t('nav.dashboard'). Add French for every English key.

export type Locale = 'en' | 'fr';
export const LOCALES: Locale[] = ['en', 'fr'];
export const LOCALE_STORAGE_KEY = 'rm-locale';

export const messages = {
  en: {
    nav: {
      dashboard: 'Dashboard',
      calls: 'Calls',
      messages: 'Messages',
      outbound: 'Outbound',
      templates: 'Templates',
      agentConfigurations: 'Agent Configurations',
      team: 'Team',
      integrations: 'Integrations',
      observability: 'Observability',
      billing: 'Billing',
      admin: 'Admin',
      helpGuides: 'Help & Guides',
      setup: 'Setup',
      more: 'More',
    },
    navbar: {
      branch: 'Branch',
      searchBranches: 'Search branches by name or ID...',
      allBranches: 'All branches',
      garageId: 'Garage ID',
      signedIn: 'Signed in',
      signOut: 'Sign out',
      yourNumber: 'Your number',
    },
    sidebar: {
      yourNumber: 'Your ReceptionMate number',
      notAssigned: 'Not assigned yet',
      support: 'Support chat',
    },
    common: {
      save: 'Save',
      saving: 'Saving…',
      cancel: 'Cancel',
      loading: 'Loading…',
      close: 'Close',
      language: 'Language',
    },
  },
  fr: {
    nav: {
      dashboard: 'Tableau de bord',
      calls: 'Appels',
      messages: 'Messages',
      outbound: 'Sortant',
      templates: 'Modèles',
      agentConfigurations: 'Configurations de l’agent',
      team: 'Équipe',
      integrations: 'Intégrations',
      observability: 'Observabilité',
      billing: 'Facturation',
      admin: 'Admin',
      helpGuides: 'Aide & Guides',
      setup: 'Config',
      more: 'Plus',
    },
    navbar: {
      branch: 'Établissement',
      searchBranches: 'Rechercher un établissement par nom ou ID...',
      allBranches: 'Tous les établissements',
      garageId: 'ID du garage',
      signedIn: 'Connecté',
      signOut: 'Se déconnecter',
      yourNumber: 'Votre numéro',
    },
    sidebar: {
      yourNumber: 'Votre numéro ReceptionMate',
      notAssigned: 'Pas encore attribué',
      support: 'Chat d’assistance',
    },
    common: {
      save: 'Enregistrer',
      saving: 'Enregistrement…',
      cancel: 'Annuler',
      loading: 'Chargement…',
      close: 'Fermer',
      language: 'Langue',
    },
  },
} as const;
