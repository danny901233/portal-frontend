import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { ObservabilityDashboard } from './ObservabilityDashboard';

export const metadata = {
  title: 'Observability Dashboard | ReceptionMate',
  description: 'Performance metrics and tool call analysis for all branches',
};

export default async function ObservabilityPage() {
  const session = await getServerSession(authOptions);

  // Only RECEPTIONMATE_STAFF can access this page
  if (!session?.user || session.user.role !== 'RECEPTIONMATE_STAFF') {
    redirect('/dashboard');
  }

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
          Observability Dashboard
        </h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          Performance metrics, tool usage, and error analysis across all branches
        </p>
        <div className="mt-2 inline-flex items-center rounded-md bg-red-50 px-2 py-1 text-xs font-medium text-red-700 ring-1 ring-inset ring-red-600/10 dark:bg-red-900/20 dark:text-red-400">
          🔒 ReceptionMate Staff Only
        </div>
      </div>

      <ObservabilityDashboard />
    </div>
  );
}
