import "dotenv/config";
import { initDatabase, closeDatabase, getDatabase } from "../src/db.js";

const actionable=process.argv.includes("--actionable");
try{initDatabase();const db=getDatabase();const agent=db.prepare(`SELECT a.id,a.name FROM agents a WHERE a.name LIKE 'research-agent%' AND EXISTS(SELECT 1 FROM upgrade_requests r WHERE r.agent_id=a.id AND r.status='executed') AND EXISTS(SELECT 1 FROM upgrade_verdicts v WHERE v.agent_id=a.id) ORDER BY a.created_at DESC LIMIT 1`).get();if(!agent)throw new Error("no research-agent with an executed upgrade request and verdict was found");db.prepare("UPDATE agents SET public=1,demo_actionable=? WHERE id=?").run(actionable?1:0,agent.id);console.log(`Published agent ${agent.id} (${agent.name}); demo_actionable=${actionable}`);}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}finally{try{closeDatabase();}catch{}}
