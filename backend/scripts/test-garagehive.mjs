#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Garage Hive (Business Central) connection smoke test — standalone, no build.
//
// Validates the whole S2S chain end-to-end and tells you EXACTLY what's wrong:
//   token failure  → client id/secret or admin consent
//   403 on a module → permission set not assigned/enabled for that API
//   404 on 'service' → Garage Link Advanced not enabled on the environment
//
// Set these env vars, then run:  node backend/scripts/test-garagehive.mjs
//   GARAGEHIVE_CLIENT_ID       your Entra app's Application (client) ID
//   GARAGEHIVE_CLIENT_SECRET   the client secret value
//   GARAGEHIVE_TENANT_ID       the (sandbox/customer) Entra tenant ID
//   GARAGEHIVE_ENVIRONMENT     the BC environment name (e.g. Sandbox, Production)
//   GARAGEHIVE_COMPANY_ID      optional — only for the company-scoped extra check
// ---------------------------------------------------------------------------

const clientId = process.env.GARAGEHIVE_CLIENT_ID;
const clientSecret = process.env.GARAGEHIVE_CLIENT_SECRET;
const tenantId = process.env.GARAGEHIVE_TENANT_ID;
const environmentName = process.env.GARAGEHIVE_ENVIRONMENT;
const companyId = process.env.GARAGEHIVE_COMPANY_ID;

const missing = Object.entries({
  GARAGEHIVE_CLIENT_ID: clientId,
  GARAGEHIVE_CLIENT_SECRET: clientSecret,
  GARAGEHIVE_TENANT_ID: tenantId,
  GARAGEHIVE_ENVIRONMENT: environmentName,
}).filter(([, v]) => !v).map(([k]) => k);

if (missing.length) {
  console.error(`\n❌ Missing env vars: ${missing.join(', ')}\n`);
  process.exit(1);
}

const apiBase = `https://api.businesscentral.dynamics.com/v2.0/${tenantId}/${environmentName}/api/garageHive`;
// general + phoneIntegration are available on all plans; service needs Garage Link Advanced.
const MODULES = ['general/v2.0', 'phoneIntegration/v2.0', 'service/v2.0'];

async function getToken() {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://api.businesscentral.dynamics.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const desc = (data.error_description || '').split('\n')[0];
    throw new Error(`${res.status} ${data.error || ''} — ${desc}`);
  }
  return data.access_token;
}

async function checkModule(token, mod) {
  const res = await fetch(`${apiBase}/${mod}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    return { ok: false, status: res.status, msg: json?.error?.message || text.slice(0, 180) };
  }
  const entities = (json?.value ?? []).map((e) => e.name).filter(Boolean);
  return { ok: true, status: res.status, count: entities.length, sample: entities.slice(0, 8) };
}

const pad = (s) => String(s).padEnd(22);

(async () => {
  console.log(`\nGarage Hive BC connection test`);
  console.log(`  tenant:      ${tenantId}`);
  console.log(`  environment: ${environmentName}`);
  console.log(`  company:     ${companyId ?? '(not set)'}`);
  console.log(`  client:      ${clientId}\n`);

  let token;
  try {
    token = await getToken();
    console.log('✅ Token acquired (client credentials)\n');
  } catch (e) {
    console.error(`❌ Token failed: ${e.message}`);
    console.error('   → check the client ID/secret, and that this tenant granted admin consent to the app.\n');
    process.exit(1);
  }

  let anyFail = false;
  for (const mod of MODULES) {
    const r = await checkModule(token, mod);
    if (r.ok) {
      console.log(`✅ ${pad(mod)} ${r.count} entities  ${r.sample.length ? '· e.g. ' + r.sample.join(', ') : ''}`);
    } else {
      anyFail = true;
      console.log(`❌ ${pad(mod)} HTTP ${r.status}  ${r.msg}`);
      if (r.status === 401) console.log(`     → token rejected — consent/scope issue.`);
      if (r.status === 403) console.log(`     → permission set not assigned/enabled for this API. Ask Garage Hive which set to assign.`);
      if (r.status === 404) console.log(`     → API not published here${mod.startsWith('service') ? ' — likely Garage Link Advanced is not enabled on this environment.' : '.'}`);
    }
  }

  console.log('');
  if (!anyFail) {
    console.log('🎉 All modules reachable — the connection works end-to-end.');
  } else {
    console.log('⚠️  Some modules failed — the hints above map to what to chase with Garage Hive.');
    process.exitCode = 2;
  }
})();
