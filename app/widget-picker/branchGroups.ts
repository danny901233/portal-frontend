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
};
