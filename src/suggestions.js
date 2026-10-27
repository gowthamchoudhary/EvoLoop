import { randomUUID } from "node:crypto";
import { getDatabase } from "./db.js";
import { enqueueMemory, newMemoryId } from "./memory-queue.js";
import { formatMist } from "./payroll-chain.js";
import { PROBATION_CONSECUTIVE, PROBATION_PCT, PROBATION_SCORE, RAISE_IMPROVEMENT, RAISE_PCT, RAISE_SCORE } from "./review-config.js";

export function publicSuggestion(row){if(!row)return null;return {...row,reasons:JSON.parse(row.reasons_json??"[]")};}
export function createSuggestion(score){
  if(score.status!=="scored")return null;
  const db=getDatabase(), prev=db.prepare("SELECT * FROM agent_scores WHERE agent_id=? AND status='scored' AND id<>? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(score.agent_id,score.id);
  const history=db.prepare("SELECT score FROM agent_scores WHERE agent_id=? AND status='scored' AND id<>? ORDER BY created_at DESC,rowid DESC LIMIT ?").all(score.agent_id,score.id,PROBATION_CONSECUTIVE-1);
  const priorCount=db.prepare("SELECT COUNT(*) AS n FROM agent_scores WHERE agent_id=? AND status='scored' AND id<>?").get(score.agent_id,score.id).n;
  const current=BigInt(score.allowance_mist||"0"); let kind="hold", reason;
  if(score.score>=RAISE_SCORE && prev && score.score-prev.score>=RAISE_IMPROVEMENT && score.worth_it_verdicts>0){kind="raise";reason=`score ${score.score} >= ${RAISE_SCORE}; improvement ${Math.round((score.score-prev.score)*10)/10} >= ${RAISE_IMPROVEMENT}; worth_it verdicts ${score.worth_it_verdicts}`;}
  else if(score.score<PROBATION_SCORE&&history.length===PROBATION_CONSECUTIVE-1&&history.every(x=>x.score<PROBATION_SCORE)){kind="probation";reason=`${PROBATION_CONSECUTIVE} consecutive scores below ${PROBATION_SCORE}: ${[...history.map(x=>x.score).reverse(),score.score].join(", ")}`;}
  else reason=score.score<PROBATION_SCORE&&history.filter(x=>x.score<PROBATION_SCORE).length<PROBATION_CONSECUTIVE-1?`not probation: not enough consecutive weak periods (need ${PROBATION_CONSECUTIVE})`:priorCount===0?"only one scored period":score.score<RAISE_SCORE?`score below raise threshold ${RAISE_SCORE}`:!prev?"no previous scored period":"raise improvement or worth_it requirement not met";
  const suggested=kind==="raise"?current*(100n+BigInt(RAISE_PCT))/100n:kind==="probation"?current*(100n-BigInt(PROBATION_PCT))/100n:current;
  const id=`suggest_${randomUUID()}`, now=new Date().toISOString();
  db.prepare("UPDATE salary_suggestions SET status='superseded' WHERE agent_id=? AND status='pending'").run(score.agent_id);
  const reasons=[reason];
  db.prepare(`INSERT INTO salary_suggestions(id,agent_id,score_id,kind,current_allowance_mist,suggested_allowance_mist,reasons_json,status,created_at) VALUES(?,?,?,?,?,?,?,'pending',?)`).run(id,score.agent_id,score.id,kind,current.toString(),suggested.toString(),JSON.stringify(reasons),now);
  if(kind==="raise"||kind==="probation"){
    const memoryId=newMemoryId(), message=`Agent ${score.agent_id} | salary_suggestion | ${kind} | score ${score.score} | ${reason}`;
    db.prepare("INSERT INTO memories(id,event_id,agent_id,text,status,created_at) VALUES(?,NULL,?,?, 'pending',?)").run(memoryId,score.agent_id,message,now); enqueueMemory(memoryId);
  }
  return publicSuggestion(db.prepare("SELECT * FROM salary_suggestions WHERE id=?").get(id));
}
export function listSuggestions({agentId,status}={}){const clauses=[],args=[];if(agentId){clauses.push("agent_id=?");args.push(agentId);}if(status){clauses.push("status=?");args.push(status);}return getDatabase().prepare(`SELECT * FROM salary_suggestions ${clauses.length?"WHERE "+clauses.join(" AND "):""} ORDER BY created_at DESC`).all(...args).map(publicSuggestion);}
export function acceptSuggestion(id,note){const db=getDatabase(),row=db.prepare("SELECT * FROM salary_suggestions WHERE id=?").get(id);if(!row)return {error:"suggestion not found",status:404};if(row.status!=="pending")return {error:"suggestion is not pending",status:409};const now=new Date().toISOString();const old=BigInt(row.current_allowance_mist),next=BigInt(row.suggested_allowance_mist);const write=db.transaction(()=>{db.prepare("UPDATE salary_suggestions SET status='accepted',decided_note=?,decided_at=? WHERE id=? AND status='pending'").run(note??null,now,id);if(row.kind==="raise"||row.kind==="probation"){db.prepare(`INSERT INTO agent_settings(agent_id,allowance_mist,updated_at) VALUES(?,?,?) ON CONFLICT(agent_id) DO UPDATE SET allowance_mist=excluded.allowance_mist,updated_at=excluded.updated_at`).run(row.agent_id,next.toString(),now);if(row.kind==="probation")db.prepare("UPDATE agent_settings SET autonomy='ask',updated_at=? WHERE agent_id=? AND autonomy<>'never'").run(now,row.agent_id);}});write();if(row.kind==="raise"||row.kind==="probation"){const memoryId=newMemoryId(),message=`Agent ${row.agent_id} | salary_change | ${row.kind} | allowance ${formatMist(old)} -> ${formatMist(next)} SUI | accepted by user`;db.prepare("INSERT INTO memories(id,event_id,agent_id,text,status,created_at) VALUES(?,NULL,?,?, 'pending',?)").run(memoryId,row.agent_id,message,now);enqueueMemory(memoryId);}return {suggestion:publicSuggestion(db.prepare("SELECT * FROM salary_suggestions WHERE id=?").get(id))};}
export function dismissSuggestion(id,note){const db=getDatabase(),row=db.prepare("SELECT * FROM salary_suggestions WHERE id=?").get(id);if(!row)return {error:"suggestion not found",status:404};if(row.status!=="pending")return {error:"suggestion is not pending",status:409};db.prepare("UPDATE salary_suggestions SET status='dismissed',decided_note=?,decided_at=? WHERE id=? AND status='pending'").run(note??null,new Date().toISOString(),id);return {suggestion:publicSuggestion(db.prepare("SELECT * FROM salary_suggestions WHERE id=?").get(id))};}
