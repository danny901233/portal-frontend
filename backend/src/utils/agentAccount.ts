/**
 * Which LiveKit Cloud account a given agentScript lives on.
 *
 * Passed to the onboarding-service's /provision + /update-agent endpoints
 * so the SIP trunk + dispatch rule get created on the CORRECT tenant.
 *
 * Historical context (2026-07-29):
 * Before this helper existed, every portal→onboarding-service call omitted
 * the `account` param, so the service defaulted to 'account1'. That silently
 * misrouted Assist-agent + GarageHive-agent trunks to the wrong tenant
 * (they live on Account 2, receptionmate-9dznd24r). Production Assist
 * garages worked only because they were manually migrated to Account 2
 * once in June; every new Assist garage onboarded via Quick Onboard since
 * then landed on the wrong account and had to be hand-fixed to enable
 * voice. This helper closes that gap.
 *
 * Bookar (bookar-agent) and MMH (MMH-agent) live on their own dedicated
 * LiveKit projects that the onboarding-service does NOT manage — those
 * scripts are skipped entirely before this helper is called (see the
 * MMH/Bookar skip blocks in config.ts). If either sneaks through, we
 * default to account1 as a safe fallback (creates a stray-but-harmless
 * trunk on Account 1 instead of throwing).
 */
export type LiveKitAccount = 'account1' | 'account2';

export function accountForAgentScript(agentScript: string | null | undefined): LiveKitAccount {
  if (agentScript === 'Assist-agent' || agentScript === 'GarageHive-agent') {
    return 'account2';
  }
  return 'account1';
}
