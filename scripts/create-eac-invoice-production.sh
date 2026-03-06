#!/bin/bash

# SSH to EC2 and create invoice for EAC Telford
ssh -i ~/Downloads/ReceptionMatebackend.pem ec2-user@18.171.223.223 << 'ENDSSH'
cd ~/portal-frontend/backend

# Create the invoice script
cat > create_eac_invoice.ts << 'ENDJS'
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function createEACInvoice() {
  const garageId = '11061962-d82b-4930-86ec-e704c22c0d57';
  
  try {
    // Fetch garage details
    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      include: {
        agentConfiguration: true,
        calls: {
          where: {
            createdAt: {
              gte: new Date('2026-02-02T00:00:00Z'),
              lt: new Date('2026-03-02T00:00:00Z')
            }
          }
        }
      }
    });

    if (!garage) {
      console.error('❌ Garage not found');
      process.exit(1);
    }

    console.log('✓ Garage found:', garage.name);
    console.log('  Subscription Cost: £' + garage.subscriptionCostGbp);
    console.log('  Included Minutes:', garage.includedMinutes);
    console.log('  Cost Per Minute: £' + garage.costPerMinuteGbp);

    // Calculate call usage for February 2-March 1
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

    console.log('\n📊 Usage Summary:');
    console.log('  Total Calls:', garage.calls.length);
    console.log('  Total Minutes:', totalCallMinutes);
    console.log('  Included Minutes:', garage.includedMinutes);
    console.log('  Overage Minutes:', overageMinutes);
    console.log('  Subscription: £' + garage.subscriptionCostGbp.toFixed(2));
    console.log('  Overage Charges: £' + overageCharges.toFixed(2));
    console.log('  Subtotal: £' + subtotal.toFixed(2));
    console.log('  VAT (20%): £' + vatAmount.toFixed(2));
    console.log('  Total: £' + totalAmount.toFixed(2));

    // Set billing dates - period Feb 2 to Mar 1, due Mar 16
    const billingPeriodStart = new Date('2026-02-02T00:00:00Z');
    const billingPeriodEnd = new Date('2026-03-01T23:59:59Z');
    const dueDate = new Date('2026-03-16T23:59:59Z');

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
    console.log('  Period: Feb 2 - Mar 1, 2026');
    console.log('  Due Date: Mar 16, 2026');
    console.log('  Status:', invoice.status);
    console.log('  Total Amount: £' + totalAmount.toFixed(2));

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

createEACInvoice();
ENDJS

# Run the script
echo "Creating invoice for EAC Telford..."
npx tsx create_eac_invoice.ts

# Clean up
rm create_eac_invoice.ts

ENDSSH
