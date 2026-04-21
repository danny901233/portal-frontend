'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import Sidebar from './Sidebar';
import Navbar from './Navbar';
import SetupWizard from './SetupWizard';
import {
  ALL_ASSIGNED_BRANCHES_IDENTIFIER,
  BranchScopeProvider,
  type BranchScope,
} from '../lib/branchScope';
import {
  clearSession,
  getGarageId,
  getGarages,
  getSessionToken,
  getUserBranchRoles,
  getUserEmail,
  getUserId,
  isAdmin,
  isManager,
  isReceptionMateStaff,
  setGarageId,
  setGarages,
} from '../lib/auth';
import { fetchGarages } from '../lib/api';
import { fetchOnboardingStatus } from '../lib/onboarding';
import type { GarageSummary } from '../types';

const publicPaths = new Set(['/login', '/reset-password', '/terms']);
const paymentPaths = new Set(['/setup-payment', '/setup-payment/callback']);

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [isReady, setIsReady] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userId, setUserIdState] = useState<string | null>(null);
  const [garageId, setGarageIdState] = useState<string | null>(null);
  const [garages, setGaragesState] = useState<GarageSummary[]>([]);
  const [isStaffUser, setIsStaffUser] = useState(false);
  const [isAdminUser, setIsAdminUser] = useState(false);
  const [branchScope, setBranchScope] = useState<BranchScope>('single');
  const [hasMessagingAccess, setHasMessagingAccess] = useState(false);
  const [messagesNeedingAttention, setMessagesNeedingAttention] = useState(0);
  const [conversationsNeedingAttention, setConversationsNeedingAttention] = useState(0);
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);
  const [wizardAgentType, setWizardAgentType] = useState<'assist' | 'automate'>('assist');
  const branchRoles = useMemo(() => getUserBranchRoles(), []);
  const managedGarageIds = useMemo(
    () =>
      Object.entries(branchRoles)
        .filter(([, role]) => role === 'MANAGER')
        .map(([garageId]) => garageId),
    [branchRoles],
  );
  const managedGarageIdSet = useMemo(() => new Set(managedGarageIds), [managedGarageIds]);
  const restrictToAssignedBranches = useMemo(
    () => !isStaffUser && !isAdminUser && managedGarageIds.length > 0,
    [isAdminUser, isStaffUser, managedGarageIds.length],
  );
  const visibleGarages = useMemo(() => {
    if (!restrictToAssignedBranches) {
      return garages;
    }
    return garages.filter((garage) => managedGarageIdSet.has(garage.id));
  }, [garages, managedGarageIdSet, restrictToAssignedBranches]);
  const visibleGarageIds = useMemo(() => visibleGarages.map((garage) => garage.id), [visibleGarages]);
  const allowAllAssignedBranches = useMemo(
    () => pathname === '/dashboard' && visibleGarageIds.length > 1,
    [pathname, visibleGarageIds.length],
  );

  const shouldShowChrome = useMemo(() => !publicPaths.has(pathname ?? '') && !paymentPaths.has(pathname ?? ''), [pathname]);

  useEffect(() => {
    if (!allowAllAssignedBranches && branchScope === 'all') {
      setBranchScope('single');
    }
  }, [allowAllAssignedBranches, branchScope]);

  const branchScopeValue = useMemo(
    () => ({
      scope: branchScope,
      setBranchScope,
      managedGarageIds,
      allowAllAssignedOption: allowAllAssignedBranches,
      selectedGarageId: garageId,
      assignedGarageIds: visibleGarageIds,
    }),
    [allowAllAssignedBranches, branchScope, garageId, managedGarageIds, visibleGarageIds],
  );

  const selectedGarageValue = branchScope === 'all' ? ALL_ASSIGNED_BRANCHES_IDENTIFIER : garageId ?? '';

  const handleSelectGarage = (nextGarageId: string) => {
    if (nextGarageId === ALL_ASSIGNED_BRANCHES_IDENTIFIER) {
      setBranchScope('all');
      return;
    }

    setBranchScope('single');
    setGarageId(nextGarageId);
    setGarageIdState(nextGarageId);
    router.refresh();
  };

  const bootstrapSession = useCallback(async () => {
    const token = getSessionToken();
    const storedGarageId = getGarageId();
    const storedGarages = getGarages();
    const email = getUserEmail();
    const id = getUserId();

    // Payment pages only need token, not garage
    const isPaymentPage = paymentPaths.has(pathname ?? '');

    if (!token || (!storedGarageId && !isPaymentPage)) {
      clearSession();
      router.replace('/login');
      return;
    }

    // Payment pages can proceed with just token
    if (isPaymentPage && token) {
      setIsReady(true);
      return;
    }

    setUserEmail(email);
    setUserIdState(id);
    setGarageIdState(storedGarageId);
    setIsStaffUser(isReceptionMateStaff());
    setIsAdminUser(isManager());

    if (storedGarages.length > 0) {
      setGaragesState(storedGarages);
      if (!storedGarages.some((garage) => garage.id === storedGarageId)) {
        const fallbackId = storedGarages[0]?.id;
        if (fallbackId) {
          setGarageId(fallbackId);
          setGarageIdState(fallbackId);
        }
      }
      setIsReady(true);
      return;
    }

    try {
      const response = await fetchGarages();
      const list = response.garages ?? [];
      setGaragesState(list);
      setGarages(list);

      if (list.length > 0 && !list.some((garage) => garage.id === storedGarageId)) {
        const fallbackId = list[0]?.id;
        if (fallbackId) {
          setGarageId(fallbackId);
          setGarageIdState(fallbackId);
        }
      }
    } catch (error: unknown) {
      const status = typeof error === 'object' && error && 'response' in error
        ? (error as { response?: { status?: number } }).response?.status
        : undefined;
      if (status === 401) {
        clearSession();
        setUserIdState(null);
        router.replace('/login');
        return;
      }
      // eslint-disable-next-line no-console
      console.error('Failed to fetch garages', error);
    } finally {
      setIsReady(true);
    }
  }, [pathname, router]);

  useEffect(() => {
    if (!shouldShowChrome) {
      setIsReady(true);
      return;
    }

    void bootstrapSession();
  }, [bootstrapSession, shouldShowChrome]);

  // Check if setup wizard should be shown
  useEffect(() => {
    const checkSetupWizard = async () => {
      if (!shouldShowChrome || !isReady || !garageId) {
        return;
      }

      // Check if triggered by ?showSetup=true query param using window.location
      const showSetup = typeof window !== 'undefined' &&
        new URLSearchParams(window.location.search).get('showSetup') === 'true';

      try {
        const status = await fetchOnboardingStatus();
        if (status.needsSetup || showSetup) {
          setWizardAgentType(status.agentType);
          setSetupWizardOpen(true);
          // Clear query param if present
          if (showSetup && pathname) {
            router.replace(pathname);
          }
        }
      } catch (error) {
        console.error('Failed to check onboarding status:', error);
      }
    };

    void checkSetupWizard();
  }, [shouldShowChrome, isReady, garageId, pathname, router]);

  useEffect(() => {
    if (!restrictToAssignedBranches) {
      return;
    }
    if (!visibleGarages.length) {
      return;
    }
    if (garageId && visibleGarages.some((garage) => garage.id === garageId)) {
      return;
    }
    const fallbackGarage = visibleGarages[0];
    if (fallbackGarage) {
      setGarageId(fallbackGarage.id);
      setGarageIdState(fallbackGarage.id);
      router.refresh();
    }
  }, [garageId, restrictToAssignedBranches, router, visibleGarages]);

  useEffect(() => {
    const fetchMessagingData = async () => {
      if (!garageId) {
        console.log('[MESSAGING] No garageId, setting access to false');
        setHasMessagingAccess(false);
        setMessagesNeedingAttention(0);
        return;
      }

      try {
        const token = getSessionToken();
        console.log('[MESSAGING] Fetching access for garage:', garageId);

        // Fetch messaging access
        const accessResponse = await fetch(
          `/internal-api/garages/${garageId}/messaging-access`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        console.log('[MESSAGING] Response status:', accessResponse.status);

        if (accessResponse.ok) {
          const accessData = await accessResponse.json();
          console.log('[MESSAGING] Access data:', accessData);
          const hasAccess = accessData.hasMessagingAccess || false;
          console.log('[MESSAGING] Setting hasMessagingAccess to:', hasAccess);
          setHasMessagingAccess(hasAccess);

          // If has access, fetch needs attention count
          if (hasAccess) {
            const statsResponse = await fetch(
              `/internal-api/garages/${garageId}/messages/needs-attention-count`,
              {
                headers: {
                  Authorization: `Bearer ${token}`,
                },
              }
            );

            if (statsResponse.ok) {
              const statsData = await statsResponse.json();
              setMessagesNeedingAttention(statsData.count || 0);
            }
          } else {
            setMessagesNeedingAttention(0);
          }
        } else {
          console.log('[MESSAGING] Response not OK, setting access to false');
          setHasMessagingAccess(false);
          setMessagesNeedingAttention(0);
        }

        // Fetch conversations needing attention (for managers and staff)
        try {
          const convParams = new URLSearchParams();
          if (!isReceptionMateStaff()) {
            if (garageId) convParams.set('garageId', garageId);
          }
          const convResponse = await fetch(
            `/internal-api/conversations?${convParams.toString()}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (convResponse.ok) {
            const convData = await convResponse.json() as { conversations: { needsAttention: boolean }[] };
            const count = (convData.conversations ?? []).filter(c => c.needsAttention).length;
            setConversationsNeedingAttention(count);
          }
        } catch (convErr) {
          console.error('[CONVERSATIONS] Error fetching count:', convErr);
        }
      } catch (error) {
        console.error('[MESSAGING] Error fetching messaging data:', error);
        setHasMessagingAccess(false);
        setMessagesNeedingAttention(0);
      }
    };

    void fetchMessagingData();

    // Poll for updates every 30 seconds
    const interval = setInterval(fetchMessagingData, 30000);
    return () => clearInterval(interval);
  }, [garageId]);

  const shellContent = !shouldShowChrome ? (
    <>{children}</>
  ) : !isReady ? (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-100">
      <div className="space-y-2 text-center">
        <div className="text-xl font-semibold">Loading ReceptionMate…</div>
        <div className="text-sm text-slate-400">Preparing your dashboard</div>
      </div>
    </div>
  ) : (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <Sidebar
        activePath={pathname ?? '/calls'}
        showAdminLink={isStaffUser}
        hasMessagingAccess={hasMessagingAccess}
        hasManagerAccess={managedGarageIds.length > 0}
        isManagerUser={isStaffUser || isAdminUser}
        messagesNeedingAttention={messagesNeedingAttention}
      />
      <div className="flex flex-1 flex-col">
        <Navbar
          email={userEmail ?? 'Unknown user'}
          userId={userId}
          garages={visibleGarages}
          selectedGarageId={selectedGarageValue}
          allowAllAssignedBranches={allowAllAssignedBranches}
          onSelectGarage={handleSelectGarage}
          onLogout={() => {
            clearSession();
            setIsStaffUser(false);
            setUserIdState(null);
            router.replace('/login');
          }}
        />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );

  return (
    <BranchScopeProvider value={branchScopeValue}>
      {shellContent}
      <SetupWizard
        isOpen={setupWizardOpen}
        garageId={garageId || ''}
        agentType={wizardAgentType}
        onComplete={() => {
          setSetupWizardOpen(false);
          // Optionally refresh the page
          router.refresh();
        }}
      />
    </BranchScopeProvider>
  );
}
