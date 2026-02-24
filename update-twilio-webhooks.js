const ONBOARDING_SERVICE_URL = 'http://localhost:5000';
const ONBOARDING_SECRET = 'ob-secret-7h9k2m4p6q8r1s3t5v';

const garages = [
  { id: "c9a7d31d-3f5b-4c24-ab1d-138594a9fc31", name: "Mcdowells", twilioNumber: "441652242433" },
  { id: "cd0610c6-0b4e-433b-866b-2af0ad0b20ac", name: "In'n'out Autocentres Norwich", twilioNumber: "441603249593" },
  { id: "3ccd0060-75ec-4cf5-86d9-709fb5700f9d", name: "In'n'out Autocentres Spalding", twilioNumber: "441775668867" },
  { id: "ef68c8ca-f41e-4baa-b190-841c582a6210", name: "In'n'out Autocentres Basingstoke", twilioNumber: "44 1256 438916" },
  { id: "1949802d-a236-4037-8a0e-058177728ae2", name: "In'n'out Autocentres Erith", twilioNumber: "44 1322 952591" },
  { id: "948f6573-4c9c-42e6-ba1e-7fb7582d4a66", name: "MPB 4x4", twilioNumber: "+44 1535 286997" },
  { id: "f1c6d134-424e-4d6b-b64d-7c99236b3ce0", name: "Boam Engineering Ltd", twilioNumber: "+441452227986" },
  { id: "46144074-a004-455a-8eb2-f418890a2d8c", name: "tester", twilioNumber: "+441794330941" },
  { id: "399eee1e-6b5d-45c3-8923-9d8e6b5e8eff", name: "Xpress Garage Falmouth", twilioNumber: "+441156479170" },
  { id: "a47e34cb-44d1-4894-9d3e-7fc1631cab4a", name: "Promotive", twilioNumber: "+441723674065" },
  { id: "6a6b0785-0c4f-41be-b5f6-f8542e9b7cc1", name: "test garage go high level 2", twilioNumber: "+441924943996" },
  { id: "1ed6655a-0d2b-48a9-a362-57cefeeb0cb0", name: "test garage go high level 2", twilioNumber: "+441514534719" },
  { id: "7b8c1884-fd4b-4db3-9a38-35fb5f064760", name: "St Johns Garage", twilioNumber: "+441283368596" },
  { id: "e1a3fa3b-aced-40d1-84e7-e99b30fda058", name: "blair atholl garage", twilioNumber: "+441325523134" },
  { id: "fa03c455-b651-4038-8f8d-41ffd11066ab", name: "Delisle Mechanical Engineers", twilioNumber: "44 1442 941538" },
  { id: "e46a2392-db99-4d7a-a91e-b6c8166e2148", name: "Holmer Green Garage", twilioNumber: "+44 1494 302759" },
  { id: "67461c5f-7cfd-404e-adc9-732dae092e36", name: "demo account", twilioNumber: "+44 333 016 5964" },
  { id: "11061962-d82b-4930-86ec-e704c22c0d57", name: "EAC Telford Halesfield", twilioNumber: "441952980955" },
  { id: "5cc2782c-233b-4aff-95e3-340084c0b62c", name: "ADS Automotive", twilioNumber: "441772211508" },
  { id: "24847ed4-b0fd-4f9c-9485-dd86f176aa52", name: "ELDON STREET GARAGE", twilioNumber: "441772211647" },
  { id: "7a407dab-fc7e-4781-9286-0ccbff1cd6ee", name: "Elite Landrover", twilioNumber: "+441264317950" },
  { id: "861a663d-9d70-4cf4-96e9-ab7493084adc", name: "null", twilioNumber: "+441917436714" },
  { id: "9d28ca87-05be-4f3a-ab03-aeee2d3f64ba", name: "test garage go high level 2", twilioNumber: "+441344951095" },
  { id: "96eb7965-c234-4439-a5be-c6c6a27071d9", name: "test garage go high level 2", twilioNumber: "+441615245448" },
  { id: "4f73c11e-53f5-4591-8531-00717d099f17", name: "repayr my car", twilioNumber: "44 1292 439409" },
  { id: "2936b2ab-6f2f-4871-997a-dea4105d1d1f", name: "TWA Autoelectrics", twilioNumber: "+441284339591" },
  { id: "cc2189f5-95d3-440c-8d92-4dc78b210335", name: "Caldwell and dempster ", twilioNumber: "+441514532785" },
  { id: "d51dfa55-15d0-4d60-ad81-c675579d16f6", name: "ReceptionMate Branch", twilioNumber: "+44 333 370 1610" },
  { id: "d39253cf-0909-4c4b-8853-7d1bdf40a5df", name: "RPM Malvern Ltd", twilioNumber: "+441204961311" }
];

async function updateWebhook(garage) {
  try {
    console.log(`\n🔧 Updating ${garage.name} (${garage.twilioNumber})...`);
    
    const response = await fetch(`${ONBOARDING_SERVICE_URL}/provision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-onboarding-secret': ONBOARDING_SECRET
      },
      body: JSON.stringify({
        garageId: garage.id,
        garageName: garage.name,
        branchName: null,
        contactEmail: null,
        contactPhone: null,
        twilioNumber: garage.twilioNumber,
        agentName: null,
        triggeredAt: new Date().toISOString()
      })
    });

    const data = await response.json();
    
    if (response.ok) {
      console.log(`✅ Success: ${garage.name}`);
    } else {
      console.error(`❌ Failed: ${garage.name} - ${data.error || data.message}`);
    }
    
    return { garage: garage.name, success: response.ok, data };
  } catch (error) {
    console.error(`❌ Error updating ${garage.name}:`, error.message);
    return { garage: garage.name, success: false, error: error.message };
  }
}

async function updateAllWebhooks() {
  console.log(`📞 Updating Twilio webhooks for ${garages.length} garages...\n`);
  console.log(`Using onboarding service at: ${ONBOARDING_SERVICE_URL}`);
  console.log(`This will update all webhooks to point to the new IP address.\n`);
  
  const results = [];
  
  // Update one at a time to avoid overwhelming the service
  for (const garage of garages) {
    const result = await updateWebhook(garage);
    results.push(result);
    // Small delay between updates
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  // Summary
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  console.log(`\n\n📊 Summary:`);
  console.log(`   ✅ Successful: ${successful}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   📝 Total: ${results.length}`);
  
  if (failed > 0) {
    console.log(`\n❌ Failed garages:`);
    results.filter(r => !r.success).forEach(r => {
      console.log(`   - ${r.garage}: ${r.data?.error || r.error}`);
    });
  }
}

updateAllWebhooks().catch(console.error);
