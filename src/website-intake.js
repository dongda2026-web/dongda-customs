"use strict";
const {createHash,timingSafeEqual}=require("node:crypto");
const {AppError,readJson}=require("./http");
const {withTenant,audit}=require("./db");
const records=require("./records");
const {requireRole,withActor}=require("./auth");
const PATH="/api/v1/integrations/website-inquiries";
const PROTOCOL="four-modules-v1";
const hash=value=>createHash("sha256").update(value).digest("hex");
const object=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const invalid=()=>{throw new AppError(422,"INVALID_WEBSITE_PACKET","Invalid website inquiry packet");};
function exact(value,keys){
  if(!object(value)||Object.keys(value).some(k=>!keys.includes(k)))invalid();
}
function string(value,max,required=false){
  if(typeof value!=="string"||value.length>max||(required&&!value.trim()))invalid();
}
function canonical(value){
  if(value===null||["string","boolean","number"].includes(typeof value))return JSON.stringify(value);
  if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";
  return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+canonical(value[k])).join(",")+"}";
}
function configuration(value=[]){
  if(typeof value==="string"){try{value=JSON.parse(value);}catch{throw new Error("Invalid website intake configuration");}}
  if(!Array.isArray(value)||value.length>100)throw new Error("Invalid website intake configuration");
  const tokens=new Set(),sites=new Set();
  return Object.freeze(value.map(entry=>{
    if(!object(entry)||Object.keys(entry).sort().join(",")!=="ownerId,siteId,tenantId,tokenHash"||
      !/^[a-z0-9][a-z0-9-]{0,79}$/.test(entry.siteId||"")||!/^[a-f0-9]{64}$/.test(entry.tokenHash||""))throw new Error("Invalid website intake configuration");
    records.uuid(entry.tenantId);records.uuid(entry.ownerId);
    if(tokens.has(entry.tokenHash)||sites.has(entry.siteId))throw new Error("Ambiguous website intake identity");
    tokens.add(entry.tokenHash);sites.add(entry.siteId);
    return Object.freeze({...entry});
  }));
}
function specs(value){
  if(typeof value==="string"){string(value,1200);return;}
  if(!object(value)||Object.keys(value).length>30||Buffer.byteLength(JSON.stringify(value))>4800)invalid();
  for(const [key,item]of Object.entries(value)){
    if(!/^[a-zA-Z0-9_-]{1,40}$/.test(key)||["__proto__","constructor","prototype"].includes(key))invalid();
    string(item,120);
  }
}
function custom(value){
  exact(value,["dimensionUnit","length","width","height","material","bagColor","printing","printColors","loadKg","contents","notes","technicalAdvice"]);
  const limits={length:24,width:24,height:24,material:120,bagColor:80,printColors:2,loadKg:24,contents:120,notes:1000};
  for(const [key,max]of Object.entries(limits)){
    string(value[key],max);
    if(["length","width","height","loadKg"].includes(key)&&value[key]&&(!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,3})?$/.test(value[key])||Number(value[key])<=0))invalid();
  }
  if(!["mm","cm"].includes(value.dimensionUnit)||!["not-specified","none","single-color","multi-color","technical-advice"].includes(value.printing)||typeof value.technicalAdvice!=="boolean")invalid();
  if(value.printColors&&(!/^[1-9]\d?$/.test(value.printColors)||Number(value.printColors)>16||value.printing==="none"||(value.printing==="single-color"&&value.printColors!=="1")))invalid();
}
function quantity(value){if(typeof value!=="string"||!/^[1-9]\d{0,9}$/.test(value)||Number(value)>1000000000)invalid();}
function validate(body){
  exact(body,["schemaVersion","siteId","sourceInquiryId","receivedAt","payload","digest"]);
  if(!/^DD-[A-Z0-9-]{8,80}$/.test(body.sourceInquiryId||"")||!/^[a-f0-9]{64}$/.test(body.digest||"")||
    typeof body.receivedAt!=="string"||!Number.isFinite(Date.parse(body.receivedAt))||
    new Date(body.receivedAt).toISOString()!==body.receivedAt)invalid();
  const {digest,...unsigned}=body;
  if(hash(canonical(unsigned))!==digest)invalid();
  const p=body.payload;
  exact(p,["type","company","contact","email","phone","product","productId","quantity","quantityUnit","specifications","notes","language","page","items","destination","deliveryWindow","sampleRequest","customization"]);
  const limits={company:120,contact:120,email:160,phone:80,product:160,productId:80,quantity:80,quantityUnit:16,notes:2400,page:500,language:20};
  for(const [key,max]of Object.entries(limits))string(p[key]??"",max,["company","contact","email","product"].includes(key));
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email))invalid();
  if(!["inquiry","ai-customer-service","quote-calculator","multi-product-rfq","sample-request"].includes(p.type))invalid();
  specs(p.specifications??"");
  const multi=p.type==="multi-product-rfq",sample=p.type==="sample-request",quote=p.type==="quote-calculator";
  if(Buffer.byteLength(JSON.stringify(p))>(multi?65536:16384))invalid();
  if(!multi&&(p.items!==undefined||p.destination!==undefined||p.deliveryWindow!==undefined))invalid();
  if(!sample&&p.sampleRequest!==undefined)invalid();
  if(!quote&&p.customization!==undefined)invalid();
  if(multi){
    if(!Array.isArray(p.items)||p.items.length<1||p.items.length>20||p.productId||p.quantity||p.quantityUnit||p.specifications)invalid();
    string(p.destination,160,true);string(p.deliveryWindow,160);
    const ids=new Set();
    for(const item of p.items){
      exact(item,["lineId","productId","product","quantity","quantityUnit","specifications","customization"]);
      if(!/^line-[a-f0-9-]{36}$/.test(item.lineId||"")||ids.has(item.lineId))invalid();ids.add(item.lineId);
      string(item.productId,80,true);string(item.product,160,true);quantity(item.quantity);
      if(item.quantityUnit!=="pcs"||!object(item.specifications)||item.specifications.qty!==item.quantity)invalid();
      specs(item.specifications);if(item.customization!==undefined)custom(item.customization);
    }
  }
  if(quote){
    quantity(p.quantity);string(p.productId,80,true);
    if(p.quantityUnit!=="pcs"||!object(p.specifications)||p.specifications.qty!==p.quantity)invalid();
    if(p.customization!==undefined)custom(p.customization);
  }
  if(sample){
    if(p.quantity||p.quantityUnit||p.specifications)invalid();string(p.productId,80,true);
    const s=p.sampleRequest,limits={purpose:800,quantity:80,expectedPurchaseQuantity:80,requirements:1200,recipientName:120,recipientPhone:80,country:80,city:120,address:500,postalCode:40};
    exact(s,[...Object.keys(limits),"costTermsAcknowledged"]);
    for(const [key,max]of Object.entries(limits))string(s[key],max,["purpose","quantity","recipientName","recipientPhone","country","city","address"].includes(key));
    quantity(s.quantity);if(s.expectedPurchaseQuantity)quantity(s.expectedPurchaseQuantity);
    if(s.costTermsAcknowledged!==true)invalid();
  }
  const customized=p.customization||p.items?.some(item=>item.customization);
  const version=customized?"2026.10.08-v4":sample?"2026.10.08-v3":multi?"2026.10.08-v2":"2026.10.08-v1";
  if(body.schemaVersion!==version)invalid();
  return body;
}
async function receive(pool,config,req,requestId){
  if(req.method!=="POST")throw new AppError(405,"METHOD_NOT_ALLOWED","Use POST");
  if(req.headers.origin||req.headers.cookie||req.headers["sec-fetch-site"])throw new AppError(403,"SERVICE_ONLY","Server identity required");
  const token=/^Bearer ([A-Za-z0-9._~-]{32,512})$/.exec(req.headers.authorization||"")?.[1];
  if(!token)throw new AppError(401,"INVALID_SERVICE_IDENTITY","Service authentication required");
  const digest=Buffer.from(hash(token),"hex");
  const identity=config.find(item=>timingSafeEqual(Buffer.from(item.tokenHash,"hex"),digest));
  if(!identity)throw new AppError(401,"INVALID_SERVICE_IDENTITY","Service authentication required");
  const body=validate(await readJson(req,72*1024));
  if(body.siteId!==identity.siteId)throw new AppError(403,"SITE_MISMATCH","Site identity does not match");
  if(req.headers["idempotency-key"]!==body.sourceInquiryId)invalid();
  return withTenant(pool,identity.tenantId,async c=>{
    const tenant=(await c.query("SELECT 1 FROM tenants WHERE id=$1 AND active",[identity.tenantId])).rows[0];
    if(!tenant)throw new AppError(403,"INACTIVE_TENANT","Tenant unavailable");
    const rate=(await c.query(`INSERT INTO website_intake_windows(tenant_id,site_id,attempts) VALUES ($1,$2,1)
      ON CONFLICT(tenant_id,site_id) DO UPDATE SET
      attempts=CASE WHEN website_intake_windows.window_start<now()-interval '1 minute' THEN 1 ELSE website_intake_windows.attempts+1 END,
      window_start=CASE WHEN website_intake_windows.window_start<now()-interval '1 minute' THEN now() ELSE website_intake_windows.window_start END
      RETURNING attempts`,[identity.tenantId,identity.siteId])).rows[0];
    if(rate.attempts>600)throw new AppError(429,"WEBSITE_RATE_LIMIT","Retry later");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${identity.tenantId}:${identity.siteId}:${body.sourceInquiryId}`]);
    const existing=(await c.query("SELECT lead_id,digest FROM website_inquiries WHERE tenant_id=$1 AND site_id=$2 AND source_inquiry_id=$3",
      [identity.tenantId,identity.siteId,body.sourceInquiryId])).rows[0];
    const ack=(id,duplicate)=>({status:duplicate?200:201,body:{ok:true,persisted:true,protocol:PROTOCOL,siteId:identity.siteId,sourceInquiryId:body.sourceInquiryId,leadId:id,duplicate}});
    if(existing){
      if(existing.digest!==body.digest)throw new AppError(409,"WEBSITE_IDEMPOTENCY_CONFLICT","Source identity already contains different data");
      return ack(existing.lead_id,true);
    }
    const owner=(await c.query(`SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.active AND u.active AND m.role IN ('sales','admin')`,
    [identity.tenantId,identity.ownerId])).rows[0];
    if(!owner)throw new AppError(409,"WEBSITE_INTAKE_NO_SALES_OWNER","Assigned salesperson unavailable");
    const p=body.payload,actor={tenantId:identity.tenantId,userId:null,requestId};
    const lead=await records.insert(c,actor,"leads",{name:p.company,contact:`${p.contact} | ${p.email}`,
      need:`Website ${p.type}: ${p.product}${p.quantity?" | "+p.quantity:""}\n${p.notes||""}`,
      owner_id:identity.ownerId});
    await c.query(`INSERT INTO website_inquiries(tenant_id,site_id,source_inquiry_id,lead_id,schema_version,digest,received_at,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[identity.tenantId,identity.siteId,body.sourceInquiryId,lead.id,body.schemaVersion,body.digest,body.receivedAt,p]);
    await audit(c,actor,"website.receive","lead",lead.id,{siteId:identity.siteId,schemaVersion:body.schemaVersion});
    return ack(lead.id,false);
  });
}
async function readSource(pool,actor,id){
  requireRole(actor,"sales","social","auditor");records.uuid(id);
  return withActor(pool,actor,async c=>{
    const row=(await c.query(`SELECT s.*,l.owner_id FROM website_inquiries s JOIN leads l ON l.tenant_id=s.tenant_id AND l.id=s.lead_id
      WHERE s.tenant_id=$1 AND s.lead_id=$2`,[actor.tenantId,id])).rows[0];
    if(!row||(!["admin","auditor"].includes(actor.role)&&row.owner_id!==actor.userId))throw new AppError(404,"NOT_FOUND","Source not found");
    return {siteId:row.site_id,sourceInquiryId:row.source_inquiry_id,schemaVersion:row.schema_version,receivedAt:row.received_at,payload:row.payload};
  });
}
module.exports={PATH,PROTOCOL,configuration,validate,receive,readSource};
