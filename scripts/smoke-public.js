import "dotenv/config";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { getConfig } from "../src/config.js";

const config=getConfig(),db=new Database(config.DB_PATH,{fileMustExist:true}),base=process.env.SMOKE_BASE_URL?.trim()||`http://127.0.0.1:${config.PORT}`;
const secretValues=[config.ADMIN_TOKEN,config.WALLET_ENC_KEY,config.MEMWAL_KEY,config.TATUM_API_KEY,process.env.GROQ_API_KEY].filter(Boolean);
const mask=value=>{for(const secret of secretValues)value=value.split(secret).join("[REDACTED]");return value.replace(/\b(?:plk_[a-f0-9]{64}|(?:0x)?[a-f0-9]{64})\b/gi,"[REDACTED]");};
let failed=false;
function step(name,fn){const start=Date.now();try{const detail=fn();if(detail&&typeof detail.then==="function")return detail.then(value=>{console.log(`PASS ${name} (${Date.now()-start} ms)${value?`: ${value}`:""}`);},error=>{failed=true;console.log(`FAIL ${name} (${Date.now()-start} ms): ${mask(String(error?.message??error))}`);});const value=detail;console.log(`PASS ${name} (${Date.now()-start} ms)${value?`: ${value}`:""}`);}catch(error){failed=true;console.log(`FAIL ${name} (${Date.now()-start} ms): ${mask(String(error?.message??error))}`);}}
async function fetchJson(path,token,method="GET",body){const response=await fetch(base+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{ }),...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});const text=await response.text();let parsedBody;try{parsedBody=text?JSON.parse(text):null;}catch{parsedBody=text;}return {status:response.status,body:parsedBody};}
function ensure(condition,message){if(!condition)throw new Error(message);}
const privateAgent=db.prepare("SELECT id FROM agents WHERE public=0 ORDER BY created_at DESC LIMIT 1").get();
await step("public system endpoint exposes network and Walrus counts",async()=>{const r=await fetchJson("/public/v1/system");ensure(r.status===200&&typeof r.body.network==="string"&&r.body.walrus&&typeof r.body.walrus.memories_stored==="number"&&typeof r.body.walrus.total?.memories_stored==="number","system response is missing required public fields");});
await step("private agent is 404 on every public agent route before publication",async()=>{ensure(Boolean(privateAgent),"database has no private agent for the visibility check");for(const suffix of ["","/timeline","/reviews","/requests","/verdicts","/scores","/suggestions","/transactions","/lessons"]){const r=await fetchJson(`/public/v1/agents/${privateAgent.id}${suffix}`);ensure(r.status===404,`${suffix||"/"} returned HTTP ${r.status}`);}});
await step("demo:publish selects a qualifying research agent",()=>{const result=spawnSync(process.platform==="win32"?"npm.cmd":"npm",["run","demo:publish"],{encoding:"utf8",shell:process.platform==="win32",env:{...process.env,DEMO_ACTIONS_ENABLED:"false"}});if(result.status!==0)throw new Error(mask((result.stderr||result.stdout||"publish command failed").trim()));const match=/Published agent (\S+) \(([^\r\n]+)\); demo_actionable=false/.exec(result.stdout);ensure(Boolean(match),`publish output did not identify an agent: ${mask(result.stdout.trim())}`);return `published ${match[1]}`;});
const published=db.prepare("SELECT id,name FROM agents WHERE public=1 AND name LIKE 'research-agent%' AND EXISTS(SELECT 1 FROM upgrade_requests r WHERE r.agent_id=agents.id AND r.status='executed') AND EXISTS(SELECT 1 FROM upgrade_verdicts v WHERE v.agent_id=agents.id) ORDER BY created_at DESC LIMIT 1").get();
const publicPaths=published?["/public/v1/system","/public/v1/agents",`/public/v1/agents/${published.id}`,`/public/v1/agents/${published.id}/timeline`,`/public/v1/agents/${published.id}/reviews`,`/public/v1/agents/${published.id}/requests`,`/public/v1/agents/${published.id}/verdicts`,`/public/v1/agents/${published.id}/scores`,`/public/v1/agents/${published.id}/suggestions`,`/public/v1/agents/${published.id}/transactions`,`/public/v1/agents/${published.id}/lessons`,"/public/v1/tatum/activity"]:[];
await step("published research agent returns data on all public routes and timeline has blob memories",async()=>{ensure(Boolean(published),"published research agent not found after publish command");for(const path of publicPaths){const r=await fetchJson(path);ensure(r.status===200,`${path} returned HTTP ${r.status}`);}const detail=await fetchJson(`/public/v1/agents/${published.id}`),timeline=await fetchJson(`/public/v1/agents/${published.id}/timeline?limit=100`);ensure(detail.body.id===published.id&&Array.isArray(detail.body.capabilities)&&detail.body.balance!==undefined,"agent detail is incomplete");ensure(timeline.body.items.some(item=>item.type==="memory"&&item.blob_id),"timeline has no memory with a blob id");});
await step("public response leak scan",async()=>{ensure(Boolean(published),"no published agent");const responses=[];for(const path of publicPaths){const r=await fetchJson(path);ensure(r.status===200,`${path} returned HTTP ${r.status}`);responses.push(JSON.stringify(r.body));}const all=responses.join("\n");for(const secret of secretValues)ensure(!all.includes(secret),"public response contains a configured secret");for(const marker of ["api_key","enc_key","plk_","suiprivkey"])ensure(!all.toLowerCase().includes(marker.toLowerCase()),`public response contains forbidden marker ${marker}`);});
await step("admin-only agent listing requires authentication",async()=>{const r=await fetchJson("/v1/agents");ensure([401,403].includes(r.status),`unauthenticated GET /v1/agents returned ${r.status}`);});
const guardEvents=[
  // finance_qa scenario from scripts/smoke-block3.js: 8 outcomes in 3 sessions, 4 user_corrected with gap_hint knowledge.
  { type: "task_completed", task_category: "finance_qa", session_id: "g1-finance", summary: "Answered a VAT question from the ledger." },
  { type: "user_corrected", task_category: "finance_qa", session_id: "g1-finance", summary: "Used the old VAT rate.", correction: "the 2026 rate is 21 percent", details: { gap_hint: "knowledge" } },
  { type: "user_corrected", task_category: "finance_qa", session_id: "g1-finance", summary: "Mixed up two vendor invoices.", correction: "invoice 118 is Acme, not Globex", details: { gap_hint: "knowledge" } },
  { type: "task_completed", task_category: "finance_qa", session_id: "g2-finance", summary: "Reconciled the weekly expenses." },
  { type: "task_completed", task_category: "finance_qa", session_id: "g2-finance", summary: "Explained a cash-flow line item." },
  { type: "user_corrected", task_category: "finance_qa", session_id: "g2-finance", summary: "Reported the wrong fiscal quarter.", correction: "we are in Q4 2026", details: { gap_hint: "knowledge" } },
  { type: "task_completed", task_category: "finance_qa", session_id: "g3-finance", summary: "Summarised the receivable ageing." },
  { type: "user_corrected", task_category: "finance_qa", session_id: "g3-finance", summary: "Guessed the FX rate instead of looking it up.", correction: "use the rate from the daily feed", details: { gap_hint: "knowledge" } },
  { type: "capability_missing", task_category: "finance_qa", session_id: "g3-finance", summary: "Could not open the accounting export format.", details: { missing: "accounting export parser" } },
];
await step("demo approve/reject is globally disabled while DEMO_ACTIONS_ENABLED is off (throwaway agent)",async()=>{
  const guardNow=Date.now(),guardBase=guardNow-120_000,guardRandom=Math.random().toString(36).slice(2,9);
  let guardClock=0,guarded=null;
  const guardPath=(suffix)=>`/v1/agents/${encodeURIComponent(guarded.agent_id)}${suffix}`;
  const setVisibility=async(publicFlag,demoActionable)=>{const r=await fetchJson(guardPath("/visibility"),config.ADMIN_TOKEN,"PUT",{public:publicFlag,demo_actionable:demoActionable});ensure(r.status===200,`visibility update returned HTTP ${r.status}`);return r.body;};
  const cleanup=async()=>{if(!guarded)return;try{await setVisibility(false,false);}catch{/* fall through to the direct database rollback */}try{db.prepare("UPDATE agents SET public=0, demo_actionable=0, status='inactive' WHERE id=?").run(guarded.agent_id);}catch{/* nothing else to undo */}};
  try{
    const reg=await fetchJson("/v1/agents/register",config.ADMIN_TOKEN,"POST",{name:`smoke-public-${guardRandom}`,kind:"smoke",description:"smoke-public demo guard throwaway agent"});
    ensure(reg.status===201&&reg.body.agent_id&&reg.body.api_key,`agent registration returned HTTP ${reg.status}`);
    guarded=reg.body;
    const wallet=await fetchJson(guardPath("/wallet"),config.ADMIN_TOKEN,"POST",{});
    ensure(wallet.status===201&&wallet.body.address,`wallet creation returned HTTP ${wallet.status}`);
    const policy=await fetchJson(guardPath("/policy"),config.ADMIN_TOKEN,"PUT",{salary_sui:0.05,per_tx_cap_sui:0.03,period_cap_sui:0.08,allowed_vendor_ids:[]});
    ensure(policy.status===200,`policy update returned HTTP ${policy.status}`);
    const settings=await fetchJson(guardPath("/settings"),config.ADMIN_TOKEN,"PUT",{period:"weekly",allowance_mist:"50000000",improvement_reserve_pct:40,autonomy:"ask",auto_limit_mist:"0",rollover:false});
    ensure(settings.status===200,`settings update returned HTTP ${settings.status}`);
    for(const event of guardEvents){
      const r=await fetchJson("/v1/events",guarded.api_key,"POST",{...event,ts:new Date(guardBase+guardClock++*1_000).toISOString()});
      ensure(r.status===201,`${event.type} for ${event.task_category} returned HTTP ${r.status}`);
    }
    const review=await fetchJson(guardPath("/review/run"),config.ADMIN_TOKEN,"POST",{period_label:`smoke-public-${guardRandom}`,window_start:new Date(guardBase-60_000).toISOString(),window_end:new Date(guardNow+60_000).toISOString()});
    ensure(review.status===201&&review.body.review.outcome==="gaps_found",`review returned HTTP ${review.status} outcome ${review.body.review?.outcome}`);
    const financeGap=review.body.gaps.find((gap)=>gap.task_category==="finance_qa");
    ensure(financeGap&&financeGap.status==="passed_gate"&&financeGap.taxonomy==="knowledge",`finance_qa gap did not pass the gate: ${financeGap&&financeGap.status}/${financeGap&&financeGap.taxonomy}`);
    const proposals=await fetchJson(`/v1/reviews/${encodeURIComponent(review.body.review.id)}/proposals`,config.ADMIN_TOKEN,"POST",{});
    ensure(proposals.status===201,`proposal creation returned HTTP ${proposals.status}`);
    const request=proposals.body.requests.find((row)=>row.capability_key==="premium_data");
    ensure(request&&["pending_approval","needs_raise"].includes(request.status),`premium_data request missing or not pending: ${request?request.status:"absent"}`);
    const txBefore=db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE agent_id=?").get(guarded.agent_id).n;
    ensure(txBefore===0,`throwaway agent already has ${txBefore} transaction rows before the demo guard checks`);
    await setVisibility(true,false);
    const approveA=await fetchJson(`/public/v1/requests/${request.id}/approve`,undefined,"POST",{});
    ensure(approveA.status===403&&approveA.body.code==="demo_actions_disabled",`approve (demo_actionable=0) returned HTTP ${approveA.status} code ${approveA.body?.code}`);
    const rejectA=await fetchJson(`/public/v1/requests/${request.id}/reject`,undefined,"POST",{});
    ensure(rejectA.status===403&&rejectA.body.code==="demo_actions_disabled",`reject (demo_actionable=0) returned HTTP ${rejectA.status} code ${rejectA.body?.code}`);
    await setVisibility(true,true);
    const approveB=await fetchJson(`/public/v1/requests/${request.id}/approve`,undefined,"POST",{});
    ensure(approveB.status===403&&approveB.body.code==="demo_actions_disabled",`approve (demo_actionable=1) returned HTTP ${approveB.status} code ${approveB.body?.code}`);
    const rejectB=await fetchJson(`/public/v1/requests/${request.id}/reject`,undefined,"POST",{});
    ensure(rejectB.status===403&&rejectB.body.code==="demo_actions_disabled",`reject (demo_actionable=1) returned HTTP ${rejectB.status} code ${rejectB.body?.code}`);
    const txAfter=db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE agent_id=?").get(guarded.agent_id).n;
    const spendAfter=db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE agent_id=? AND kind IN ('spend','topup')").get(guarded.agent_id).n;
    ensure(txAfter===0&&spendAfter===0,`demo guard checks left ${txAfter} transaction rows (${spendAfter} spend/top-up)`);
    const current=await fetchJson(`/v1/requests/${request.id}`,config.ADMIN_TOKEN);
    ensure(current.status===200&&["pending_approval","needs_raise"].includes(current.body.status),`request did not stay pending: HTTP ${current.status} status ${current.body?.status}`);
    return `request ${request.id} stayed ${current.body.status}; zero transactions for the throwaway agent`;
  } finally { await cleanup(); }
});
await step("public rate limit returns at least one 429 in 80 rapid requests",async()=>{let limited=0;for(let i=0;i<80;i++){const response=await fetch(base+"/public/v1/system");if(response.status===429)limited++;}ensure(limited>0,"none of the 80 requests received HTTP 429");return `${limited} responses returned 429`;});
await step("static root serves the dashboard placeholder or the built app",async()=>{const response=await fetch(base+"/");const html=await response.text();const isPlaceholder=html.includes("Payroll Layer public API")&&html.includes("/public/v1/system");const isBuiltApp=/<div[^>]+id=["']root["']/i.test(html)&&/<script[^>]+src=/i.test(html);ensure(response.status===200&&(isPlaceholder||isBuiltApp),`GET / returned HTTP ${response.status} or unexpected content`);});
db.close();if(failed)process.exitCode=1;
