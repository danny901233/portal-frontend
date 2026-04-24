'use client';

import { useEffect, useState } from 'react';
import { getGarageId, getSessionToken } from '../lib/auth';

interface TeamMember {
  id: string;
  email: string;
  role: 'MANAGER' | 'USER';
  status: 'Active' | 'Invited';
}

type ModalMode = 'add' | 'edit' | null;

export default function TeamPage() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [editTarget, setEditTarget] = useState<TeamMember | null>(null);
  const [formEmail, setFormEmail] = useState('');
  const [formRole, setFormRole] = useState<'MANAGER' | 'USER'>('USER');
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TeamMember | null>(null);

  const garageId = getGarageId();
  const token = getSessionToken();

  const fetchMembers = async () => {
    if (!garageId || !token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/garage/${garageId}/users`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to load team');
      const data = await res.json();
      setMembers(data.users);
    } catch {
      setError('Could not load team members.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchMembers(); }, []);

  const openAdd = () => {
    setFormEmail('');
    setFormRole('USER');
    setActionError(null);
    setEditTarget(null);
    setModalMode('add');
  };

  const openEdit = (member: TeamMember) => {
    setFormRole(member.role);
    setActionError(null);
    setEditTarget(member);
    setModalMode('edit');
  };

  const closeModal = () => { setModalMode(null); setEditTarget(null); setActionError(null); };

  const handleSave = async () => {
    if (!garageId || !token) return;
    setSaving(true);
    setActionError(null);
    try {
      if (modalMode === 'add') {
        if (!formEmail.includes('@')) { setActionError('Enter a valid email address.'); setSaving(false); return; }
        const res = await fetch(`/api/garage/${garageId}/users`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: formEmail.trim().toLowerCase(), role: formRole }),
        });
        const data = await res.json();
        if (!res.ok) { setActionError(data.error ?? 'Failed to invite user'); setSaving(false); return; }
      } else if (modalMode === 'edit' && editTarget) {
        const res = await fetch(`/api/garage/${garageId}/users/${editTarget.id}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: formRole }),
        });
        const data = await res.json();
        if (!res.ok) { setActionError(data.error ?? 'Failed to update role'); setSaving(false); return; }
      }
      closeModal();
      await fetchMembers();
    } catch {
      setActionError('Something went wrong.');
    } finally {
      setSaving(false);
    }
  };

  const handleResendInvite = async (member: TeamMember) => {
    if (!garageId || !token) return;
    try {
      const res = await fetch(`/api/garage/${garageId}/users/${member.id}/resend-invite`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed');
      alert(`Invite resent to ${member.email}`);
    } catch {
      alert('Failed to resend invite.');
    }
  };

  const handleDelete = async (member: TeamMember) => {
    if (!garageId || !token) return;
    try {
      const res = await fetch(`/api/garage/${garageId}/users/${member.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error ?? 'Failed to remove user'); return; }
      setConfirmDelete(null);
      await fetchMembers();
    } catch {
      alert('Something went wrong.');
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Team</h1>
          <p className="text-sm text-slate-400 mt-1">Manage staff access to this branch</p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-2 px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg transition-colors text-sm font-medium"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Invite User
        </button>
      </div>

      {/* Table */}
      <div className="bg-slate-900/40 border border-slate-800 rounded-lg overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-slate-400 text-sm">Loading...</div>
        ) : error ? (
          <div className="flex items-center justify-center py-16 text-red-400 text-sm">{error}</div>
        ) : members.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-slate-500 text-sm">No team members yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-left">
                <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Email</th>
                <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Role</th>
                <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
                <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member, i) => (
                <tr
                  key={member.id}
                  className={`border-b border-slate-800/60 last:border-0 ${i % 2 === 0 ? '' : 'bg-slate-800/10'}`}
                >
                  <td className="px-5 py-3 text-slate-200">{member.email}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      member.role === 'MANAGER'
                        ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20'
                        : 'bg-slate-700/60 text-slate-400 border border-slate-600/40'
                    }`}>
                      {member.role === 'MANAGER' ? 'Manager' : 'Staff'}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex items-center gap-1.5 text-xs ${
                      member.status === 'Active' ? 'text-emerald-400' : 'text-amber-400'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        member.status === 'Active' ? 'bg-emerald-400' : 'bg-amber-400'
                      }`} />
                      {member.status}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-2">
                      {member.status === 'Invited' && (
                        <button
                          onClick={() => handleResendInvite(member)}
                          className="text-xs text-slate-400 hover:text-sky-400 transition-colors"
                        >
                          Resend invite
                        </button>
                      )}
                      <button
                        onClick={() => openEdit(member)}
                        className="text-xs text-slate-400 hover:text-slate-100 transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => setConfirmDelete(member)}
                        className="text-xs text-slate-400 hover:text-red-400 transition-colors"
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add / Edit Modal */}
      {modalMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-6">
            <h2 className="text-lg font-semibold text-slate-100 mb-5">
              {modalMode === 'add' ? 'Invite New User' : 'Edit Role'}
            </h2>

            {modalMode === 'add' && (
              <div className="mb-4">
                <label className="block text-xs font-medium text-slate-400 mb-1.5">Email address</label>
                <input
                  type="email"
                  value={formEmail}
                  onChange={(e) => setFormEmail(e.target.value)}
                  placeholder="staff@garage.com"
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                />
              </div>
            )}

            {modalMode === 'edit' && (
              <p className="text-sm text-slate-400 mb-4">{editTarget?.email}</p>
            )}

            <div className="mb-5">
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Role</label>
              <div className="grid grid-cols-2 gap-3">
                {(['MANAGER', 'USER'] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => setFormRole(r)}
                    className={`px-4 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                      formRole === r
                        ? 'bg-sky-600/20 border-sky-500 text-sky-300'
                        : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600'
                    }`}
                  >
                    {r === 'MANAGER' ? 'Manager' : 'Staff'}
                  </button>
                ))}
              </div>
              <p className="text-xs text-slate-500 mt-2">
                {formRole === 'MANAGER'
                  ? 'Can manage agent config, billing, and team members.'
                  : 'Can view calls and conversations.'}
              </p>
            </div>

            {actionError && (
              <p className="text-sm text-red-400 mb-4">{actionError}</p>
            )}

            <div className="flex gap-3">
              <button
                onClick={closeModal}
                className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 px-4 py-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
              >
                {saving ? 'Saving...' : modalMode === 'add' ? 'Send Invite' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-6">
            <h2 className="text-lg font-semibold text-slate-100 mb-2">Remove User</h2>
            <p className="text-sm text-slate-400 mb-5">
              Remove <span className="text-slate-200 font-medium">{confirmDelete.email}</span> from this branch? They will lose access immediately.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDelete(null)}
                className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(confirmDelete)}
                className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-medium transition-colors"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
