import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function createEACInvoice() {
  const garageId = '11061962-d82b-4930-86ec-e704c22c0d57';
  
  // Fetch garage details
  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    include: {
      agentConfiguration: true,
      calls: {
        where: {
          createdAt: {
            gte: new Date('2026-02-02'),
            lt: new Date('2026-03-02')
          }
        }
      }
    }
  });

  if (!garage) {
    console.error('Garage not found');
    return;
  }

  console.log('Garage:', garage.name);
  console.log('Subscription Cost:', garage.subscriptionCostGbp);
  console.log('Included Minutes:', garage.includedMinutes);
  console.log('Cost Per Minute:', garage.costPerMinuteGbp);
  console.log('VAT Rate:', garage.vatRate);

  // Calculate call usage
  const totalCallMinutes = garage.calls.reduce((sum, call) => {
    return sum + Math.ceil(call.durationSeconds / 60);
  }, 0);

  const overageMinutes = Math.max(0, totalCallMinutes - garage.includedMinutes);
  const overageCharges = overageMinutes * garage.costPerMinuteGbp;

  const subtotal = garage.subscriptionCostGbp + overageCharges;
  const vatAmount = subtotal * garage.vatRate;
  const totalAmount = subtotal + vatAmount;

  console.log('\nUsage Summary:');
  console.log('Total Calls:', garage.calls.length);
  console.log('Total Minutes:', totalCallMinutes);
  console.log('Overage Minutes:', overageMinutes);
  console.log('Overage Charges:', overageCharges.toFixed(2));
  console.log('Subtotal:', subtotal.toFixed(2));
  console.log('VAT:', vatAmount.toFixed(2));
  console.log('Total:', totalAmount.toFixed(2));

  // Set billing dates
  const billingPeriodStart = new Date('2026-02-02');
  const billingPeriodEnd = new Date('2026-03-01');
  const dueDate = new Date('2026-03-16'); // 2 weeks after period end

  // Create invoice
  const invoice = await prisma.invoice.create({
    data: {
      garageId,
      periodStart: billingPeriodStart,
      periodEnd: billingPeriodEnd,
      dueDate,
      subscriptionCostGbp: garage.subscriptionCostGbp,
      includedMinutes: garage.includedMinutes,
      totalMinutesUsed: totalCallMinutes,
      overageMinutes,
      costPerMinuteGbp: garage.costPerMinuteGbp,
      overageChargesGbp: overageCharges,
      subtotalGbp: subtotal,
      vatRate: garage.vatRate,
      vatAmountGbp: vatAmount,
      totalAmountGbp: totalAmount,
      status: 'pending',
      currency: 'GBP',
    }
  });

  console.log('\n✅ Invoice created successfully!');
  console.log('Invoice ID:', invoice.id);
  console.log('Period:', billingPeriodStart.toISOString().split('T')[0], 'to', billingPeriodEnd.toISOString().split('T')[0]);
  console.log('Due Date:', dueDate.toISOString().split('T')[0]);
  console.log('Status:', invoice.status);
  console.log('Total Amount:', `£${totalAmount.toFixed(2)}`);

  await prisma.$disconnect();
}

createEACInvoice();
