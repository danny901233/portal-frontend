#!/bin/bash

# SSH to EC2 and charge the EAC Telford invoice
ssh -i ~/Downloads/ReceptionMatebackend.pem ec2-user@18.171.223.223 << 'ENDSSH'
cd ~/portal-frontend/backend

# Create the charge script
cat > charge_eac_invoice.ts << 'ENDJS'
import { PrismaClient } from '@prisma/client';
import { createPaymentForInvoice } from './src/services/billing.js';

const prisma = new PrismaClient();

async function chargeEACInvoice() {
  const garageId = '11061962-d82b-4930-86ec-e704c22c0d57';
  
  try {
    // Find the draft or pending invoice for EAC Telford (March 2 - April 1, 2026)
    const invoice = await prisma.invoice.findFirst({
      where: {
        garageId,
        periodStart: new Date('2026-03-02T00:00:00Z'),
        status: { in: ['draft', 'pending'] }
      },
      include: {
        garage: {
          select: {
            name: true
          }
        }
      }
    });

    if (!invoice) {
      console.error('❌ No draft or pending invoice found for EAC Telford (March 2 - April 1)');
      process.exit(1);
    }

    console.log('📄 Invoice found:');
    console.log('  ID:', invoice.id);
    console.log('  Garage:', invoice.garage.name);
    console.log('  Period:', invoice.periodStart.toISOString().split('T')[0], 'to', invoice.periodEnd.toISOString().split('T')[0]);
    console.log('  Status:', invoice.status);
    console.log('  Total: £' + (invoice.total / 100).toFixed(2));
    console.log('');

    // Create GoCardless payment
    console.log('💳 Creating GoCardless payment...');
    const result = await createPaymentForInvoice(invoice.id);

    console.log('');
    console.log('✅ Payment created successfully!');
    console.log('  Payment ID:', result.payment.id);
    console.log('  Payment Status:', result.payment.status);
    console.log('  Amount: £' + (result.payment.amount / 100).toFixed(2));
    console.log('  Invoice Status:', result.invoice.status);
    console.log('');
    console.log('🎯 Next billing date will be April 2, 2026');
    console.log('   (30 days from March 2 billing cycle start)');

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

chargeEACInvoice();
ENDJS

# Load environment variables
export $(grep -v '^#' .env | xargs)

# Run the script
echo "Charging EAC Telford invoice via GoCardless..."
npx tsx charge_eac_invoice.ts

# Clean up
rm charge_eac_invoice.ts

ENDSSH
