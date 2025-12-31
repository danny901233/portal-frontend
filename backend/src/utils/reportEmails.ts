import { sendEmail } from './email.js';

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

interface WeeklyReportData {
  userName: string;
  userEmail: string;
  periodStart: string;
  periodEnd: string;
  branches: BranchStats[];
  totalCallsAllBranches: number;
  totalRevenueAllBranches: number;
}

interface MonthlyReportData {
  userName: string;
  userEmail: string;
  month: string;
  year: number;
  branches: BranchStats[];
  totalCallsAllBranches: number;
  totalRevenueAllBranches: number;
  totalBookingsAllBranches: number;
}

const formatCurrency = (amount: number): string => {
  return `£${amount.toFixed(2)}`;
};

const formatDuration = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${remainingSeconds}s`;
  return `${minutes}m ${remainingSeconds}s`;
};

const generateBranchStatsHtml = (branch: BranchStats): string => {
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-bottom: 24px;">
      <tr>
        <td style="padding: 20px; background-color: #0d2739; border: 2px solid #3126cf; border-radius: 8px;">
          <h3 style="margin: 0 0 16px; font-size: 18px; font-weight: 700; color: #3126cf;">
            📍 ${branch.branchName}
          </h3>
          
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
              <td style="padding: 8px 0;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                  <tr>
                    <td width="50%" style="padding: 12px; background-color: #1a3a52; border-radius: 6px;">
                      <div style="font-size: 13px; color: #94a3b8; margin-bottom: 4px;">Total Calls</div>
                      <div style="font-size: 24px; font-weight: 700; color: #e2e8f0;">${branch.totalCalls}</div>
                    </td>
                    <td width="10"></td>
                    <td width="50%" style="padding: 12px; background-color: #1a3a52; border-radius: 6px;">
                      <div style="font-size: 13px; color: #94a3b8; margin-bottom: 4px;">Revenue</div>
                      <div style="font-size: 24px; font-weight: 700; color: #10b981;">${formatCurrency(branch.totalRevenue)}</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            
            <tr>
              <td style="padding: 16px 0 8px;">
                <div style="font-size: 14px; font-weight: 600; color: #cbd5e1; margin-bottom: 8px;">Call Breakdown</div>
              </td>
            </tr>
            
            <tr>
              <td>
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                  <tr>
                    <td style="padding: 8px 0; font-size: 14px; color: #94a3b8;">
                      <span style="color: #e2e8f0;">💬 General Enquiries:</span> ${branch.generalEnquiries}
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; font-size: 14px; color: #94a3b8;">
                      <span style="color: #e2e8f0;">📅 Booking Requests:</span> ${branch.bookingRequests}
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; font-size: 14px; color: #94a3b8;">
                      <span style="color: #10b981;">✓ Confirmed Bookings:</span> <strong style="color: #10b981;">${branch.confirmedBookings}</strong>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; font-size: 14px; color: #94a3b8;">
                      <span style="color: #e2e8f0;">⚠️ Complaints:</span> ${branch.complaints}
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; font-size: 14px; color: #94a3b8;">
                      <span style="color: #e2e8f0;">⏱️ Avg Duration:</span> ${formatDuration(branch.avgCallDuration)}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
};

const generateWeeklyReportHtml = (data: WeeklyReportData): string => {
  const branchesHtml = data.branches.map(generateBranchStatsHtml).join('\n');
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Weekly Report - ReceptionMate</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #09203c;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #09203c;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="700" style="margin: 0 auto; background-color: #1a3a52; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.5);">
          
          <!-- Header -->
          <tr>
            <td style="padding: 0; background: linear-gradient(135deg, #3126cf 0%, #2419a8 100%);">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="text-align: center; padding: 32px 32px 8px;">
                    <img src="https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png" alt="ReceptionMate" width="200" style="max-width: 200px; height: auto; display: block; margin: 0 auto;" />
                  </td>
                </tr>
                <tr>
                  <td style="text-align: center; padding: 16px 32px 32px;">
                    <h1 style="margin: 0; font-size: 28px; font-weight: 700; color: #ffffff;">
                      📊 Weekly Summary Report
                    </h1>
                    <p style="margin: 12px 0 0; font-size: 16px; color: rgba(255,255,255,0.95);">
                      ${data.periodStart} - ${data.periodEnd}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Greeting -->
          <tr>
            <td style="padding: 32px 32px 16px;">
              <p style="margin: 0; font-size: 16px; color: #cbd5e1;">
                Hi <strong style="color: #e2e8f0;">${data.userName}</strong>,
              </p>
              <p style="margin: 12px 0 0; font-size: 14px; color: #94a3b8; line-height: 1.6;">
                Here's your weekly summary of call activity across ${data.branches.length} branch${data.branches.length > 1 ? 'es' : ''}.
              </p>
            </td>
          </tr>
          
          <!-- Overall Stats -->
          <tr>
            <td style="padding: 0 32px 24px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td width="50%" style="padding: 16px; background: linear-gradient(135deg, #3126cf 0%, #2419a8 100%); border-radius: 8px; text-align: center;">
                    <div style="font-size: 14px; color: rgba(255,255,255,0.9); margin-bottom: 8px;">Total Calls This Week</div>
                    <div style="font-size: 36px; font-weight: 700; color: #ffffff;">${data.totalCallsAllBranches}</div>
                  </td>
                  <td width="20"></td>
                  <td width="50%" style="padding: 16px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); border-radius: 8px; text-align: center;">
                    <div style="font-size: 14px; color: rgba(255,255,255,0.9); margin-bottom: 8px;">Total Revenue</div>
                    <div style="font-size: 36px; font-weight: 700; color: #ffffff;">${formatCurrency(data.totalRevenueAllBranches)}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Branch Stats -->
          <tr>
            <td style="padding: 0 32px 32px;">
              <h2 style="margin: 0 0 20px; font-size: 20px; font-weight: 700; color: #e2e8f0;">
                Branch Performance
              </h2>
              ${branchesHtml}
            </td>
          </tr>
          
          <!-- Portal Button -->
          <tr>
            <td style="padding: 0 32px 32px; text-align: center;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto;">
                <tr>
                  <td style="background: linear-gradient(135deg, #3126cf 0%, #2419a8 100%); border-radius: 8px; padding: 16px 40px;">
                    <a href="https://portal.receptionmate.co.uk/dashboard" style="color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; display: block;">
                      📈 View Full Dashboard
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 28px 32px; background-color: #0a1929; border-top: 1px solid #1e4a66; text-align: center;">
              <p style="margin: 0; font-size: 13px; color: #cbd5e1; font-weight: 500;">
                This is an automated weekly report from <strong style="color: #3126cf;">ReceptionMate</strong>
              </p>
              <p style="margin: 12px 0 0; font-size: 12px; color: #64748b;">
                Intelligent call handling for your business
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
};

const generateMonthlyReportHtml = (data: MonthlyReportData): string => {
  const branchesHtml = data.branches.map(generateBranchStatsHtml).join('\n');
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Monthly Report - ReceptionMate</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #09203c;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #09203c;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="700" style="margin: 0 auto; background-color: #1a3a52; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.5);">
          
          <!-- Header -->
          <tr>
            <td style="padding: 0; background: linear-gradient(135deg, #3126cf 0%, #2419a8 100%);">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="text-align: center; padding: 32px 32px 8px;">
                    <img src="https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png" alt="ReceptionMate" width="200" style="max-width: 200px; height: auto; display: block; margin: 0 auto;" />
                  </td>
                </tr>
                <tr>
                  <td style="text-align: center; padding: 16px 32px 32px;">
                    <h1 style="margin: 0; font-size: 28px; font-weight: 700; color: #ffffff;">
                      📅 Monthly Summary Report
                    </h1>
                    <p style="margin: 12px 0 0; font-size: 18px; color: rgba(255,255,255,0.95);">
                      ${data.month} ${data.year}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Greeting -->
          <tr>
            <td style="padding: 32px 32px 16px;">
              <p style="margin: 0; font-size: 16px; color: #cbd5e1;">
                Hi <strong style="color: #e2e8f0;">${data.userName}</strong>,
              </p>
              <p style="margin: 12px 0 0; font-size: 14px; color: #94a3b8; line-height: 1.6;">
                Here's your monthly summary of call activity across ${data.branches.length} branch${data.branches.length > 1 ? 'es' : ''}.
              </p>
            </td>
          </tr>
          
          <!-- Overall Stats -->
          <tr>
            <td style="padding: 0 32px 24px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td width="32%" style="padding: 16px; background: linear-gradient(135deg, #3126cf 0%, #2419a8 100%); border-radius: 8px; text-align: center;">
                    <div style="font-size: 13px; color: rgba(255,255,255,0.9); margin-bottom: 8px;">Total Calls</div>
                    <div style="font-size: 32px; font-weight: 700; color: #ffffff;">${data.totalCallsAllBranches}</div>
                  </td>
                  <td width="2%"></td>
                  <td width="32%" style="padding: 16px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); border-radius: 8px; text-align: center;">
                    <div style="font-size: 13px; color: rgba(255,255,255,0.9); margin-bottom: 8px;">Total Revenue</div>
                    <div style="font-size: 32px; font-weight: 700; color: #ffffff;">${formatCurrency(data.totalRevenueAllBranches)}</div>
                  </td>
                  <td width="2%"></td>
                  <td width="32%" style="padding: 16px; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); border-radius: 8px; text-align: center;">
                    <div style="font-size: 13px; color: rgba(255,255,255,0.9); margin-bottom: 8px;">Bookings</div>
                    <div style="font-size: 32px; font-weight: 700; color: #ffffff;">${data.totalBookingsAllBranches}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Branch Stats -->
          <tr>
            <td style="padding: 0 32px 32px;">
              <h2 style="margin: 0 0 20px; font-size: 20px; font-weight: 700; color: #e2e8f0;">
                Branch Performance
              </h2>
              ${branchesHtml}
            </td>
          </tr>
          
          <!-- Portal Button -->
          <tr>
            <td style="padding: 0 32px 32px; text-align: center;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto;">
                <tr>
                  <td style="background: linear-gradient(135deg, #3126cf 0%, #2419a8 100%); border-radius: 8px; padding: 16px 40px;">
                    <a href="https://portal.receptionmate.co.uk/dashboard" style="color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; display: block;">
                      📈 View Full Dashboard
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 28px 32px; background-color: #0a1929; border-top: 1px solid #1e4a66; text-align: center;">
              <p style="margin: 0; font-size: 13px; color: #cbd5e1; font-weight: 500;">
                This is an automated monthly report from <strong style="color: #3126cf;">ReceptionMate</strong>
              </p>
              <p style="margin: 12px 0 0; font-size: 12px; color: #64748b;">
                Intelligent call handling for your business
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
};

export const sendWeeklyReport = async (data: WeeklyReportData): Promise<boolean> => {
  const html = generateWeeklyReportHtml(data);
  const text = `Weekly Report for ${data.periodStart} - ${data.periodEnd}\n\nTotal Calls: ${data.totalCallsAllBranches}\nTotal Revenue: ${formatCurrency(data.totalRevenueAllBranches)}\n\nView full details at https://portal.receptionmate.co.uk/dashboard`;

  return sendEmail({
    to: [data.userEmail],
    subject: `📊 Weekly Report: ${data.periodStart} - ${data.periodEnd}`,
    html,
    text,
  });
};

export const sendMonthlyReport = async (data: MonthlyReportData): Promise<boolean> => {
  const html = generateMonthlyReportHtml(data);
  const text = `Monthly Report for ${data.month} ${data.year}\n\nTotal Calls: ${data.totalCallsAllBranches}\nTotal Revenue: ${formatCurrency(data.totalRevenueAllBranches)}\nTotal Bookings: ${data.totalBookingsAllBranches}\n\nView full details at https://portal.receptionmate.co.uk/dashboard`;

  return sendEmail({
    to: [data.userEmail],
    subject: `📅 Monthly Report: ${data.month} ${data.year}`,
    html,
    text,
  });
};
