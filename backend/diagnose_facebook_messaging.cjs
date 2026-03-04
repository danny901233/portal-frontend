require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const prisma = new PrismaClient();

async function main() {
  console.log('🔍 Facebook Messaging Diagnostic Tool\n');
  console.log('=' .repeat(60));

  // Check if garage ID provided as argument
  let garageId = process.argv[2];

  // If no garage ID provided, find any garage with a Facebook connection
  if (!garageId) {
    const anyConnection = await prisma.socialMediaConnection.findFirst({
      where: { platform: 'facebook' },
      select: { garageId: true },
    });

    if (anyConnection) {
      garageId = anyConnection.garageId;
      console.log('Using garage from Facebook connection:', garageId);
    } else {
      // Just use first garage with messaging access
      const anyGarage = await prisma.garage.findFirst({
        where: { hasMessagingAccess: true },
        select: { id: true, name: true },
      });

      if (anyGarage) {
        garageId = anyGarage.id;
        console.log('No Facebook connection found. Using first garage:', anyGarage.name);
      } else {
        console.log('❌ No garages found with messaging access!');
        return;
      }
    }
    console.log('');
  }

  // 1. Check environment variables
  console.log('\n1️⃣  ENVIRONMENT VARIABLES');
  console.log('-'.repeat(60));
  console.log('META_APP_ID:', process.env.META_APP_ID ? '✓ Set' : '❌ Missing');
  console.log('META_APP_SECRET:', process.env.META_APP_SECRET ? '✓ Set' : '❌ Missing');
  console.log('META_REDIRECT_URI:', process.env.META_REDIRECT_URI || '❌ Missing');
  console.log('META_WEBHOOK_VERIFY_TOKEN:', process.env.META_WEBHOOK_VERIFY_TOKEN || '❌ Missing');
  console.log('FRONTEND_URL:', process.env.FRONTEND_URL || '❌ Missing');

  // 2. Check garage setup
  console.log('\n2️⃣  GARAGE CONFIGURATION');
  console.log('-'.repeat(60));
  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: { id: true, name: true, hasMessagingAccess: true },
  });

  if (!garage) {
    console.log('❌ Garage not found!');
    return;
  }

  console.log('Garage Name:', garage.name);
  console.log('Has Messaging Access:', garage.hasMessagingAccess ? '✓ Yes' : '❌ No');

  // 3. Check Facebook connection
  console.log('\n3️⃣  FACEBOOK CONNECTION');
  console.log('-'.repeat(60));
  const connection = await prisma.socialMediaConnection.findFirst({
    where: { garageId, platform: 'facebook' },
  });

  if (!connection) {
    console.log('❌ No Facebook connection found in database!');
    console.log('\nPossible causes:');
    console.log('  - OAuth callback failed to save connection');
    console.log('  - No Facebook page found during OAuth');
    console.log('  - Database error during save');
    console.log('\nAction: Try connecting again with backend logs visible');
  } else {
    console.log('✓ Connection found');
    console.log('  Connection ID:', connection.id);
    console.log('  Page ID:', connection.pageId || '❌ Missing!');
    console.log('  Is Active:', connection.isActive);
    console.log('  Has Access Token:', !!connection.accessToken);
    console.log('  Created:', connection.createdAt);
    console.log('  Updated:', connection.updatedAt);

    // Test the access token
    if (connection.accessToken && connection.pageId) {
      console.log('\n4️⃣  TESTING ACCESS TOKEN');
      console.log('-'.repeat(60));
      try {
        const response = await axios.get(`https://graph.facebook.com/v18.0/${connection.pageId}`, {
          params: {
            fields: 'id,name,access_token',
            access_token: connection.accessToken,
          },
        });
        console.log('✓ Access token is valid');
        console.log('  Page Name:', response.data.name);
        console.log('  Page ID:', response.data.id);
      } catch (error) {
        console.log('❌ Access token test failed:');
        if (error.response) {
          console.log('  Error:', error.response.data.error?.message || error.message);
          console.log('  Type:', error.response.data.error?.type);
        } else {
          console.log('  Error:', error.message);
        }
      }

      // Check webhook subscriptions
      console.log('\n5️⃣  WEBHOOK SUBSCRIPTIONS');
      console.log('-'.repeat(60));
      try {
        const response = await axios.get(`https://graph.facebook.com/v18.0/${connection.pageId}/subscribed_apps`, {
          params: {
            access_token: connection.accessToken,
          },
        });

        if (response.data.data && response.data.data.length > 0) {
          console.log('✓ App is subscribed to page');
          response.data.data.forEach(app => {
            console.log('  App ID:', app.id);
            console.log('  Subscribed Fields:', app.subscribed_fields?.join(', ') || 'None');
          });

          // Check if 'messages' is in subscribed fields
          const hasMessages = response.data.data.some(app =>
            app.subscribed_fields?.includes('messages')
          );

          if (hasMessages) {
            console.log('  ✓ "messages" field is subscribed');
          } else {
            console.log('  ❌ "messages" field NOT subscribed!');
            console.log('\nAction: Subscribe your page to the "messages" field in Meta dashboard');
          }
        } else {
          console.log('❌ No app subscriptions found!');
          console.log('\nAction: Subscribe your app to the Facebook page in Meta dashboard');
        }
      } catch (error) {
        console.log('❌ Failed to check webhook subscriptions:');
        if (error.response) {
          console.log('  Error:', error.response.data.error?.message || error.message);
        } else {
          console.log('  Error:', error.message);
        }
      }
    }
  }

  // 4. Check conversations
  console.log('\n6️⃣  FACEBOOK CONVERSATIONS');
  console.log('-'.repeat(60));
  const conversations = await prisma.chatConversation.findMany({
    where: { garageId, platform: 'facebook' },
    include: {
      messages: {
        take: 1,
        orderBy: { createdAt: 'desc' },
      },
    },
    orderBy: { lastMessageAt: 'desc' },
    take: 5,
  });

  console.log(`Total conversations: ${conversations.length}`);
  if (conversations.length > 0) {
    console.log('\nMost recent conversations:');
    conversations.forEach((conv, i) => {
      console.log(`  ${i + 1}. ID: ${conv.id}`);
      console.log(`     Status: ${conv.status}`);
      console.log(`     Last Message: ${conv.lastMessageAt}`);
      console.log(`     Unread: ${conv.unreadCount}`);
    });
  } else {
    console.log('No conversations found (no messages have been received yet)');
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📋 SUMMARY');
  console.log('='.repeat(60));

  if (!connection) {
    console.log('\n❌ ISSUE: No Facebook connection in database');
    console.log('\nNext steps:');
    console.log('1. Ensure backend server is running');
    console.log('2. Check backend logs for errors');
    console.log('3. Try connecting Facebook again through the UI');
    console.log('4. Watch for logs showing "[OAuth] Connection created"');
  } else if (!connection.pageId || !connection.accessToken) {
    console.log('\n❌ ISSUE: Connection exists but missing critical data');
    console.log('\nNext steps:');
    console.log('1. Disconnect and reconnect Facebook');
    console.log('2. Ensure you select a Facebook Page during OAuth');
  } else {
    console.log('\n✓ Connection configured correctly');
    console.log('\nTo receive messages, ensure:');
    console.log('1. Webhook is configured in Meta dashboard');
    console.log('   URL: https://portal.receptionmate.co.uk/api/webhooks/meta-facebook');
    console.log('   Verify Token: test_token_123');
    console.log('2. Page is subscribed to your app');
    console.log('3. App has "messages" webhook subscription');
    console.log('4. Send a test message to your Facebook page');
  }

  console.log('\n');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
