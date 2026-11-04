// Config for multi-branch garages that share one website and need a "which branch?"
// landing page instead of a single /widget/{garageId} embed directly. To reuse this
// picker for the next multi-branch garage that signs up, add a new entry here keyed
// by a URL slug -- no new page or component needed, just a deploy.
export type PickerBranch = {
  garageId: string;
  // Shown immediately and if the live /api/widget/{garageId} fetch fails; overridden by
  // that branch's actual configured name once the fetch succeeds.
  fallbackName: string;
  address?: string;
};

export type BranchGroup = {
  branches: PickerBranch[];
  // One WhatsApp number shared by every branch, in wa.me digits (44..., no plus). When set,
  // picking WhatsApp opens that chat straight away instead of asking which branch — there is
  // nothing to choose. Without it each branch's own number from /api/widget is used, which for
  // a branch with no WhatsApp connection falls back to its landline, i.e. a dead wa.me link.
  whatsappNumber?: string;
};

export const BRANCH_GROUPS: Record<string, BranchGroup> = {
  'lp-autos': {
    branches: [
      { garageId: '8d2ee5e6-56c9-4a9c-ad49-38bfecae6906', fallbackName: 'LP Autos MOT' },
      {
        garageId: '73781b1a-8a6e-47e3-bde1-7c7c4b0223d3',
        fallbackName: 'L P Autos Ltd',
        address: 'Unit 5 Greenhalgh St, Failsworth, Manchester M35 0BW',
      },
    ],
  },
  'the-gearbox-centre': {
    // Same WhatsApp number for all five branches (0333 038 6043); only Kent has it connected
    // in the portal, so the per-branch numbers would be wrong for the other four.
    whatsappNumber: '443330386043',
    branches: [
      {
        garageId: 'ef085f7f-ff1a-41be-9f87-e77ba99a5639',
        fallbackName: 'The Gearbox Centre (Bournemouth)',
        address: '39a Southcote Rd, Bournemouth BH1 3SH',
      },
      {
        garageId: '8845b7ca-4807-467d-bc83-32d34b27b336',
        fallbackName: 'The Gearbox Centre (Essex)',
        address: '22 Davey Cl, Colchester CO1 2XL',
      },
      {
        garageId: '78697a53-915f-4773-a6ee-08703eefdfb9',
        fallbackName: 'The Gearbox Centre (Kent)',
        address: 'Unit 1, 8 John Hall Cl, Faversham ME13 7TY',
      },
      {
        garageId: 'f1fae5ce-3315-4b1d-8d58-c90fa56b692c',
        fallbackName: 'The Gearbox Centre (Surrey)',
        address: 'Capons Yard, Techno Park, Egham TW20 8RN',
      },
      {
        garageId: '775c87f0-3e87-49bb-9859-30e71579cc3b',
        fallbackName: 'The Gearbox Centre (Torquay)',
        address: '21-27 Alexandra Ln, Torquay TQ1 1JD',
      },
    ],
  },
};
