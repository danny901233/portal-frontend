'use client';

import { useEffect, useState } from 'react';
import { getGarageId, getSessionToken } from '../lib/auth';
import { useLang } from '@/app/i18n/LocaleProvider';

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

  const lang = useLang();
  const c = {
    en: {
      title: 'Team',
      subtitle: 'Manage staff access to this branch',
      inviteUser: 'Invite User',
      loading: 'Loading...',
      noMembers: 'No team members yet.',
      colEmail: 'Email',
      colRole: 'Role',
      colStatus: 'Status',
      colActions: 'Actions',
      manager: 'Manager',
      staff: 'Staff',
      statusActive: 'Active',
      statusInvited: 'Invited',
      resendInvite: 'Resend invite',
      edit: 'Edit',
      remove: 'Remove',
      inviteNewUser: 'Invite New User',
      editRole: 'Edit Role',
      emailAddress: 'Email address',
      role: 'Role',
      roleManagerHint: 'Can manage agent config, billing, and team members.',
      roleStaffHint: 'Can view calls and conversations.',
      cancel: 'Cancel',
      saving: 'Saving...',
      sendInvite: 'Send Invite',
      save: 'Save',
      removeUser: 'Remove User',
      loseAccess: 'They will lose access immediately.',
      errLoad: 'Could not load team members.',
      errValidEmail: 'Enter a valid email address.',
      errInvite: 'Failed to invite user',
      errUpdateRole: 'Failed to update role',
      errGeneric: 'Something went wrong.',
      errRemove: 'Failed to remove user',
      inviteResent: (email: string) => `Invite resent to ${email}`,
      failResend: 'Failed to resend invite.',
      removePrompt: (email: string) => <>Remove <span className="text-slate-700 font-medium">{email}</span> from this branch? </>,
      statusLabel: (s: 'Active' | 'Invited') => (s === 'Active' ? 'Active' : 'Invited'),
    },
    fr: {
      title: 'Équipe',
      subtitle: 'Gérez les accès du personnel à cette agence',
      inviteUser: 'Inviter un utilisateur',
      loading: 'Chargement...',
      noMembers: 'Aucun membre pour le moment.',
      colEmail: 'E-mail',
      colRole: 'Rôle',
      colStatus: 'Statut',
      colActions: 'Actions',
      manager: 'Responsable',
      staff: 'Personnel',
      statusActive: 'Actif',
      statusInvited: 'Invité',
      resendInvite: "Renvoyer l'invitation",
      edit: 'Modifier',
      remove: 'Retirer',
      inviteNewUser: 'Inviter un nouvel utilisateur',
      editRole: 'Modifier le rôle',
      emailAddress: 'Adresse e-mail',
      role: 'Rôle',
      roleManagerHint: "Peut gérer la configuration de l'agent, la facturation et les membres de l'équipe.",
      roleStaffHint: 'Peut consulter les appels et les conversations.',
      cancel: 'Annuler',
      saving: 'Enregistrement...',
      sendInvite: "Envoyer l'invitation",
      save: 'Enregistrer',
      removeUser: 'Retirer un utilisateur',
      loseAccess: "Il perdra l'accès immédiatement.",
      errLoad: "Impossible de charger les membres de l'équipe.",
      errValidEmail: 'Saisissez une adresse e-mail valide.',
      errInvite: "Échec de l'invitation de l'utilisateur",
      errUpdateRole: 'Échec de la mise à jour du rôle',
      errGeneric: "Une erreur s'est produite.",
      errRemove: "Échec du retrait de l'utilisateur",
      inviteResent: (email: string) => `Invitation renvoyée à ${email}`,
      failResend: "Échec du renvoi de l'invitation.",
      removePrompt: (email: string) => <>Retirer <span className="text-slate-700 font-medium">{email}</span> de cette agence ? </>,
      statusLabel: (s: 'Active' | 'Invited') => (s === 'Active' ? 'Actif' : 'Invité'),
    },
  }[lang];

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
      setError(c.errLoad);
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
        if (!formEmail.includes('@')) { setActionError(c.errValidEmail); setSaving(false); return; }
        const res = await fetch(`/api/garage/${garageId}/users`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: formEmail.trim().toLowerCase(), role: formRole }),
        });
        const data = await res.json();
        if (!res.ok) { setActionError(data.error ?? c.errInvite); setSaving(false); return; }
      } else if (modalMode === 'edit' && editTarget) {
        const res = await fetch(`/api/garage/${garageId}/users/${editTarget.id}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: formRole }),
        });
        const data = await res.json();
        if (!res.ok) { setActionError(data.error ?? c.errUpdateRole); setSaving(false); return; }
      }
      closeModal();
      await fetchMembers();
    } catch {
      setActionError(c.errGeneric);
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
      alert(c.inviteResent(member.email));
    } catch {
      alert(c.failResend);
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
      if (!res.ok) { alert(data.error ?? c.errRemove); return; }
      setConfirmDelete(null);
      await fetchMembers();
    } catch {
      alert(c.errGeneric);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{c.title}</h1>
          <p className="text-sm text-slate-500 mt-1">{c.subtitle}</p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-600 text-white rounded-lg transition-colors text-sm font-medium"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {c.inviteUser}
        </button>
      </div>

      {/* Table */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-slate-500 text-sm">{c.loading}</div>
        ) : error ? (
          <div className="flex items-center justify-center py-16 text-red-400 text-sm">{error}</div>
        ) : members.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-slate-500 text-sm">{c.noMembers}</div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[560px] md:min-w-0">
            <thead>
              <tr className="border-b border-slate-200 text-left">
                <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{c.colEmail}</th>
                <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{c.colRole}</th>
                <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{c.colStatus}</th>
                <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500 text-right">{c.colActions}</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member, i) => (
                <tr
                  key={member.id}
                  className={`border-b border-slate-200 last:border-0 ${i % 2 === 0 ? '' : 'bg-slate-50'}`}
                >
                  <td className="px-5 py-3 text-slate-700">{member.email}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      member.role === 'MANAGER'
                        ? 'bg-brand-100 text-brand-600 border border-brand-600/20'
                        : 'bg-slate-700/60 text-slate-500 border border-slate-300/40'
                    }`}>
                      {member.role === 'MANAGER' ? c.manager : c.staff}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex items-center gap-1.5 text-xs ${
                      member.status === 'Active' ? 'text-emerald-700' : 'text-amber-700'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        member.status === 'Active' ? 'bg-emerald-400' : 'bg-amber-400'
                      }`} />
                      {c.statusLabel(member.status)}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-2">
                      {member.status === 'Invited' && (
                        <button
                          onClick={() => handleResendInvite(member)}
                          className="text-xs text-slate-500 hover:text-brand-600 transition-colors"
                        >
                          {c.resendInvite}
                        </button>
                      )}
                      <button
                        onClick={() => openEdit(member)}
                        className="text-xs text-slate-500 hover:text-slate-900 transition-colors"
                      >
                        {c.edit}
                      </button>
                      <button
                        onClick={() => setConfirmDelete(member)}
                        className="text-xs text-slate-500 hover:text-red-400 transition-colors"
                      >
                        {c.remove}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* Add / Edit Modal */}
      {modalMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white border border-slate-300 rounded-xl shadow-2xl p-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-5">
              {modalMode === 'add' ? c.inviteNewUser : c.editRole}
            </h2>

            {modalMode === 'add' && (
              <div className="mb-4">
                <label className="block text-xs font-medium text-slate-500 mb-1.5">{c.emailAddress}</label>
                <input
                  type="email"
                  value={formEmail}
                  onChange={(e) => setFormEmail(e.target.value)}
                  placeholder="staff@garage.com"
                  className="w-full px-3 py-2 bg-slate-100 border border-slate-300 rounded-lg text-slate-900 placeholder-slate-400 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
                />
              </div>
            )}

            {modalMode === 'edit' && (
              <p className="text-sm text-slate-500 mb-4">{editTarget?.email}</p>
            )}

            <div className="mb-5">
              <label className="block text-xs font-medium text-slate-500 mb-1.5">{c.role}</label>
              <div className="grid grid-cols-2 gap-3">
                {(['MANAGER', 'USER'] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => setFormRole(r)}
                    className={`px-4 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                      formRole === r
                        ? 'bg-brand-600/20 border-brand-600 text-brand-700'
                        : 'bg-slate-100 border-slate-300 text-slate-500 hover:border-slate-300'
                    }`}
                  >
                    {r === 'MANAGER' ? c.manager : c.staff}
                  </button>
                ))}
              </div>
              <p className="text-xs text-slate-500 mt-2">
                {formRole === 'MANAGER'
                  ? c.roleManagerHint
                  : c.roleStaffHint}
              </p>
            </div>

            {actionError && (
              <p className="text-sm text-red-400 mb-4">{actionError}</p>
            )}

            <div className="flex gap-3">
              <button
                onClick={closeModal}
                className="flex-1 px-4 py-2 bg-slate-100 hover:bg-slate-700 text-slate-600 rounded-lg text-sm transition-colors"
              >
                {c.cancel}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 px-4 py-2 bg-brand-600 hover:bg-brand-600 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
              >
                {saving ? c.saving : modalMode === 'add' ? c.sendInvite : c.save}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-white border border-slate-300 rounded-xl shadow-2xl p-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-2">{c.removeUser}</h2>
            <p className="text-sm text-slate-500 mb-5">
              {c.removePrompt(confirmDelete.email)}{c.loseAccess}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDelete(null)}
                className="flex-1 px-4 py-2 bg-slate-100 hover:bg-slate-700 text-slate-600 rounded-lg text-sm transition-colors"
              >
                {c.cancel}
              </button>
              <button
                onClick={() => handleDelete(confirmDelete)}
                className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-medium transition-colors"
              >
                {c.remove}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
