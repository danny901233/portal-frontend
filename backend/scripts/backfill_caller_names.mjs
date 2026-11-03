/**
 * Bring portal call records up to date from Garage Hive's phonebook: fill the blanks, correct the
 * spellings, and leave alone anything that looks like a different person. Dry run unless --apply.
 */
import { PrismaClient } from '@prisma/client';
import { lookupPhonebookByPhone, mergeCallerName } from '../dist/services/garageHiveBc.js';
const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient();
const creds={tenantId:'e4d1961e-0304-4eda-ac54-978ab0c70bae',environmentName:'Production',
  companyId:'96269348-2a33-ef11-8409-00224807b512',
  clientId:process.env.GARAGEHIVE_CLIENT_ID,clientSecret:process.env.GARAGEHIVE_CLIENT_SECRET};
const mask=n=>{const s=String(n||'');return s.length>4?`${'•'.repeat(s.length-4)}${s.slice(-4)}`:'••••';};

const garages = await prisma.garage.findMany({ where:{ OR:[
  {name:{contains:'ecotest',mode:'insensitive'}},
  {name:{contains:'great hollands',mode:'insensitive'}},
  {name:{contains:'JDK',mode:'insensitive'}}]}, select:{id:true,name:true}});

console.log(`  mode: ${APPLY?'APPLY':'dry run'}\n`);
let filled=0, corrected=0, untouched=0, calls=0;
const exFill=[], exFix=[];

for (const g of garages) {
  const rows = await prisma.call.findMany({
    where:{ garageId:g.id, customerPhone:{ not:null } },
    select:{ id:true, customerPhone:true, customerName:true }, orderBy:{ createdAt:'desc' }});
  const byNumber = new Map();
  for (const r of rows) {
    if(!byNumber.has(r.customerPhone)) byNumber.set(r.customerPhone,{ids:[],name:''});
    const e = byNumber.get(r.customerPhone);
    e.ids.push(r.id);
    if(!e.name && String(r.customerName||'').trim()) e.name = r.customerName.trim();
  }
  for (const [phone,{ids,name}] of byNumber) {
    const hit = await lookupPhonebookByPhone(creds, phone).catch(()=>null);
    if(!hit?.name) { untouched++; continue; }
    const merged = mergeCallerName(name, hit.name);
    if(!merged) { untouched++; continue; }
    const wasBlank = !name;
    if(wasBlank){ filled++; if(exFill.length<4) exFill.push(`${mask(phone)}  (blank) → "${merged}"`); }
    else { corrected++; if(exFix.length<6) exFix.push(`${mask(phone)}  "${name}" → "${merged}"`); }
    calls += ids.length;
    if(APPLY) await prisma.call.updateMany({ where:{ id:{ in:ids } }, data:{ customerName: merged }});
  }
}
console.log(`  blanks filled      ${filled}`);
console.log(`  names corrected    ${corrected}`);
console.log(`  left alone         ${untouched}`);
console.log(`  call rows affected ${calls}\n`);
console.log('  filled:');  for(const s of exFill) console.log(`    ${s}`);
console.log('  corrected:'); for(const s of exFix) console.log(`    ${s}`);
if(!APPLY) console.log('\n  dry run — pass --apply to write.');
await prisma.$disconnect();
