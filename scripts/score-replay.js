import "dotenv/config";
import Database from "better-sqlite3";
import { getConfig } from "../src/config.js";
import { SCORE_MIN_OUTCOMES, RAISE_SCORE, RAISE_IMPROVEMENT, PROBATION_SCORE, PROBATION_CONSECUTIVE } from "../src/review-config.js";

const config=getConfig(),db=new Database(config.DB_PATH,{fileMustExist:true}),base=process.env.SMOKE_BASE_URL?.trim()||`http://127.0.0.1:${config.PORT}`;
const secrets=[config.ADMIN_TOKEN,config.MEMWAL_KEY,config.TATUM_API_KEY,config.WALLET_ENC_KEY].filter(Boolean);
const redact=(text)=>{for(const secret of secrets)text=text.split(secret).join("[REDACTED]");return text.replace(/\b(?:plk_[a-f0-9]{64}|(?:0x)?[a-f0-9]{64})\b/gi,"[REDACTED]");};
async function request(path,method="GET",body){const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${config.ADMIN_TOKEN}`,...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});const t=await r.text();let data;try{data=JSON.parse(t)}catch{data=t}if(!r.ok)throw new Error(`${method} ${path} HTTP ${r.status}: ${JSON.stringify(data)}`);return data;}
function pass(name,ok,detail=""){console.log(`${ok?"PASS":"FAIL"} ${name}${detail?`: ${detail}`:""}`);if(!ok)throw new Error(`check failed: ${name}`);}
try{
 const candidate=db.prepare(`SELECT a.id,a.name,c.unlocked_at FROM agents a JOIN agent_capabilities c ON c.agent_id=a.id AND c.capability_key='premium_data' AND c.active=1 JOIN upgrade_verdicts v ON v.agent_id=a.id AND v.verdict='worth_it' WHERE a.name LIKE 'research-agent-%' AND EXISTS(SELECT 1 FROM transactions t WHERE t.agent_id=a.id AND t.kind='spend' AND t.status='executed' AND t.created_at<=c.unlocked_at) ORDER BY a.created_at DESC LIMIT 1`).get();
 if(!candidate)throw new Error("no qualifying research-agent with executed premium_data and worth_it verdict exists");
 const first=db.prepare("SELECT MIN(ts) AS ts FROM events WHERE agent_id=?").get(candidate.id).ts,last=db.prepare("SELECT MAX(ts) AS ts FROM events WHERE agent_id=?").get(candidate.id).ts;
 if(!first||!last||Date.parse(first)>=Date.parse(candidate.unlocked_at)||Date.parse(candidate.unlocked_at)>Date.parse(last))throw new Error("qualifying agent has no events on both sides of capability unlock");
 db.transaction(()=>{db.prepare("DELETE FROM salary_suggestions WHERE score_id IN (SELECT id FROM agent_scores WHERE agent_id=? AND source='replay')").run(candidate.id);db.prepare("DELETE FROM agent_scores WHERE agent_id=? AND source='replay'").run(candidate.id);})();
 const boundary=new Date(Date.parse(candidate.unlocked_at)-1).toISOString();
 const p1=await request(`/v1/agents/${candidate.id}/score/snapshot?source=replay`,"POST",{period_label:"replay-period-1",window_start:first,window_end:boundary});
 const p2=await request(`/v1/agents/${candidate.id}/score/snapshot?source=replay`,"POST",{period_label:"replay-period-2",window_start:candidate.unlocked_at,window_end:last});
 console.log("PERIOD 1 SCORE\n"+JSON.stringify(p1.score,null,2));console.log("PERIOD 1 SUGGESTION\n"+JSON.stringify(p1.suggestion,null,2));
 console.log("PERIOD 2 SCORE\n"+JSON.stringify(p2.score,null,2));console.log("PERIOD 2 SUGGESTION\n"+JSON.stringify(p2.suggestion,null,2));
 const score1=p1.score.score,score2=p2.score.score,worth=p2.score.components.find(c=>c.name==="upgrades")?.raw?.worth_it??0;
 const expectedRaise=score2!==null&&score1!==null&&score2>=RAISE_SCORE&&score2-score1>=RAISE_IMPROVEMENT&&worth>0;
 pass("period 2 raise matches configured thresholds",(p2.suggestion?.kind==="raise")===expectedRaise,`expected raise=${expectedRaise}; period1=${score1}; period2=${score2}; qualifying worth_it=${worth}`);
 pass("one weak period yields hold (not probation)",p1.score.score<PROBATION_SCORE&&p1.suggestion?.kind==="hold"&&p1.suggestion.reasons.some(reason=>reason.includes("not probation")&&reason.includes("not enough consecutive weak periods")),`period 1 kind=${p1.suggestion?.kind}; reason=${p1.suggestion?.reasons?.join("; ")}`);
 const components=p2.score.components,weightSum=components.filter(c=>c.included).reduce((s,c)=>s+c.weight,0);const computed=p2.score.status==="scored"?Math.round(100*components.filter(c=>c.included).reduce((s,c)=>s+c.value*c.weight,0)*10)/10:null;
 pass("components sum to score",computed===p2.score.score,`computed ${computed}; returned ${p2.score.score}; included weights ${weightSum}`);
 const upgrades=components.find(c=>c.name==="upgrades"),without=components.filter(c=>c.name!=="upgrades"&&c.included);pass("weights renormalize when upgrades are excluded",!upgrades.included&&without.length>0&&Math.abs(without.reduce((s,c)=>s+c.weight,0)-1)<1e-9,`upgrade included=${upgrades.included}; other normalized weight sum=${without.reduce((s,c)=>s+c.weight,0)}`);
 const sparse=db.prepare(`SELECT a.id,MIN(e.ts) AS first,MAX(e.ts) AS last,COUNT(*) AS n FROM agents a JOIN events e ON e.agent_id=a.id AND e.type IN ('task_completed','task_failed','user_corrected','task_abandoned') GROUP BY a.id HAVING COUNT(*)<? ORDER BY COUNT(*) LIMIT 1`).get(SCORE_MIN_OUTCOMES);
 if(!sparse)throw new Error("no agent with fewer than minimum outcomes found for insufficient-data check");
 const empty=await request(`/v1/agents/${sparse.id}/score/snapshot?source=replay`,"POST",{period_label:"replay-insufficient-check",window_start:sparse.first,window_end:sparse.last});pass("insufficient data yields no suggestion",empty.score.status==="insufficient_data"&&empty.score.score===null&&empty.suggestion===null,`outcomes ${empty.score.outcomes}`);
 console.log(`Period 2 suggested allowance: ${p2.suggestion?.suggested_allowance_mist??"none"} MIST (${p2.suggestion?.suggested_allowance_mist?Number(p2.suggestion.suggested_allowance_mist)/1e9:"n/a"} SUI)`);
 console.log(`Period 2 reasons: ${p2.suggestion?.reasons?.join("; ")??"none"}`);
 if(p2.suggestion){const dismissed=await request(`/v1/suggestions/${p2.suggestion.id}/dismiss`,"POST",{});console.log("PERIOD 2 DISMISSED\n"+JSON.stringify(dismissed,null,2));}
 console.log(`Replay thresholds: raise score ${RAISE_SCORE}, improvement ${RAISE_IMPROVEMENT}, probation ${PROBATION_SCORE} x ${PROBATION_CONSECUTIVE}; no transfers performed.`);
}catch(error){console.error(redact(error instanceof Error?error.message:String(error)));process.exitCode=1;}finally{db.close();}
