#!/bin/bash

# SSH to EC2 and recreate invoice for EAC Telford with correct period
ssh -i ~/Downloads/ReceptionMatebackend.pem ec2-user@18.171.223.223 << 'ENDSSH'
cd ~/portal-frontend/backend

# Create the invoice script
cat > recreate_eac_invoice.ts << 'ENDJS'
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function recreateEACInvoice() {
  const garageId = '11061962-d82b-4930-86ec-e704c22c0d57';
  
  try {
    // First, delete the old invoice
    const deleted = await prisma.invoice.deleteMany({
      where: {
        garageId,
        periodStart: new Date('2026-02-02T00:00:00Z')
      }
    });
    
    console.log('✓ Deleted', deleted.count, 'old invoice(s)');
    
    // Fetch garage details
    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      include: {
        agentConfiguration: true,
        calls: {
          where: {
            createdAt: {
              gte: new Date('2026-03-02T00:00:00Z'),
              lt: new Date('2026-04-02T00:00:00Z')
            }
          }
        }
      }
    });

    if (!garage) {
      console.error('❌ Garage not found');
      process.exit(1);
    }

    console.log('\n✓ Garage found:', garage.name);
    console.log('  Subscription Cost: £' + garage.subscriptionCostGbp);
    console.log('  Included Minutes:', garage.includedMinutes);
    console.log('  Cost Per Minute: £' + garage.costPerMinuteGbp);

    // Calculate call usage for March 2 - April 1
    const totalCallMinutes = garage.calls.reduce((sum, call) => {
      return sum + Math.ceil(call.durationSeconds / 60);
    }, 0);

    const overageMinutes = Math.max(0, totalCallMinutes - garage.includedMinutes);
    const overageCharges = overageMinutes * garage.costPerMinuteGbp;

    const subtotal = garage.subscriptionCostGbp + overageCharges;
    const vatAmount = subtotal * garage.vatRate;
    const totalAmount = subtotal + vatAmount;

    // Convert to pence for storage
    const subscriptionAmountPence = Math.round(garage.subscriptionCostGbp * 100);
    const minutesAmountPence = Math.round(overageCharges * 100);
    const subtotalPence = Math.round(subtotal * 100);
    const vatAmountPence = Math.round(vatAmount * 100);
    const totalPence = Math.round(totalAmount * 100);

    console.log('\n📊 Usage Summary (March 2 - April 1, 2026):');
    console.log('  Total Calls:', garage.calls.length);
    console.log('  Total Minutes:', totalCallMinutes);
    console.log('  Included Minutes:', garage.includedMinutes);
    console.log('  Overage Minutes:', overageMinutes);
    console.log('  Subscription: £' + garage.subscriptionCostGbp.toFixed(2));
    console.log('  Overage Charges: £' + overageCharges.toFixed(2));
    console.log('  Subtotal: £' + subtotal.toFixed(2));
    console.log('  VAT (20%): £' + vatAmount.toFixed(2));
    console.log('  Total: £' + totalAmount.toFixed(2));

    // Set billing dates - period March 2 to April 1
    const billingPeriodStart = new Date('2026-03-02T00:00:00Z');
    const billingPeriodEnd = new Date('2026-04-01T23:59:59Z');

    // Create invoice
    const invoice = await prisma.invoice.create({
      data: {
        garageId,
        periodStart: billingPeriodStart,
        periodEnd: billingPeriodEnd,
        
        // Usage
        minutesUsed: totalCallMinutes,
        minutesIncluded: garage.includedMinutes,
        smsCount: 0,
        
        // Amounts in pence
        subscriptionAmount: subscriptionAmountPence,
        minutesAmount: minutesAmountPence,
        smsAmount: 0,
        subtotal: subtotalPence,
        vatAmount: vatAmountPence,
        total: totalPence,
        
        // Rates for audit
        subscriptionCostGbp: garage.subscriptionCostGbp,
        costPerMinuteGbp: garage.costPerMinuteGbp,
        vatRate: garage.vatRate,
        
        status: 'pending',
      }
    });

    console.log('\n✅ Invoice created successfully!');
    console.log('  Invoice ID:', invoice.id);
    console.log('  Period: March 2 - April 1, 2026');
    console.log('  Status:', invoice.status);
    console.log('  Total Amount: £' + totalAmount.toFixed(2));

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

recreateEACInvoice();
ENDJS

# Run the script
echo "Recreating invoice for EAC Telford (March 2 - April 1, 2026)..."
npx tsx recreate_eac_invoice.ts

# Clean up
rm recreate_eac_invoice.ts

ENDSSH
