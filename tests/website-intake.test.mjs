import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {fixture} from './helpers/api.mjs';
const require=createRequire(import.meta.url),{createApp}=require('../src/app'),{withTenant}=require('../src/db');
const hash=value=>createHash('sha256').update(value).digest('hex');
const stable=value=>Array.isArray(value)?'['+value.map(stable).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}':JSON.stringify(value);
const path='/api/v1/integrations/website-inquiries';
let f,server,base,admin,other,owner,token,config;
before(async()=>{
  f=await fixture();admin=await f.login();other=await f.login('admin','beta');
  owner=(await f.cluster.owner.query("SELECT id FROM users WHERE email='sales@test.invalid'")).rows[0].id;
  token=randomBytes(32).toString('hex');config={siteId:'dongda-website',tenantId:f.tenants.alpha,ownerId:owner,tokenHash:hash(token)};
  server=createServer(createApp({pool:f.pool,environment:'test',websiteIntake:[config]}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));if(f)await f.stop();});
function packet(changes={}){
  const body={schemaVersion:'2026.10.08-v1',siteId:'dongda-website',sourceInquiryId:'DD-'+randomUUID().toUpperCase(),receivedAt:new Date().toISOString(),
    payload:{type:'inquiry',company:'Synthetic website buyer',contact:'Synthetic Contact',email:'website@example.test',phone:'',product:'FIBC',productId:'fibc-bulk-bags',quantity:'1000 pcs',quantityUnit:'',specifications:'Synthetic requirement',notes:'',page:'https://cn-dongda.com/#inquiry',language:'en'},...changes};
  return {...body,digest:hash(stable(body))};
}
async function post(body,headers={}){
  const response=await fetch(base+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':body.sourceInquiryId,...headers},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
}
test('site identity creates a durable source and existing ERP lead exactly once',async()=>{
  const body=packet(),first=await post(body);
  assert.equal(first.status,201);assert.equal(first.body.persisted,true);assert.equal(first.body.protocol,'four-modules-v1');
  assert.equal(first.body.siteId,config.siteId);assert.equal(first.body.sourceInquiryId,body.sourceInquiryId);
  assert.match(first.body.leadId,/^[a-f0-9-]{36}$/);
  const duplicate=await post(body);assert.equal(duplicate.status,200);assert.equal(duplicate.body.duplicate,true);assert.equal(duplicate.body.leadId,first.body.leadId);
  const lead=await admin.api('/leads/'+first.body.leadId);
  assert.equal(lead.status,200);assert.equal(lead.body.owner_id,owner);
  const rows=await withTenant(f.pool,f.tenants.alpha,c=>c.query('SELECT * FROM website_inquiries WHERE source_inquiry_id=$1',[body.sourceInquiryId]));
  assert.equal(rows.rows.length,1);assert.deepEqual(rows.rows[0].payload,body.payload);
  const changed=packet({...body,payload:{...body.payload,notes:'Changed demand'}});
  // Recompute without including an old digest.
  delete changed.digest;changed.digest=hash(stable(changed));
  assert.equal((await post(changed)).status,409);
});
test('service authentication cannot be replaced by cookies, Origin or body tenant/owner fields',async()=>{
  assert.equal((await post(packet(),{authorization:''})).status,401);
  assert.equal((await post(packet(),{authorization:'Bearer wrong'})).status,401);
  assert.equal((await post(packet(),{origin:base})).status,403);
  assert.equal((await post(packet({tenantId:f.tenants.beta}))).status,422);
  const body=packet();body.payload.ownerId=randomUUID();delete body.digest;body.digest=hash(stable(body));
  assert.equal((await post(body)).status,422);
  assert.equal((await post(packet({siteId:'foreign-site'}))).status,403);
  assert.equal((await post(packet({digest:'0'.repeat(64)}))).status,422);
});
test('concurrent retransmission creates one lead and source, not a second CRM',async()=>{
  const body=packet(),results=await Promise.all(Array.from({length:5},()=>post(body)));
  assert.equal(results.filter(r=>r.status===201).length,1);
  assert.ok(results.every(r=>[200,201].includes(r.status)));
  assert.equal(new Set(results.map(r=>r.body.leadId)).size,1);
});
test('source readback requires employee role, tenant and ownership; service token has no employee authority',async()=>{
  const received=await post(packet()),id=received.body.leadId;
  const raw=await fetch(base+'/api/v1/leads/'+id+'/website-source',{headers:{authorization:'Bearer '+token}});
  assert.equal(raw.status,401);
  assert.equal((await other.api('/leads/'+id+'/website-source')).status,404);
  const warehouse=await f.login('warehouse');
  assert.equal((await warehouse.api('/leads/'+id+'/website-source')).status,403);
  const source=await admin.api('/leads/'+id+'/website-source');
  assert.equal(source.status,200);assert.equal(source.body.payload.email,'website@example.test');
  await withTenant(f.pool,f.tenants.beta,async c=>assert.equal((await c.query('SELECT * FROM website_inquiries WHERE lead_id=$1',[id])).rows.length,0));
  await withTenant(f.pool,f.tenants.alpha,async c=>assert.rejects(c.query("UPDATE website_inquiries SET digest='changed' WHERE lead_id=$1",[id]),/permission denied/));
});
test('inactive assigned salesperson prevents admission rather than silently switching owner',async()=>{
  await f.cluster.owner.query('UPDATE memberships SET active=false WHERE tenant_id=$1 AND user_id=$2',[f.tenants.alpha,owner]);
  const body=packet();
  try{const result=await post(body);assert.equal(result.status,409);assert.equal(result.body.error.code,'WEBSITE_INTAKE_NO_SALES_OWNER');}
  finally{await f.cluster.owner.query('UPDATE memberships SET active=true WHERE tenant_id=$1 AND user_id=$2',[f.tenants.alpha,owner]);}
  assert.equal((await post(body)).status,201);
});

test('source persistence failure rolls back the lead and audit before any durable ACK',async()=>{
  const body=packet();
  await f.cluster.owner.query(`CREATE FUNCTION reject_synthetic_source() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic persistence failure'; END $$`);
  await f.cluster.owner.query(`CREATE TRIGGER reject_synthetic_source BEFORE INSERT ON website_inquiries
    FOR EACH ROW EXECUTE FUNCTION reject_synthetic_source()`);
  const before=(await f.cluster.owner.query("SELECT count(*) FROM leads")).rows[0].count;
  const audits=(await f.cluster.owner.query("SELECT count(*) FROM audit_log")).rows[0].count;
  try {
    const result=await post(body);
    assert.equal(result.status,503);assert.notEqual(result.body.persisted,true);
    assert.equal((await f.cluster.owner.query("SELECT count(*) FROM leads")).rows[0].count,before);
    assert.equal((await f.cluster.owner.query("SELECT count(*) FROM audit_log")).rows[0].count,audits);
  } finally {
    await f.cluster.owner.query("DROP TRIGGER reject_synthetic_source ON website_inquiries");
    await f.cluster.owner.query("DROP FUNCTION reject_synthetic_source()");
  }
  assert.equal((await post(body)).status,201);
});

test('source permission follows current assignment and cannot be updated by employee HTTP',async()=>{
  const received=await post(packet()),id=received.body.leadId,sales=await f.login('sales');
  assert.equal((await sales.api('/leads/'+id+'/website-source')).status,200);
  const lead=await admin.api('/leads/'+id);
  const adminId=(await f.cluster.owner.query("SELECT id FROM users WHERE email='admin@test.invalid'")).rows[0].id;
  assert.equal((await admin.api('/leads/'+id,'PATCH',{version:lead.body.version,owner_id:adminId})).status,200);
  assert.equal((await sales.api('/leads/'+id+'/website-source')).status,404);
  assert.equal((await admin.api('/leads/'+id+'/website-source','PATCH',{payload:{notes:'replace'}})).status,405);
  assert.equal((await admin.api('/leads/'+id+'/website-source')).body.payload.notes,'');
});
