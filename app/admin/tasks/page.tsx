'use client';

// In-portal ops-tasks board — shared between Dan and the VA. Postgres-backed so
// changes made by one show up for the other on the next poll. v1 scope: see
// tasks grouped by cadence, filter (owner/status/cadence/tag), open a task to
// read its instructions + edit notes, reassign, tick done, add new tasks,
// reset daily. Mirrors /admin/support for auth + polling.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isReceptionMateStaff } from '../../lib/auth';
import {
  fetchOpsTasks,
  fetchOpsStaff,
  createOpsTask,
  patchOpsTask,
  toggleOpsTask,
  deleteOpsTask,
  resetDailyOpsTasks,
  type OpsTask,
  type OpsTaskCadence,
  type OpsTaskStatus,
  type OpsStaffUser,
} from '../../lib/api';

const POLL_MS = 30_000;
const CADENCES: OpsTaskCadence[] = ['daily', 'weekly', 'monthly', 'project'];

const CADENCE_LABEL: Record<OpsTaskCadence, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  project: 'Project',
};

type OwnerFilter = 'anyone' | 'me' | string; // 'me' | staff userId
type StatusFilter = 'all' | OpsTaskStatus;
type CadenceFilter = 'all' | OpsTaskCadence;

export default function AdminOpsTasksPage() {
  const router = useRouter();

  const [tasks, setTasks] = useState<OpsTask[]>([]);
  const [staff, setStaff] = useState<OpsStaffUser[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState<Record<string, string>>({});
  const [savingNotes, setSavingNotes] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Filters
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>('anyone');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [cadenceFilter, setCadenceFilter] = useState<CadenceFilter>('all');
  const [tagFilter, setTagFilter] = useState<string>('');
  const [meUserId, setMeUserId] = useState<string | null>(null);

  // Staff-only gate — redirect anyone else to /dashboard, same pattern as /admin/support
  useEffect(() => {
    if (!isReceptionMateStaff()) {
      router.replace('/dashboard');
      return;
    }
    // Read current user id from the JWT so "Me" filter works.
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('rm.jwt') : null;
      if (token) {
        const payload = JSON.parse(atob(token.split('.')[1]));
        if (payload?.userId) setMeUserId(payload.userId);
      }
    } catch {
      // non-fatal — Me filter just won't work
    }
  }, [router]);

  const loadTasks = useCallback(async () => {
    try {
      const res = await fetchOpsTasks();
      setTasks(res.tasks);
      // Keep the notes draft in sync unless the user is actively editing
      setNotesDraft((prev) => {
        const next = { ...prev };
        for (const t of res.tasks) {
          if (!(t.id in next)) next[t.id] = t.notes ?? '';
        }
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load tasks');
    }
  }, []);

  const loadStaff = useCallback(async () => {
    try {
      const res = await fetchOpsStaff();
      setStaff(res.staff);
    } catch (e) {
      // Non-fatal — assignee dropdown just won't populate
      console.warn('Failed to load staff', e);
    }
  }, []);

  useEffect(() => {
    loadTasks();
    loadStaff();
    const id = setInterval(loadTasks, POLL_MS);
    return () => clearInterval(id);
  }, [loadTasks, loadStaff]);

  // Apply client-side filters — server also supports them but keeping the raw
  // list local means switching filters is instant and the poll refresh is smooth.
  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (cadenceFilter !== 'all' && t.cadence !== cadenceFilter) return false;
      if (tagFilter.trim() && !t.tags.some((tag) => tag.toLowerCase().includes(tagFilter.trim().toLowerCase()))) {
        return false;
      }
      if (ownerFilter === 'me') {
        if (!meUserId || t.assigneeId !== meUserId) return false;
      } else if (ownerFilter !== 'anyone') {
        if (t.assigneeId !== ownerFilter) return false;
      }
      return true;
    });
  }, [tasks, statusFilter, cadenceFilter, tagFilter, ownerFilter, meUserId]);

  const grouped = useMemo(() => {
    const buckets: Record<OpsTaskCadence, OpsTask[]> = {
      daily: [],
      weekly: [],
      monthly: [],
      project: [],
    };
    for (const t of filteredTasks) buckets[t.cadence].push(t);
    return buckets;
  }, [filteredTasks]);

  // Optimistic mutation helpers — update local state immediately, then reconcile
  const handleToggle = async (task: OpsTask) => {
    const nextStatus = task.status === 'done' ? 'open' : 'done';
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: nextStatus } : t)));
    try {
      const res = await toggleOpsTask(task.id);
      setTasks((prev) => prev.map((t) => (t.id === task.id ? res.task : t)));
    } catch (e) {
      // Revert on failure
      setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: task.status } : t)));
      setError(e instanceof Error ? e.message : 'Failed to toggle task');
    }
  };

  const handleReassign = async (task: OpsTask, newAssigneeId: string | null) => {
    try {
      const res = await patchOpsTask(task.id, { assigneeId: newAssigneeId });
      setTasks((prev) => prev.map((t) => (t.id === task.id ? res.task : t)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reassign');
    }
  };

  const handleSaveNotes = async (task: OpsTask) => {
    const draft = notesDraft[task.id] ?? '';
    setSavingNotes((prev) => ({ ...prev, [task.id]: true }));
    try {
      const res = await patchOpsTask(task.id, { notes: draft });
      setTasks((prev) => prev.map((t) => (t.id === task.id ? res.task : t)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save notes');
    } finally {
      setSavingNotes((prev) => ({ ...prev, [task.id]: false }));
    }
  };

  const handleDelete = async (task: OpsTask) => {
    if (!window.confirm(`Delete "${task.title}"?`)) return;
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    try {
      await deleteOpsTask(task.id);
    } catch (e) {
      // Refetch to recover
      await loadTasks();
      setError(e instanceof Error ? e.message : 'Failed to delete');
    }
  };

  const handleResetDaily = async () => {
    if (!window.confirm('Re-open every daily task marked done?')) return;
    try {
      const res = await resetDailyOpsTasks();
      await loadTasks();
      setError(null);
      alert(`Reopened ${res.reopened} daily task${res.reopened === 1 ? '' : 's'}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reset daily');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Ops tasks</h1>
            <p className="mt-1 text-sm text-slate-500">
              Shared board for Dan and the VA. Postgres-backed — changes sync between staff on the next 30s poll.
            </p>
            <div className="mt-2 inline-flex items-center rounded-md bg-red-50 px-2 py-1 text-xs font-medium text-red-700 ring-1 ring-inset ring-red-200">
              🔒 ReceptionMate Staff Only
            </div>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={handleResetDaily}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Reset daily
            </button>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              + Add task
            </button>
          </div>
        </header>

        {error && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error} <button type="button" onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
          </div>
        )}

        {/* Filter bar */}
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm">
          <FilterPill label="Owner">
            <select
              value={ownerFilter}
              onChange={(e) => setOwnerFilter(e.target.value as OwnerFilter)}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900"
            >
              <option value="anyone">Anyone</option>
              <option value="me">Me</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>{s.email}</option>
              ))}
            </select>
          </FilterPill>
          <FilterPill label="Status">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900"
            >
              <option value="all">All</option>
              <option value="open">Open</option>
              <option value="done">Done</option>
            </select>
          </FilterPill>
          <FilterPill label="Cadence">
            <select
              value={cadenceFilter}
              onChange={(e) => setCadenceFilter(e.target.value as CadenceFilter)}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900"
            >
              <option value="all">All</option>
              {CADENCES.map((c) => (
                <option key={c} value={c}>{CADENCE_LABEL[c]}</option>
              ))}
            </select>
          </FilterPill>
          <FilterPill label="Tag">
            <input
              type="text"
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              placeholder="e.g. agents"
              className="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900"
            />
          </FilterPill>
        </div>

        {/* Grouped sections */}
        {CADENCES.map((cadence) => {
          const list = grouped[cadence];
          if (list.length === 0 && cadenceFilter !== 'all' && cadenceFilter !== cadence) return null;
          const done = list.filter((t) => t.status === 'done').length;
          return (
            <section key={cadence} className="mb-6">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                  {CADENCE_LABEL[cadence]}
                </h2>
                <span className="text-xs text-slate-500">
                  {done} / {list.length} done
                </span>
              </div>
              {list.length === 0 ? (
                <p className="rounded-md border border-dashed border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-400">
                  No {CADENCE_LABEL[cadence].toLowerCase()} tasks match the current filters.
                </p>
              ) : (
                <ul className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                  {list.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      staff={staff}
                      expanded={expandedId === task.id}
                      onExpandToggle={() => setExpandedId(expandedId === task.id ? null : task.id)}
                      onToggle={() => handleToggle(task)}
                      onReassign={(id) => handleReassign(task, id)}
                      onDelete={() => handleDelete(task)}
                      notesDraft={notesDraft[task.id] ?? ''}
                      onNotesDraftChange={(v) => setNotesDraft((prev) => ({ ...prev, [task.id]: v }))}
                      onSaveNotes={() => handleSaveNotes(task)}
                      savingNotes={savingNotes[task.id] === true}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      {creating && (
        <CreateTaskModal
          staff={staff}
          onClose={() => setCreating(false)}
          onCreated={async (task) => {
            setTasks((prev) => [...prev, task]);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FilterPill — labelled inline control in the filter bar
// ---------------------------------------------------------------------------

function FilterPill({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-slate-500">
      <span>{label}</span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// TaskRow — one task in the list; expandable to show instructions + notes
// ---------------------------------------------------------------------------

interface TaskRowProps {
  task: OpsTask;
  staff: OpsStaffUser[];
  expanded: boolean;
  onExpandToggle: () => void;
  onToggle: () => void;
  onReassign: (assigneeId: string | null) => void;
  onDelete: () => void;
  notesDraft: string;
  onNotesDraftChange: (v: string) => void;
  onSaveNotes: () => void;
  savingNotes: boolean;
}

function TaskRow({
  task,
  staff,
  expanded,
  onExpandToggle,
  onToggle,
  onReassign,
  onDelete,
  notesDraft,
  onNotesDraftChange,
  onSaveNotes,
  savingNotes,
}: TaskRowProps) {
  const assigneeLabel = task.assignee ? task.assignee.email.split('@')[0] : 'Unassigned';
  return (
    <li className={task.status === 'done' ? 'bg-slate-50' : ''}>
      <div className="flex items-start gap-3 px-4 py-3">
        <input
          type="checkbox"
          checked={task.status === 'done'}
          onChange={onToggle}
          className="mt-1 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-sm ${task.status === 'done' ? 'text-slate-400 line-through' : 'font-medium text-slate-900'}`}>
              {task.title}
            </span>
            {task.tags.map((tag) => (
              <span key={tag} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600">
                {tag}
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <select
            value={task.assigneeId ?? ''}
            onChange={(e) => onReassign(e.target.value || null)}
            className="rounded border border-slate-300 bg-white px-1.5 py-1 text-xs text-slate-700"
            title={assigneeLabel}
          >
            <option value="">Unassigned</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>{s.email}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={onExpandToggle}
            className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
            aria-label="Show instructions and notes"
          >
            {expanded ? '−' : 'i'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-slate-100 bg-slate-50 px-4 py-3">
          {task.instructions && (
            <div className="mb-3">
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Instructions</h4>
              {/* Plain-text render for v1 — the seed uses "1. ...\n2. ..." format which reads fine.
                  Markdown rendering can be added later without touching the data. */}
              <pre className="whitespace-pre-wrap font-sans text-sm text-slate-700">{task.instructions}</pre>
            </div>
          )}

          <div className="mb-3">
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Notes</h4>
            <textarea
              value={notesDraft}
              onChange={(e) => onNotesDraftChange(e.target.value)}
              rows={3}
              placeholder="Add notes about this task…"
              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
            <div className="mt-2 flex items-center justify-between">
              <button
                type="button"
                onClick={onSaveNotes}
                disabled={savingNotes}
                className="rounded bg-brand-600 px-2 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {savingNotes ? 'Saving…' : 'Save notes'}
              </button>
              <button
                type="button"
                onClick={onDelete}
                className="rounded border border-red-200 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
              >
                Delete task
              </button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// CreateTaskModal — small form to add a new task
// ---------------------------------------------------------------------------

function CreateTaskModal({
  staff,
  onClose,
  onCreated,
}: {
  staff: OpsStaffUser[];
  onClose: () => void;
  onCreated: (task: OpsTask) => void | Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [cadence, setCadence] = useState<OpsTaskCadence>('weekly');
  const [tagsText, setTagsText] = useState('');
  const [assigneeId, setAssigneeId] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setErr('Title is required');
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const tags = tagsText.split(',').map((t) => t.trim()).filter(Boolean);
      const res = await createOpsTask({
        title: title.trim(),
        instructions: instructions.trim() || null,
        cadence,
        tags,
        assigneeId: assigneeId || null,
      });
      await onCreated(res.task);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to create task');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl"
      >
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Add task</h2>
        {err && (
          <div className="mb-3 rounded border border-red-200 bg-red-50 px-2 py-1 text-sm text-red-700">{err}</div>
        )}
        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            autoFocus
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
          />
        </label>
        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Cadence</span>
          <select
            value={cadence}
            onChange={(e) => setCadence(e.target.value as OpsTaskCadence)}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900"
          >
            {CADENCES.map((c) => (
              <option key={c} value={c}>{CADENCE_LABEL[c]}</option>
            ))}
          </select>
        </label>
        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Tags (comma-separated)</span>
          <input
            type="text"
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="e.g. agents, billing"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900"
          />
        </label>
        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Assignee</span>
          <select
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900"
          >
            <option value="">Unassigned</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>{s.email}</option>
            ))}
          </select>
        </label>
        <label className="mb-4 block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Instructions (optional)</span>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={5}
            placeholder="Step-by-step: 1. …\n2. …"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900"
          />
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {saving ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
