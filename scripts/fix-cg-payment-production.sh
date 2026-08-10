#!/bin/bash

# SSH to EC2 and fix C & G Auto Repairs payment
ssh -i ~/Downloads/ReceptionMatebackend.pem ec2-user@18.171.223.223 << 'ENDSSH'
cd ~/portal-frontend/backend

# Load environment variables
export $(grep -v '^#' .env | xargs)

cat > fix_cg_payment.ts << 'ENDJS'
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

async function fixCGPayment() {
  const garageId = '8136d257-9537-44be-b243-4fa67cd07444';
  
  try {
    // Find user by email
    const correctUser = await prisma.user.findUnique({
      where: { email: 'barry.gomm@yahoo.com' },
      select: { id: true, email: true, gocardlessMandateId: true }
    });

    if (!correctUser) {
      console.error('❌ User barry.gomm@yahoo.com not found');
      process.exit(1);
    }

    console.log('✓ Found user:', correctUser.email);
    console.log('  User ID:', correctUser.id);
    console.log('  Mandate:', correctUser.gocardlessMandateId);
    console.log('');

    // Find the invoice (most recent pending/draft for this garage)
    const invoice = await prisma.invoice.findFirst({
      where: {
        garageId,
        status: { in: ['draft', 'pending'] }
      },
      orderBy: { createdAt: 'desc' }
    });

    if (!invoice) {
      console.error('❌ Invoice not found');
      process.exit(1);
    }

    console.log('📄 Invoice:', invoice.id);
    console.log('   Current Payment ID:', invoice.gocardlessPaymentId);
    console.log('   Total: £' + (invoice.total / 100).toFixed(2));
    console.log('');

    // Cancel the incorrect payment
    if (invoice.gocardlessPaymentId) {
      try {
        const client = getGocardlessClient();
        console.log('🚫 Cancelling incorrect payment:', invoice.gocardlessPaymentId);
        await client.payments.cancel(invoice.gocardlessPaymentId);
        console.log('✓ Payment cancelled');
      } catch (error) {
        console.log('⚠️  Failed to cancel payment:', error.message);
      }
    }

    console.log('');

    // Update invoice with correct userId
    console.log('📝 Updating invoice with correct user...');
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        userId: correctUser.id,
        status: 'draft',
        gocardlessPaymentId: null
      }
    });
    console.log('✓ Invoice updated to use barry.gomm@yahoo.com');

    console.log('');

    // Create new payment with correct mandate
    console.log('💳 Creating new payment with correct mandate...');
    const client = getGocardlessClient();
    
    const payment = await client.payments.create({
      amount: invoice.total.toString(),
      currency: 'GBP',
      description: `ReceptionMate Invoice ${invoice.id.slice(0, 8)} - C & G Auto Repairs`,
      metadata: {
        invoice_id: invoice.id,
        garage_id: garageId,
      },
      links: {
        mandate: correctUser.gocardlessMandateId!,
      },
    });

    console.log('✓ Payment created:', payment.id);
    console.log('  Status:', payment.status);
    console.log('');

    // Update invoice with new payment
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        status: 'pending',
        gocardlessPaymentId: payment.id
      }
    });

    console.log('✅ Fixed! Invoice now charged to correct mandate.');
    console.log('   Payment ID:', payment.id);
    console.log('   Mandate:', correctUser.gocardlessMandateId);

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

fixCGPayment();
ENDJS

npx tsx fix_cg_payment.ts
rm fix_cg_payment.ts

ENDSSH
