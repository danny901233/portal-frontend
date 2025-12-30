'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { isReceptionMateStaff } from '../lib/auth';
import {
  activateGarage,
  createAdminBranch,
  createAdminBusiness,
  createAdminUser,
  deleteAdminBranch,
  deleteAdminUser,
  fetchAdminBusinesses,
  fetchAdminUsers,
  updateGarageTwilioNumber,
  updateAdminUser,
} from '../lib/admin';
import type { AdminUser, UserRole } from '../types';

type ActivationFeedback = { message: string; tone: 'success' | 'error' };

export default function AdminPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [businessName, setBusinessName] = useState('');
  const [businessMessage, setBusinessMessage] = useState('');
  const [branchName, setBranchName] = useState('');
  const [branchMessage, setBranchMessage] = useState('');
  const [businessSearch, setBusinessSearch] = useState('');
  const [branchSearch, setBranchSearch] = useState('');
  const [userSearch, setUserSearch] = useState('');
  type ContactInfo = { name: string; email: string; phone: string; role: string };
  const [contactDetails, setContactDetails] = useState<Record<string, ContactInfo>>({});
  const [businessContactForm, setBusinessContactForm] = useState<ContactInfo>({
    name: '',
    email: '',
    phone: '',
    role: '',
  });
  const [assignmentTarget, setAssignmentTarget] = useState<Record<string, string>>({});
  const [unassignmentTarget, setUnassignmentTarget] = useState<Record<string, string>>({});
  const [selectedBusinessId, setSelectedBusinessId] = useState<string | null>(null);
  const [isBranchFormVisible, setIsBranchFormVisible] = useState(false);
  const [userForm, setUserForm] = useState({
    email: '',
    password: '',
    confirmPassword: '',
    role: 'USER' as UserRole,
    garageIds: [] as string[],
  });
  const [userMessage, setUserMessage] = useState('');
  const [activationFeedback, setActivationFeedback] = useState<Record<string, ActivationFeedback>>({});
  const [twilioDrafts, setTwilioDrafts] = useState<Record<string, string>>({});

  const adminStatus = useMemo(() => isReceptionMateStaff(), []);

  useEffect(() => {
    if (!adminStatus) {
      router.replace('/calls');
    }
  }, [adminStatus, router]);

  const businessesQuery = useQuery({
    queryKey: ['adminBusinesses'],
    queryFn: fetchAdminBusinesses,
    enabled: adminStatus,
  });
  const usersQuery = useQuery({
    queryKey: ['adminUsers'],
    queryFn: fetchAdminUsers,
    enabled: adminStatus,
  });

  const users = usersQuery.data?.users ?? [];

  const businesses = businessesQuery.data?.businesses ?? [];
  const selectedBusiness = businesses.find((business) => business.id === selectedBusinessId) ?? null;
  const branches = selectedBusiness?.branches ?? [];

  useEffect(() => {
    setTwilioDrafts((prev) => {
      const next: Record<string, string> = {};
      let changed = false;

      branches.forEach((branch) => {
        const value = prev[branch.id] ?? branch.twilioNumber ?? '';
        next[branch.id] = value;
        if (!changed && value !== prev[branch.id]) {
          changed = true;
        }
      });

      const prevKeys = Object.keys(prev);
      if (!changed && prevKeys.length !== branches.length) {
        changed = true;
      } else if (!changed) {
        for (const key of prevKeys) {
          if (!(key in next)) {
            changed = true;
            break;
          }
        }
      }

      return changed ? next : prev;
    });
  }, [branches]);

  useEffect(() => {
    if (!adminStatus) {
      return;
    }

    if (selectedBusinessId && !businesses.some((business) => business.id === selectedBusinessId)) {
      setSelectedBusinessId(businesses[0]?.id ?? null);
    } else if (!selectedBusinessId && businesses.length > 0) {
      setSelectedBusinessId(businesses[0].id);
    }
  }, [adminStatus, businesses, selectedBusinessId]);

  useEffect(() => {
    if (!selectedBusiness) {
      setUserForm((prev) => ({ ...prev, garageIds: [] }));
      setAssignmentTarget({});
      setBranchSearch('');
      setUserSearch('');
      return;
    }

    const branchIds = new Set(selectedBusiness.branches.map((branch) => branch.id));
    setUserForm((prev) => ({
      ...prev,
      garageIds: prev.garageIds.filter((id) => branchIds.has(id)),
    }));
    setAssignmentTarget({});
  }, [selectedBusiness]);

  useEffect(() => {
    setBranchSearch('');
    setUserSearch('');
    setIsBranchFormVisible(false);
  }, [selectedBusiness?.id]);

  const branchNamesById = useMemo(() => {
    return businesses.reduce<Record<string, string>>((acc, business) => {
      business.branches.forEach((branch) => {
        acc[branch.id] = branch.name;
      });
      return acc;
    }, {});
  }, [businesses]);

  const businessSearchLower = businessSearch.trim().toLowerCase();
  const filteredBusinesses = useMemo(() => {
    if (!businessSearchLower) {
      return businesses;
    }
    return businesses.filter((business) =>
      business.name.toLowerCase().includes(businessSearchLower),
    );
  }, [businesses, businessSearchLower]);

  const branchSearchLower = branchSearch.trim().toLowerCase();
  const filteredBranches = useMemo(() => {
    if (!branchSearchLower) {
      return branches;
    }
    return branches.filter((branch) => branch.name.toLowerCase().includes(branchSearchLower));
  }, [branches, branchSearchLower]);

  const branchIdsForBusiness = useMemo(() => {
    return new Set(branches.map((branch) => branch.id));
  }, [branches]);

  const businessUsers = useMemo(() => {
    return users.filter((user) =>
      user.garageAccessIds.some((id) => branchIdsForBusiness.has(id)),
    );
  }, [users, branchIdsForBusiness]);

  const selectedBusinessContact = selectedBusinessId
    ? contactDetails[selectedBusinessId] ?? null
    : null;

  const userSearchLower = userSearch.trim().toLowerCase();
  const filteredUsers = useMemo(() => {
    if (!userSearchLower) {
      return businessUsers;
    }
    const selectedBusinessNameLower = selectedBusiness?.name.toLowerCase() ?? '';
    return businessUsers.filter((user) => {
      const userName = ((user as AdminUser & { name?: string }).name ?? user.email).toLowerCase();
      if (userName.includes(userSearchLower)) {
        return true;
      }
      const branchNamesText = user.garageAccessIds
        .map((id) => branchNamesById[id])
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (branchNamesText.includes(userSearchLower)) {
        return true;
      }
      if (selectedBusinessNameLower.includes(userSearchLower)) {
        return true;
      }
      return false;
    });
  }, [businessUsers, userSearchLower, branchNamesById, selectedBusiness?.name]);

  const businessMutation = useMutation({
    mutationFn: createAdminBusiness,
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['adminBusinesses'] });
      setBusinessName('');
      setBusinessMessage('Business created successfully.');
      setSelectedBusinessId(response.business.id);
      setContactDetails((prev) => ({
        ...prev,
        [response.business.id]: businessContactForm,
      }));
      setBusinessContactForm({ name: '', email: '', phone: '', role: '' });
    },
    onError: () => {
      setBusinessMessage('Failed to create business.');
    },
  });

  const branchMutation = useMutation({
    mutationFn: createAdminBranch,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['adminBusinesses'] });
      setBranchName('');
      setBranchMessage('Branch created successfully.');
    },
    onError: () => {
      setBranchMessage('Failed to create branch.');
    },
  });

  const activateGarageMutation = useMutation<
    { status: string; message?: string },
    unknown,
    { garageId: string; twilioNumber: string }
  >({
    mutationFn: ({ garageId, twilioNumber }: { garageId: string; twilioNumber: string }) =>
      activateGarage({ garageId, twilioNumber }),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['adminBusinesses'] });
      const successMessage =
        result?.message ?? 'Onboarding request sent. We will notify you when setup completes.';
      setActivationFeedback((prev) => ({
        ...prev,
        [variables.garageId]: {
          message: successMessage,
          tone: 'success',
        },
      }));
    },
    onError: (error: unknown, variables) => {
      let message = 'Failed to trigger onboarding.';
      if (error && typeof error === 'object') {
        const maybeResponse = (error as { response?: { data?: { error?: unknown; message?: unknown } } });
        const derived = maybeResponse.response?.data;
        if (derived?.error) {
          message = String(derived.error);
        } else if (derived?.message) {
          message = String(derived.message);
        } else if ('message' in error && typeof (error as { message?: unknown }).message === 'string') {
          message = String((error as { message?: unknown }).message);
        }
      }
      setActivationFeedback((prev) => ({
        ...prev,
        [variables.garageId]: { message, tone: 'error' },
      }));
    },
  });

  const updateTwilioNumberMutation = useMutation<
    { twilioNumber: string },
    unknown,
    { garageId: string; twilioNumber: string }
  >({
    mutationFn: ({ garageId, twilioNumber }) =>
      updateGarageTwilioNumber({ garageId, twilioNumber }),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['adminBusinesses'] });
      setTwilioDrafts((prev) => ({ ...prev, [variables.garageId]: result.twilioNumber ?? '' }));
      setActivationFeedback((prev) => ({
        ...prev,
        [variables.garageId]: {
          message: 'Twilio number saved.',
          tone: 'success',
        },
      }));
    },
    onError: (error: unknown, variables) => {
      let message = 'Failed to save the Twilio number.';
      if (error && typeof error === 'object') {
        const maybeResponse = (error as { response?: { data?: { error?: unknown; message?: unknown } } });
        const derived = maybeResponse.response?.data;
        if (derived?.error) {
          message = String(derived.error);
        } else if (derived?.message) {
          message = String(derived.message);
        } else if ('message' in error && typeof (error as { message?: unknown }).message === 'string') {
          message = String((error as { message?: unknown }).message);
        }
      }
      setActivationFeedback((prev) => ({
        ...prev,
        [variables.garageId]: { message, tone: 'error' },
      }));
    },
  });

  const userMutation = useMutation({
    mutationFn: createAdminUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['adminUsers'] });
      setUserForm({ email: '', password: '', confirmPassword: '', role: 'USER', garageIds: [] });
      setUserMessage('User created successfully.');
    },
    onError: () => {
      setUserMessage('Failed to create user.');
    },
  });
  
  const deleteBranchMutation = useMutation({
    mutationFn: deleteAdminBranch,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['adminBusinesses'] });
      setBranchMessage('Branch removed successfully.');
    },
    onError: () => {
      setBranchMessage('Failed to remove branch.');
    },
  });
  
  const deleteUserMutation = useMutation({
    mutationFn: deleteAdminUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['adminUsers'] });
      setUserMessage('User deleted successfully.');
    },
    onError: () => {
      setUserMessage('Failed to delete user.');
    },
  });

  const assignmentMutation = useMutation({
    mutationFn: updateAdminUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['adminUsers'] });
      setAssignmentTarget({});
      setUserMessage('Branch assigned successfully.');
    },
    onError: () => {
      setUserMessage('Failed to assign branch.');
    },
  });

  const unassignMutation = useMutation({
    mutationFn: updateAdminUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['adminUsers'] });
      setUnassignmentTarget({});
      setUserMessage('Branch unassigned successfully.');
    },
    onError: () => {
      setUserMessage('Failed to unassign branch.');
    },
  });

  const handleAssign = (user: AdminUser) => {
    const target = assignmentTarget[user.id];
    if (!target) {
      setUserMessage('Select a branch to assign first.');
      return;
    }
    if (user.garageAccessIds.includes(target)) {
      setUserMessage('User already has access to that branch.');
      return;
    }
    assignmentMutation.mutate({
      userId: user.id,
      garageAccessIds: [...user.garageAccessIds, target],
    });
  };

  const handleUnassign = (user: AdminUser) => {
    const target = unassignmentTarget[user.id];
    if (!target) {
      setUserMessage('Select a branch to unassign first.');
      return;
    }
    if (!user.garageAccessIds.includes(target)) {
      setUserMessage('The selected branch is not assigned to this user.');
      return;
    }
    const nextIds = user.garageAccessIds.filter((id) => id !== target);
    unassignMutation.mutate({ userId: user.id, garageAccessIds: nextIds });
  };

  const handleTwilioDraftChange = (branchId: string, value: string) => {
    setTwilioDrafts((prev) => ({ ...prev, [branchId]: value }));
    setActivationFeedback((prev) => {
      if (!prev[branchId]) {
        return prev;
      }
      const next = { ...prev };
      delete next[branchId];
      return next;
    });
  };

  const handleSaveTwilioNumber = (branchId: string) => {
    const trimmedDraft = (twilioDrafts[branchId] ?? '').trim();

    if (!trimmedDraft) {
      setActivationFeedback((prev) => ({
        ...prev,
        [branchId]: {
          message: 'Enter the Twilio number before saving.',
          tone: 'error',
        },
      }));
      return;
    }

    updateTwilioNumberMutation.mutate({ garageId: branchId, twilioNumber: trimmedDraft });
  };

  const handleActivateGarage = (branchId: string, currentTwilioNumber: string) => {
    setActivationFeedback((prev) => {
      const next = { ...prev };
      delete next[branchId];
      return next;
    });

    const trimmedNumber = (currentTwilioNumber ?? '').trim();
    if (!trimmedNumber) {
      setActivationFeedback((prev) => ({
        ...prev,
        [branchId]: {
          message: 'Set and save the Twilio number before activating.',
          tone: 'error',
        },
      }));
      return;
    }

    activateGarageMutation.mutate({ garageId: branchId, twilioNumber: trimmedNumber });
  };

  const currentBusinessName = selectedBusiness?.name ?? 'Select a business';

  if (!adminStatus) {
    return null;
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-100">Businesses</h2>
            <p className="text-sm text-slate-400">
              Start with a business before assigning branches and users. Use the search field to locate businesses quickly.
            </p>
          </div>
          <span className="rounded-full border border-slate-700 px-3 py-1 text-[11px] uppercase tracking-[0.3em] text-slate-500">
            {businesses.length} businesses
          </span>
        </div>
        <form
          className="mt-6 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setBusinessMessage('');
            if (!businessName.trim()) {
              setBusinessMessage('Enter a business name.');
              return;
            }
            businessMutation.mutate({ name: businessName.trim() });
          }}
        >
          <label className="flex flex-1 flex-col gap-1 text-sm text-slate-300">
            Business name
            <input
              type="text"
              value={businessName}
              onChange={(event) => setBusinessName(event.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
              placeholder="ReceptionMate Group"
            />
          </label>
          <div className="flex flex-1 flex-col gap-3 text-sm text-slate-300">
            <p className="text-xs uppercase tracking-[0.3em] text-slate-500">Business point of contact</p>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="flex flex-col gap-1">
                Name
                <input
                  type="text"
                  value={businessContactForm.name}
                  onChange={(event) =>
                    setBusinessContactForm((prev) => ({ ...prev, name: event.target.value }))
                  }
                  className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  placeholder="Casey Admin"
                />
              </label>
              <label className="flex flex-col gap-1">
                Email
                <input
                  type="email"
                  value={businessContactForm.email}
                  onChange={(event) =>
                    setBusinessContactForm((prev) => ({ ...prev, email: event.target.value }))
                  }
                  className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  placeholder="contact@biz.com"
                />
              </label>
              <label className="flex flex-col gap-1">
                Telephone
                <input
                  type="tel"
                  value={businessContactForm.phone}
                  onChange={(event) =>
                    setBusinessContactForm((prev) => ({ ...prev, phone: event.target.value }))
                  }
                  className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  placeholder="(555) 123-4567"
                />
              </label>
              <label className="flex flex-col gap-1">
                Role
                <input
                  type="text"
                  value={businessContactForm.role}
                  onChange={(event) =>
                    setBusinessContactForm((prev) => ({ ...prev, role: event.target.value }))
                  }
                  className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  placeholder="Owner"
                />
              </label>
            </div>
          </div>
          <button
            type="submit"
            className="rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-violet-400"
            disabled={businessMutation.isPending}
          >
            {businessMutation.isPending ? 'Creating…' : 'Create business'}
          </button>
        </form>
        {businessMessage && <p className="mt-2 text-sm text-slate-300">{businessMessage}</p>}
        <div className="mt-6 space-y-3">
          <label className="text-sm font-medium text-slate-300" htmlFor="businessSearch">
            Search businesses
          </label>
          <input
            id="businessSearch"
            type="search"
            value={businessSearch}
            onChange={(event) => setBusinessSearch(event.target.value)}
            placeholder="Filter by business name"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
          />
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {filteredBusinesses.map((business) => (
            <button
              key={business.id}
              onClick={() => setSelectedBusinessId(business.id)}
              className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${
                business.id === selectedBusinessId
                  ? 'border-sky-500 bg-sky-500/10 text-slate-100'
                  : 'border-slate-800 bg-slate-950/40 text-slate-200 hover:border-slate-700'
              }`}
            >
              <div className="flex items-center justify-between text-sm font-semibold">
                <span>{business.name}</span>
                <span className="text-[10px] uppercase tracking-[0.4em] text-slate-500">
                  {business.branches.length} Branches
                </span>
              </div>
              <p className="mt-1 text-[11px] text-slate-500">Business ID: {business.id}</p>
              <p className="mt-2 text-xs text-slate-500">
                {business.branches.length === 0
                  ? 'Add a branch to start tracking calls.'
                  : 'Choose this business to manage its branches.'}
              </p>
            </button>
          ))}
        </div>
        {filteredBusinesses.length === 0 && (
          <p className="mt-2 text-sm text-slate-500">
            {businesses.length === 0
              ? 'Create the first business to start assigning branches and users.'
              : 'No businesses match your search.'}
          </p>
        )}
        {!selectedBusiness && businesses.length > 0 && (
          <p className="mt-4 text-sm text-slate-500">Select a business to manage branches and users.</p>
        )}
      </section>

      {selectedBusiness && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold text-slate-100">Branches</h2>
              <p className="text-sm text-slate-400">Manage branches for {selectedBusiness.name}</p>
              <p className="text-xs text-slate-500">Business ID: {selectedBusiness.id}</p>
            </div>
            <span className="rounded-full border border-slate-700 px-3 py-1 text-[11px] uppercase tracking-[0.3em] text-slate-500">
              {branches.length} branches
            </span>
          </div>
          <div className="mt-6 space-y-4">
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-4 py-3 text-sm text-slate-200">
              <p className="text-xs uppercase tracking-[0.3em] text-slate-500">Point of contact</p>
              <p>
                <span className="font-semibold text-slate-100">Name:</span>{' '}
                {selectedBusinessContact?.name || 'Not provided'}
              </p>
              <p>
                <span className="font-semibold text-slate-100">Email:</span>{' '}
                {selectedBusinessContact?.email || 'Not provided'}
              </p>
              <p>
                <span className="font-semibold text-slate-100">Phone:</span>{' '}
                {selectedBusinessContact?.phone || 'Not provided'}
              </p>
              <p>
                <span className="font-semibold text-slate-100">Role:</span>{' '}
                {selectedBusinessContact?.role || 'Not provided'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsBranchFormVisible((prev) => !prev)}
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-100 hover:border-slate-500"
            >
              {isBranchFormVisible ? 'Hide add branch form' : 'Add branches'}
            </button>
            {isBranchFormVisible && (
              <div className="space-y-3">
                <form
                  className="flex flex-wrap items-end gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    setBranchMessage('');
                    if (!branchName.trim()) {
                      setBranchMessage('Enter a branch name.');
                      return;
                    }
                    branchMutation.mutate({ businessId: selectedBusiness.id, name: branchName.trim() });
                  }}
                >
                  <label className="flex flex-1 flex-col gap-1 text-sm text-slate-300">
                    Branch name
                    <input
                      type="text"
                      value={branchName}
                      onChange={(event) => setBranchName(event.target.value)}
                      className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                      placeholder="DMS Lane"
                    />
                  </label>
                  <button
                    type="submit"
                    className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-400"
                    disabled={branchMutation.isPending}
                  >
                    {branchMutation.isPending ? 'Creating…' : 'Create branch'}
                  </button>
                </form>
                {branchMessage && <p className="text-sm text-slate-300">{branchMessage}</p>}
              </div>
            )}
            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-300" htmlFor="branchSearch">
                Search branches
              </label>
              <input
                id="branchSearch"
                type="search"
                value={branchSearch}
                onChange={(event) => setBranchSearch(event.target.value)}
                placeholder="Filter by branch name"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {filteredBranches.map((branch) => {
                const contactPhone = branch.agentConfiguration?.phoneNumber?.trim() ?? '';
                const storedTwilioNumber = (branch.twilioNumber ?? '').trim();
                const draftTwilioNumber = twilioDrafts[branch.id] ?? branch.twilioNumber ?? '';
                const trimmedDraftTwilio = draftTwilioNumber.trim();
                const hasTwilioChanges = trimmedDraftTwilio !== storedTwilioNumber;
                const activationState = activationFeedback[branch.id] ?? null;
                const isActivating =
                  activateGarageMutation.isPending &&
                  activateGarageMutation.variables?.garageId === branch.id;
                const isUpdatingTwilio =
                  updateTwilioNumberMutation.isPending &&
                  updateTwilioNumberMutation.variables?.garageId === branch.id;

                return (
                  <div key={branch.id} className="rounded-xl border border-slate-800 bg-slate-950/40 px-4 py-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold text-slate-200">{branch.name}</p>
                      <span className="text-xs uppercase tracking-[0.3em] text-slate-500">
                        {branch.agentConfiguration?.branchName || 'Branch'}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-500">Garage ID: {branch.id}</p>
                    <p className="mt-2 text-xs text-slate-400">
                      Summary contact: {branch.agentConfiguration?.callSummaryEmail || 'Not set'}
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      Branch phone: {contactPhone || 'Not set'}
                    </p>
                    <div className="mt-2 flex flex-col gap-2">
                      <label className="text-xs text-slate-400" htmlFor={`twilio-${branch.id}`}>
                        ReceptionMate number (Twilio)
                      </label>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <input
                          id={`twilio-${branch.id}`}
                          type="text"
                          value={draftTwilioNumber}
                          onChange={(event) => handleTwilioDraftChange(branch.id, event.target.value)}
                          disabled={isUpdatingTwilio}
                          className="w-full flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                          placeholder="+44…"
                        />
                        <button
                          type="button"
                          onClick={() => handleSaveTwilioNumber(branch.id)}
                          disabled={isUpdatingTwilio || !trimmedDraftTwilio || !hasTwilioChanges}
                          className="inline-flex items-center justify-center rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-slate-100 transition hover:border-sky-500 hover:text-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {isUpdatingTwilio ? 'Saving…' : 'Save number'}
                        </button>
                      </div>
                    </div>
                    <div className="mt-3 space-y-2">
                      <button
                        type="button"
                        onClick={() => handleActivateGarage(branch.id, storedTwilioNumber)}
                        disabled={isActivating || isUpdatingTwilio || hasTwilioChanges}
                        className="w-full rounded-lg bg-emerald-500 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.3em] text-white transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700"
                        title="Trigger the onboarding flow with the saved Twilio number"
                      >
                        {isActivating ? 'Activating…' : 'Activate garage'}
                      </button>
                      {activationState && (
                        <p
                          className={`text-[11px] ${
                            activationState.tone === 'success' ? 'text-emerald-400' : 'text-red-400'
                          }`}
                        >
                          {activationState.message}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Remove branch ${branch.name}? This will revoke access from all users.`,
                          )
                        ) {
                          return;
                        }
                        deleteBranchMutation.mutate(branch.id);
                      }}
                      disabled={deleteBranchMutation.isPending}
                      className="mt-3 w-full rounded-lg border border-red-500 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.3em] text-red-400 transition-colors hover:border-red-400"
                    >
                      Remove branch
                    </button>
                  </div>
                );
              })}
            </div>
            {branches.length > 0 && filteredBranches.length === 0 && (
              <p className="text-sm text-slate-500">No branches match your search.</p>
            )}
            {branches.length === 0 && (
              <p className="text-sm text-slate-500">Create your first branch before assigning users.</p>
            )}
          </div>
        </section>
      )}

      {selectedBusiness && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <h2 className="text-xl font-semibold text-slate-100">Users</h2>
                <p className="text-sm text-slate-400">
                Only ReceptionMate staff see this area; branch managers use the calls dashboard with their assigned branches.
              </p>
            </div>
            <p className="text-sm text-slate-500">Create and manage users inside the selected business.</p>
            <p className="text-xs text-slate-500">Business ID: {selectedBusiness.id}</p>
          </div>
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                setUserMessage('');
                if (!selectedBusiness) {
                  setUserMessage('Select a business before creating users.');
                  return;
                }
                if (!userForm.email.trim() || !userForm.password || !userForm.confirmPassword) {
                  setUserMessage('Complete all fields.');
                  return;
                }
                if (userForm.password !== userForm.confirmPassword) {
                  setUserMessage('Passwords must match.');
                  return;
                }
                if (!userForm.garageIds.length) {
                  setUserMessage('Assign at least one branch for this business.');
                  return;
                }
                userMutation.mutate({
                  email: userForm.email.trim(),
                  password: userForm.password,
                  role: userForm.role,
                  garageAccessIds: userForm.garageIds,
                });
              }}
            >
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-300" htmlFor="adminEmail">
                  Email address
                </label>
                <input
                  id="adminEmail"
                  type="email"
                  value={userForm.email}
                  onChange={(event) => setUserForm({ ...userForm, email: event.target.value })}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  required
                />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-300" htmlFor="adminPassword">
                    Password
                  </label>
                  <input
                    id="adminPassword"
                    type="password"
                    value={userForm.password}
                    onChange={(event) => setUserForm({ ...userForm, password: event.target.value })}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-300" htmlFor="adminPasswordConfirm">
                    Confirm password
                  </label>
                  <input
                    id="adminPasswordConfirm"
                    type="password"
                    value={userForm.confirmPassword}
                    onChange={(event) => setUserForm({ ...userForm, confirmPassword: event.target.value })}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-300" htmlFor="userRole">
                  Role
                </label>
                <select
                  id="userRole"
                  value={userForm.role}
                  onChange={(event) =>
                    setUserForm({ ...userForm, role: event.target.value as UserRole })
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                >
                  <option value="USER">Standard user</option>
                  <option value="ADMIN">Branch admin (manager)</option>
                  <option value="RECEPTIONMATE_STAFF">ReceptionMate staff</option>
                </select>
                <p className="text-xs text-slate-500">
                  Admins act as managers for the selected business—give them every branch they should oversee.
                </p>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-slate-300">Assign branches ({currentBusinessName})</legend>
                <div className="grid gap-2 text-sm text-slate-200">
                  {!selectedBusiness && (
                    <p className="text-sm text-slate-500">Select a business to pick branches.</p>
                  )}
                  {selectedBusiness && branches.length === 0 && (
                    <p className="text-sm text-slate-500">Create a branch first so you can assign it.</p>
                  )}
                  {selectedBusiness && branches.map((branch) => (
                    <label key={branch.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={userForm.garageIds.includes(branch.id)}
                        onChange={() => setUserForm((prev) => {
                          const copy = new Set(prev.garageIds);
                          if (copy.has(branch.id)) {
                            copy.delete(branch.id);
                          } else {
                            copy.add(branch.id);
                          }
                          return { ...prev, garageIds: Array.from(copy) };
                        })}
                        className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-sky-500"
                      />
                      <span className="flex flex-col text-left leading-tight">
                        <span>{branch.name}</span>
                        <span className="text-[11px] text-slate-500">{branch.id}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <button
                type="submit"
                className="w-full rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-400"
                disabled={userMutation.isPending}
              >
                {userMutation.isPending ? 'Creating…' : 'Create user'}
              </button>
            </form>
            <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-4">
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold uppercase tracking-[0.25em] text-slate-500">Existing users</h3>
                  <span className="text-[11px] uppercase tracking-[0.3em] text-slate-500">
                    {users.length} users
                  </span>
                </div>
                <label className="text-sm font-medium text-slate-300" htmlFor="userSearch">
                  Search users
                </label>
                <input
                  id="userSearch"
                  type="search"
                  value={userSearch}
                  onChange={(event) => setUserSearch(event.target.value)}
                  placeholder="Filter by email"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div className="mt-4 space-y-3 text-sm">
                {filteredUsers.map((user) => {
                  const assignedBranchesInBusiness = branches.filter((branch) =>
                    user.garageAccessIds.includes(branch.id),
                  );
                  const accessDescriptions = user.garageAccessIds.map((id) => {
                    const label = branchNamesById[id] ?? 'Unknown branch';
                    return `${label} (${id})`;
                  });
                  return (
                    <div key={user.id} className="rounded-lg border border-slate-800 px-3 py-2">
                      <div className="flex items-center justify-between text-slate-100">
                        <span>{user.email}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-xs tracking-[0.3em] text-slate-500">{user.role}</span>
                          <button
                            type="button"
                            disabled={deleteUserMutation.isPending}
                            onClick={() => {
                              if (!window.confirm(`Delete user ${user.email}?`)) {
                                return;
                              }
                              deleteUserMutation.mutate(user.id);
                            }}
                            className="rounded-lg border border-red-500 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.3em] text-red-400"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                      <p className="mt-1 text-[11px] text-slate-500">User ID: {user.id}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        Access:{' '}
                        {accessDescriptions.length > 0
                          ? accessDescriptions.join(', ')
                          : 'None yet. Assign branches to give visibility.'}
                      </p>
                      {selectedBusiness && branches.length > 0 && (
                        <div className="mt-3 space-y-2 border-t border-slate-800 pt-3">
                          <label className="text-xs uppercase tracking-[0.3em] text-slate-500">
                            Assign branch for {selectedBusiness.name}
                          </label>
                          <div className="flex flex-wrap items-center gap-2">
                            <select
                              value={assignmentTarget[user.id] ?? ''}
                              onChange={(event) =>
                                setAssignmentTarget((prev) => ({
                                  ...prev,
                                  [user.id]: event.target.value,
                                }))
                              }
                              className="flex-1 min-w-[160px] rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                            >
                              <option value="">Select a branch</option>
                              {branches
                                .filter((branch) => !user.garageAccessIds.includes(branch.id))
                                .map((branch) => (
                                  <option key={branch.id} value={branch.id}>
                                    {branch.name} ({branch.id})
                                  </option>
                                ))}
                            </select>
                            <button
                              type="button"
                              onClick={() => handleAssign(user)}
                              disabled={assignmentMutation.isPending}
                              className="rounded-lg bg-sky-500 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-sky-400"
                            >
                              Assign
                            </button>
                          </div>
                        </div>
                      )}
                      {selectedBusiness && assignedBranchesInBusiness.length > 0 && (
                        <div className="mt-3 space-y-2 border-t border-slate-800 pt-3">
                          <label className="text-xs uppercase tracking-[0.3em] text-slate-500">
                            Unassign branch from {selectedBusiness.name}
                          </label>
                          <div className="flex flex-wrap items-center gap-2">
                            <select
                              value={unassignmentTarget[user.id] ?? ''}
                              onChange={(event) =>
                                setUnassignmentTarget((prev) => ({
                                  ...prev,
                                  [user.id]: event.target.value,
                                }))
                              }
                              className="flex-1 min-w-[160px] rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                            >
                              <option value="">Select a branch</option>
                              {assignedBranchesInBusiness.map((branch) => (
                                <option key={branch.id} value={branch.id}>
                                  {branch.name} ({branch.id})
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              onClick={() => handleUnassign(user)}
                              disabled={unassignMutation.isPending}
                              className="rounded-lg border border-yellow-500 px-3 py-1 text-xs font-semibold text-yellow-300"
                            >
                              Unassign
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {filteredUsers.length === 0 && (
                  <p className="text-xs text-slate-500">
                    {users.length === 0
                      ? 'No users have been added yet.'
                      : 'No users match your search.'}
                  </p>
                )}
              </div>
            </div>
          </div>
          {userMessage && <p className="mt-4 text-sm text-slate-300">{userMessage}</p>}
        </section>
      )}
    </div>
  );
}
