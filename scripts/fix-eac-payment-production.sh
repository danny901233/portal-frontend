#!/bin/bash

# SSH to EC2 and fix the EAC payment
ssh -i ~/Downloads/ReceptionMatebackend.pem ec2-user@18.171.223.223 << 'ENDSSH'
cd ~/portal-frontend/backend

# Load environment variables
export $(grep -v '^#' .env | xargs)

cat > fix_eac_payment.ts << 'ENDJS'
import { PrismaClient } from '@prisma/client';
import gocardless from 'gocardless-nodejs';

const GOCARDLESS_ACCESS_TOKEN = process.env.GOCARDLESS_ACCESS_TOKEN || '';
const GOCARDLESS_ENVIRONMENT = process.env.GOCARDLESS_ENVIRONMENT || 'sandbox';

function getGocardlessClient() {
  return gocardless(
    GOCARDLESS_ACCESS_TOKEN,
    GOCARDLESS_ENVIRONMENT as 'sandbox' | 'live'
  );
}

const prisma = new PrismaClient();

async function fixEACPayment() {
  const garageId = '11061962-d82b-4930-86ec-e704c22c0d57';
  const correctUserId = 'cmklqwmwj00a310bgynr8kkwg'; // mark.kettle@eactelford.com
  
  try {
    // Find the invoice
    const invoice = await prisma.invoice.findFirst({
      where: {
        garageId,
        periodStart: new Date('2026-03-02T00:00:00Z'),
        status: 'pending'
      }
    });

    if (!invoice) {
      console.error('❌ Invoice not found');
      process.exit(1);
    }

    console.log('📄 Invoice:', invoice.id);
    console.log('   Current Payment ID:', invoice.gocardlessPaymentId);
    console.log('');

    // Cancel the incorrect payment
    if (invoice.gocardlessPaymentId) {
      try {
        const client = getGocardlessClient();
        console.log('🚫 Cancelling incorrect payment:', invoice.gocardlessPaymentId);
        await client.payments.cancel(invoice.gocardlessPaymentId);
        console.log('✓ Payment cancelled');
      } catch (error) {
        console.log('⚠️  Failed to cancel payment (may already be processed):', error.message);
      }
    }

    console.log('');

    // Update invoice with correct userId
    console.log('📝 Updating invoice with correct user...');
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        userId: correctUserId,
        status: 'draft',
        gocardlessPaymentId: null
      }
    });
    console.log('✓ Invoice updated to use mark.kettle@eactelford.com');

    console.log('');
    console.log('✅ Fixed! Now you can charge the invoice again with the correct mandate.');
    console.log('   Run: bash scripts/charge-eac-invoice-production.sh');

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

fixEACPayment();
ENDJS

npx tsx fix_eac_payment.ts
rm fix_eac_payment.ts

ENDSSH
