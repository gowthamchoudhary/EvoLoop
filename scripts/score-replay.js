import "dotenv/config";
import Database from "better-sqlite3";
import { getConfig } from "../src/config.js";
import { SCORE_MIN_OUTCOMES, SCORE_WEIGHT_QUALITY, SCORE_WEIGHT_DISCIPLINE, SCORE_WEIGHT_UPGRADES, RAISE_SCORE, RAISE_IMPROVEMENT, PROBATION_SCORE, PROBATION_CONSECUTIVE } from "../src/review-config.js";

const config=getConfig(),db=new Database(config.DB_PATH,{readonly:true,fileMustExist:true}),base=process.env.SMOKE_BASE_URL?.trim()||`http://127.0.0.1:${config.PORT}`;
const redact=(text)=>{for(const secret of [config.ADMIN_TOKEN,config.MEMWAL_KEY,config.TATUM_API_KEY,config.WALLET_ENC_KEY])if(secret)text=text.split(secret).join("[REDACTED]");return text.replace(/\b(?:plk_[a-f0-9]{64}|(?:0x)?[a-f0-9]{64})\b/gi,"[REDACTED]");};
async function request(path,method="GET",body){const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${config.ADMIN_TOKEN}`,...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});const t=await r.text();let data;try{data=JSON.parse(t)}catch{data=t}if(!r.ok)throw new Error(`${method} ${path} HTTP ${r.status}: ${JSON.stringify(data)}`);return data;}
function pass(name,ok,detail=""){console.log(`${ok?"PASS":"FAIL"} ${name}${detail?`: ${detail}`:""}`);if(!ok)throw new Error(`check failed: ${name}`);}
try{
 const candidate=db.prepare(`SELECT a.id,a.name,c.unlocked_at FROM agents a JOIN agent_capabilities c ON c.agent_id=a.id AND c.capability_key='premium_data' AND c.active=1 JOIN upgrade_verdicts v ON v.agent_id=a.id AND v.verdict='worth_it' WHERE a.name LIKE 'research-agent-%' AND EXISTS(SELECT 1 FROM transactions t WHERE t.agent_id=a.id AND t.kind='spend' AND t.status='executed' AND t.created_at<=c.unlocked_at) ORDER BY a.created_at DESC LIMIT 1`).get();
 if(!candidate)throw new Error("no qualifying research-agent with executed premium_data and worth_it verdict exists");
 const first=db.prepare("SELECT MIN(ts) AS ts FROM events WHERE agent_id=?").get(candidate.id).ts,last=db.prepare("SELECT MAX(ts) AS ts FROM events WHERE agent_id=?").get(candidate.id).ts;
 if(!first||!last||Date.parse(first)>=Date.parse(candidate.unlocked_at)||Date.parse(candidate.unlocked_at)>Date.parse(last))throw new Error("qualifying agent has no events on both sides of capability unlock");
 const boundary=new Date(Date.parse(candidate.unlocked_at)-1).toISOString();
 const p1=await request(`/v1/agents/${candidate.id}/score/snapshot?source=replay`,"POST",{period_label:"replay-period-1",window_start:first,window_end:boundary});
 const p2=await request(`/v1/agents/${candidate.id}/score/snapshot?source=replay`,"POST",{period_label:"replay-period-2",window_start:candidate.unlocked_at,window_end:last});
 console.log("PERIOD 1",JSON.stringify(p1.score,null,2));console.log("PERIOD 2",JSON.stringify(p2.score,null,2));console.log("PERIOD 2 SUGGESTION",JSON.stringify(p2.suggestion,null,2));
 const allowed=[SCORE_WEIGHT_QUALITY,SCORE_WEIGHT_DISCIPLINE,SCORE_WEIGHT_UPGRADES],comp=p2.score.components;
 const included=comp.filter(c=>c.included),weightSum=included.reduce((s,c)=>s+c.weight,0);const expected=p2.score.status==="scored"?Math.round(100*included.reduce((s,c)=>s+c.value*c.weight/weightSum,0)*10)/10:null;
 pass("components sum to score",expected===p2.score.score,`computed ${expected}; returned ${p2.score.score}`);
 const withoutUpgrades=comp.filter(c=>c.name!=="upgrades");const renorm=withoutUpgrades.filter(c=>c.included).reduce((s,c)=>s+c.weight,0);pass("weights renormalize when upgrades are excluded",!comp.find(c=>c.name==="upgrades").included&&renorm>0&&Math.abs(withoutUpgrades.filter(c=>c.included).reduce((s,c)=>s+c.value*c.weight/renorm,0)-expected/100)<2,`configured weights ${allowed.join(",")}`);
 const weak=p2.suggestion?.kind==="hold"&&p2.score.score<PROBATION_SCORE;pass("one weak period yields hold (not probation)",weak,`period 2 kind ${p2.suggestion?.kind??"none"}`);
 const sparse=db.prepare(`SELECT a.id,MIN(e.ts) AS first,MAX(e.ts) AS last,COUNT(*) AS n FROM agents a JOIN events e ON e.agent_id=a.id AND e.type IN ('task_completed','task_failed','user_corrected','task_abandoned') GROUP BY a.id HAVING COUNT(*)<? ORDER BY COUNT(*) LIMIT 1`).get(SCORE_MIN_OUTCOMES);
 if(!sparse)throw new Error("no agent with fewer than minimum outcomes found for insufficient-data check");
 const sparseEnd=sparse.last,sparseStart=sparse.first;const empty=await request(`/v1/agents/${sparse.id}/score/snapshot?source=replay`,"POST",{period_label:"replay-insufficient-check",window_start:sparseStart,window_end:sparseEnd});pass("insufficient data yields no suggestion",empty.score.status==="insufficient_data"&&empty.score.score===null&&empty.suggestion===null,`outcomes ${empty.score.outcomes}`);
 if(p2.suggestion){const dismissed=await request(`/v1/suggestions/${p2.suggestion.id}/dismiss`,"POST",{});console.log("DISMISSED",JSON.stringify(dismissed));}
 console.log(`Replay thresholds: raise score ${RAISE_SCORE}, improvement ${RAISE_IMPROVEMENT}, probation ${PROBATION_SCORE} x ${PROBATION_CONSECUTIVE}; no transfers performed.`);
}catch(error){console.error(redact(error instanceof Error?error.message:String(error)));process.exitCode=1;}finally{db.close();}
