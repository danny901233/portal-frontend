#!/usr/bin/env node

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function analyzeCallLogs() {
  console.log('🔍 Analyzing Call Logs...\n');

  try {
    // Total calls
    const totalCalls = await prisma.call.count();
    console.log(`📊 Total Calls: ${totalCalls}\n`);

    // Call type breakdown
    const callTypes = await prisma.call.groupBy({
      by: ['callType'],
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } }
    });
    
    console.log('📞 Call Types:');
    callTypes.forEach(({ callType, _count }) => {
      const percentage = (((_count.id / totalCalls) * 100).toFixed(1));
      console.log(`  ${callType.padEnd(20)} ${_count.id.toString().padStart(5)} calls (${percentage}%)`);
    });
    console.log();

    // Booking confirmation rate
    const confirmedBookings = await prisma.call.count({
      where: { confirmedBooking: true }
    });
    const bookingRate = ((confirmedBookings / totalCalls) * 100).toFixed(1);
    console.log(`✅ Confirmed Bookings: ${confirmedBookings}/${totalCalls} (${bookingRate}%)\n`);

    // Booking category breakdown
    const bookingCategories = await prisma.call.groupBy({
      by: ['confirmedBookingCategory'],
      _count: { id: true },
      where: { confirmedBookingCategory: { not: null } },
      orderBy: { _count: { id: 'desc' } }
    });
    
    if (bookingCategories.length > 0) {
      console.log('📋 Booking Categories:');
      bookingCategories.forEach(({ confirmedBookingCategory, _count }) => {
        console.log(`  ${(confirmedBookingCategory || 'unknown').padEnd(20)} ${_count.id.toString().padStart(5)} bookings`);
      });
      console.log();
    }

    // Revenue captured
    const revenueStats = await prisma.call.aggregate({
      _sum: { capturedRevenue: true },
      _avg: { capturedRevenue: true },
      _max: { capturedRevenue: true },
      where: { capturedRevenue: { not: null } }
    });
    
    if (revenueStats._sum.capturedRevenue) {
      console.log('💰 Revenue:');
      console.log(`  Total:   £${revenueStats._sum.capturedRevenue.toFixed(2)}`);
      console.log(`  Average: £${(revenueStats._avg.capturedRevenue || 0).toFixed(2)}`);
      console.log(`  Max:     £${(revenueStats._max.capturedRevenue || 0).toFixed(2)}`);
      console.log();
    }

    // Duration statistics
    const durationStats = await prisma.call.aggregate({
      _avg: { durationSeconds: true },
      _max: { durationSeconds: true },
      _min: { durationSeconds: true }
    });
    
    console.log('⏱️  Call Duration:');
    console.log(`  Average: ${Math.round(durationStats._avg.durationSeconds || 0)} seconds (${Math.round((durationStats._avg.durationSeconds || 0) / 60)} min)`);
    console.log(`  Max:     ${durationStats._max.durationSeconds || 0} seconds (${Math.round((durationStats._max.durationSeconds || 0) / 60)} min)`);
    console.log(`  Min:     ${durationStats._min.durationSeconds || 0} seconds`);
    console.log();

    // Recent calls with details
    console.log('📝 Recent Call Summaries (Last 20):');
    console.log('─'.repeat(100));
    
    const recentCalls = await prisma.call.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        callType: true,
        customerName: true,
        confirmedBooking: true,
        confirmedBookingCategory: true,
        summary: true,
        durationSeconds: true,
        createdAt: true,
        bookingDetails: true
      }
    });

    recentCalls.forEach((call, idx) => {
      console.log(`\n${idx + 1}. ${call.callType.toUpperCase()} | ${call.customerName || 'Unknown'} | ${Math.round(call.durationSeconds / 60)}min | ${call.createdAt.toISOString().split('T')[0]}`);
      console.log(`   Booking: ${call.confirmedBooking ? '✅ ' + (call.confirmedBookingCategory || 'unknown') : '❌ No booking'}`);
      if (call.summary) {
        console.log(`   Summary: ${call.summary.substring(0, 150)}${call.summary.length > 150 ? '...' : ''}`);
      }
      if (call.bookingDetails) {
        console.log(`   Details: ${call.bookingDetails.substring(0, 100)}${call.bookingDetails.length > 100 ? '...' : ''}`);
      }
    });
    
    console.log('\n' + '─'.repeat(100));
    
    // Common customer names (to identify test calls)
    console.log('\n👤 Most Frequent Caller Names:');
    const nameGroups = await prisma.call.groupBy({
      by: ['customerName'],
      _count: { id: true },
      where: { customerName: { not: null } },
      orderBy: { _count: { id: 'desc' } },
      take: 10
    });
    
    nameGroups.forEach(({ customerName, _count }) => {
      console.log(`  ${(customerName || 'Unknown').padEnd(30)} ${_count.id} calls`);
    });

    console.log('\n✅ Analysis complete!');

  } catch (error) {
    console.error('❌ Error analyzing calls:', error);
  } finally {
    await prisma.$disconnect();
  }
}

analyzeCallLogs();
