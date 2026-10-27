import { randomUUID } from "node:crypto";
import { getDatabase } from "./db.js";
import { SCORE_MIN_OUTCOMES, SCORE_WEIGHT_DISCIPLINE, SCORE_WEIGHT_QUALITY, SCORE_WEIGHT_UPGRADES, OUTCOME_TYPES, ISSUE_TYPES } from "./review-config.js";

export function computeScore(agentId, windowStart, windowEnd) {
  const db = getDatabase();
  const snapshotCreatedAt = new Date().toISOString();
  const outcomes = db.prepare(`SELECT type,COUNT(*) AS count FROM events WHERE agent_id=? AND ts>=? AND ts<=? AND type IN (${OUTCOME_TYPES.map(() => "?").join(",")}) GROUP BY type`).all(agentId, windowStart, windowEnd, ...OUTCOME_TYPES);
  const counts = Object.fromEntries(outcomes.map(x => [x.type, x.count]));
  const outcomeCount = Object.values(counts).reduce((a,b)=>a+b,0);
  const issues = ISSUE_TYPES.reduce((n,type)=>n+(counts[type]??0),0);
  const issueRate = outcomeCount ? issues/outcomeCount : null;
  const setting = db.prepare("SELECT allowance_mist FROM agent_settings WHERE agent_id=?").get(agentId);
  const allowance = BigInt(setting?.allowance_mist ?? "0");
  const spendRows = db.prepare("SELECT amount_mist FROM transactions WHERE agent_id=? AND kind IN ('spend','topup') AND status='executed' AND created_at>=? AND created_at<=?").all(agentId,windowStart,windowEnd);
  const spent = spendRows.reduce((sum,row)=>sum+BigInt(row.amount_mist),0n);
  const verdicts = db.prepare(`SELECT v.verdict FROM upgrade_verdicts v
    WHERE v.agent_id=? AND v.evaluated_at<=? AND v.verdict IN ('worth_it','not_worth_it')
      AND EXISTS (SELECT 1 FROM agent_capabilities c WHERE c.agent_id=v.agent_id
        AND c.capability_key=v.capability_key AND c.unlocked_at<=?)`).all(agentId,snapshotCreatedAt,windowEnd);
  const worth = verdicts.filter(v=>v.verdict==='worth_it').length;
  const components = [
    {name:"quality",value:issueRate===null?null:1-issueRate,weight:SCORE_WEIGHT_QUALITY,included:issueRate!==null,raw:{outcomes:outcomeCount,issues,issue_rate:issueRate}},
    {name:"discipline",value:allowance===0n?null:1-Math.min(1,Number(spent)/Number(allowance)),weight:SCORE_WEIGHT_DISCIPLINE,included:allowance>0n,raw:{spent_mist:spent.toString(),allowance_mist:allowance.toString()}},
    {name:"upgrades",value:verdicts.length?worth/verdicts.length:null,weight:SCORE_WEIGHT_UPGRADES,included:verdicts.length>0,raw:{worth_it:worth,not_worth_it:verdicts.length-worth,verdicts:verdicts.length}},
  ];
  const weights=components.filter(c=>c.included).reduce((n,c)=>n+c.weight,0);
  for(const component of components){component.configured_weight=component.weight;component.weight=component.included&&weights?component.weight/weights:0;}
  const score=outcomeCount<SCORE_MIN_OUTCOMES?null:Math.round(100*components.filter(c=>c.included).reduce((n,c)=>n+c.value*c.weight,0)*10)/10;
  return {id:`score_${randomUUID()}`,agent_id:agentId,period_label:null,window_start:windowStart,window_end:windowEnd,score,status:score===null?"insufficient_data":"scored",components,outcomes:outcomeCount,issue_rate:issueRate,spent_mist:spent.toString(),allowance_mist:allowance.toString(),source:"live",worth_it_verdicts:worth,snapshot_created_at:snapshotCreatedAt};
}

export function storeScore(result, periodLabel, source="live") {
  const row={...result,period_label:periodLabel,source,created_at:result.snapshot_created_at??new Date().toISOString()};
  getDatabase().prepare(`INSERT INTO agent_scores(id,agent_id,period_label,window_start,window_end,score,status,components_json,outcomes,issue_rate,spent_mist,allowance_mist,created_at,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id,row.agent_id,row.period_label,row.window_start,row.window_end,row.score,row.status,JSON.stringify(row.components),row.outcomes,row.issue_rate,row.spent_mist,row.allowance_mist,row.created_at,row.source);
  return publicScore(row);
}
export function publicScore(row) { if(!row)return null; return {...row,components:row.components??JSON.parse(row.components_json??"[]")}; }
