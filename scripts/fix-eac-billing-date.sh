#!/bin/bash

# SSH to EC2 and fix billing dates for EAC Telford
ssh -i ~/Downloads/ReceptionMatebackend.pem ec2-user@18.171.223.223 << 'ENDSSH'
cd ~/portal-frontend/backend

cat > fix_eac_billing_date.ts << 'ENDJS'
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function fixEACBillingDate() {
  try {
    // Update mark.kettle@eactelford.com with billing cycle dates
    const user = await prisma.user.update({
      where: { email: 'mark.kettle@eactelford.com' },
      data: {
        billingCycleStartDate: new Date('2026-03-02T00:00:00Z'),
        nextBillingDate: new Date('2026-04-02T00:00:00Z')
      }
    });

    console.log('✅ Fixed billing dates for EAC Telford');
    console.log('   User:', user.email);
    console.log('   Billing Cycle Start:', user.billingCycleStartDate?.toISOString().split('T')[0]);
    console.log('   Next Billing Date:', user.nextBillingDate?.toISOString().split('T')[0]);
    console.log('');
    console.log('🎯 EAC Telford will now appear in forecast calendar');
    console.log('   Next billing: April 2, 2026 (auto-recurring monthly)');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

fixEACBillingDate();
ENDJS

npx tsx fix_eac_billing_date.ts
rm fix_eac_billing_date.ts

ENDSSH
