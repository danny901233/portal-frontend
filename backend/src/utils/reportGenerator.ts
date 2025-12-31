import { prisma } from '../db.js';
import { sendWeeklyReport, sendMonthlyReport } from './reportEmails.js';

interface BranchStats {
  branchId: string;
  branchName: string;
  totalCalls: number;
  generalEnquiries: number;
  bookingRequests: number;
  complaints: number;
  confirmedBookings: number;
  totalRevenue: number;
  avgCallDuration: number;
  callsByDay: { [key: string]: number };
}

const formatDate = (date: Date): string => {
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const getMonthName = (month: number): string => {
  return new Date(2024, month, 1).toLocaleDateString('en-GB', { month: 'long' });
};

const calculateBranchStats = async (
  branchId: string,
  branchName: string,
  startDate: Date,
  endDate: Date
): Promise<BranchStats> => {
  const calls = await prisma.call.findMany({
    where: {
      garageId: branchId,
      createdAt: {
        gte: startDate,
        lt: endDate,
      },
    },
  });

  const totalCalls = calls.length;
  const generalEnquiries = calls.filter(c => c.callType === 'GENERAL_ENQUIRY').length;
  const bookingRequests = calls.filter(c => c.callType === 'BOOKING_REQUEST').length;
  const complaints = calls.filter(c => c.callType === 'COMPLAINT').length;
  const confirmedBookings = calls.filter(c => c.confirmedBooking).length;
  const totalRevenue = calls.reduce((sum, c) => sum + (c.capturedRevenue || 0), 0);
  
  const totalDuration = calls.reduce((sum, c) => sum + (c.durationSeconds || 0), 0);
  const avgCallDuration = totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0;

  // Group calls by day
  const callsByDay: { [key: string]: number } = {};
  calls.forEach(call => {
    const day = formatDate(call.createdAt);
    callsByDay[day] = (callsByDay[day] || 0) + 1;
  });

  return {
    branchId,
    branchName,
    totalCalls,
    generalEnquiries,
    bookingRequests,
    complaints,
    confirmedBookings,
    totalRevenue,
    avgCallDuration,
    callsByDay,
  };
};

export const generateWeeklyReports = async (): Promise<void> => {
  console.log('Generating weekly reports...');

  // Get date range for the past week (Sunday to Saturday)
  const endDate = new Date();
  endDate.setHours(0, 0, 0, 0); // Start of today
  
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 7); // 7 days ago

  console.log(`Report period: ${formatDate(startDate)} - ${formatDate(endDate)}`);

  // Find all managers
  const managers = await prisma.user.findMany({
    where: {
      role: 'MANAGER',
    },
    include: {
      business: {
        include: {
          garages: true,
        },
      },
    },
  });

  console.log(`Found ${managers.length} managers`);

  for (const manager of managers) {
    try {
      // Get branches this manager has access to
      const branches: { id: string; name: string }[] = [];
      
      // If manager role, get all branches in their business
      if (manager.business) {
        branches.push(...manager.business.garages.map(g => ({ id: g.id, name: g.name })));
      }

      if (branches.length === 0) {
        console.log(`Skipping ${manager.email} - no branches assigned`);
        continue;
      }

      console.log(`Processing manager: ${manager.email} with ${branches.length} branch(es)`);

      // Calculate stats for each branch
      const branchStats: BranchStats[] = [];
      let totalCallsAllBranches = 0;
      let totalRevenueAllBranches = 0;

      for (const branch of branches) {
        const stats = await calculateBranchStats(branch.id, branch.name, startDate, endDate);
        branchStats.push(stats);
        totalCallsAllBranches += stats.totalCalls;
        totalRevenueAllBranches += stats.totalRevenue;
      }

      // Send email
      await sendWeeklyReport({
        userName: manager.email,
        userEmail: manager.email,
        periodStart: formatDate(startDate),
        periodEnd: formatDate(new Date(endDate.getTime() - 24 * 60 * 60 * 1000)), // Yesterday
        branches: branchStats,
        totalCallsAllBranches,
        totalRevenueAllBranches,
      });

      console.log(`✓ Sent weekly report to ${manager.email}`);
    } catch (error) {
      console.error(`Failed to generate report for ${manager.email}:`, error);
    }
  }

  console.log('Weekly reports completed');
};

export const generateMonthlyReports = async (): Promise<void> => {
  console.log('Generating monthly reports...');

  // Get date range for the past month
  const now = new Date();
  const endDate = new Date(now.getFullYear(), now.getMonth(), 1); // First day of current month
  const startDate = new Date(endDate.getFullYear(), endDate.getMonth() - 1, 1); // First day of last month

  const month = getMonthName(startDate.getMonth());
  const year = startDate.getFullYear();

  console.log(`Report period: ${month} ${year}`);

  // Find all managers
  const managers = await prisma.user.findMany({
    where: {
      role: 'MANAGER',
    },
    include: {
      business: {
        include: {
          garages: true,
        },
      },
    },
  });

  console.log(`Found ${managers.length} managers`);

  for (const manager of managers) {
    try {
      // Get branches this manager has access to
      const branches: { id: string; name: string }[] = [];
      
      // If manager role, get all branches in their business
      if (manager.business) {
        branches.push(...manager.business.garages.map(g => ({ id: g.id, name: g.name })));
      }

      if (branches.length === 0) {
        console.log(`Skipping ${manager.email} - no branches assigned`);
        continue;
      }

      console.log(`Processing manager: ${manager.email} with ${branches.length} branch(es)`);

      // Calculate stats for each branch
      const branchStats: BranchStats[] = [];
      let totalCallsAllBranches = 0;
      let totalRevenueAllBranches = 0;
      let totalBookingsAllBranches = 0;

      for (const branch of branches) {
        const stats = await calculateBranchStats(branch.id, branch.name, startDate, endDate);
        branchStats.push(stats);
        totalCallsAllBranches += stats.totalCalls;
        totalRevenueAllBranches += stats.totalRevenue;
        totalBookingsAllBranches += stats.confirmedBookings;
      }

      // Send email
      await sendMonthlyReport({
        userName: manager.email,
        userEmail: manager.email,
        month,
        year,
        branches: branchStats,
        totalCallsAllBranches,
        totalRevenueAllBranches,
        totalBookingsAllBranches,
      });

      console.log(`✓ Sent monthly report to ${manager.email}`);
    } catch (error) {
      console.error(`Failed to generate report for ${manager.email}:`, error);
    }
  }

  console.log('Monthly reports completed');
};
