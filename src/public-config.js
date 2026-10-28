import { getConfig } from "./config.js";

const envInteger=(name,fallback,min=1)=>{const value=process.env[name]?.trim();if(!value)return fallback;const parsed=Number(value);return Number.isSafeInteger(parsed)&&parsed>=min?parsed:fallback;};
const config=getConfig();
export const NETWORK_LABEL=config.SUI_NETWORK;
export const EXPLORER_TX_URL=`https://suiscan.xyz/${NETWORK_LABEL}/tx/`;
export const EXPLORER_ACCOUNT_URL=`https://suiscan.xyz/${NETWORK_LABEL}/account/`;
export const DEMO_ACTIONS_ENABLED=/^(1|true|yes)$/i.test(process.env.DEMO_ACTIONS_ENABLED?.trim()??"");
export const DEMO_MAX_APPROVALS_PER_HOUR=envInteger("DEMO_MAX_APPROVALS_PER_HOUR",6);
export const DEMO_MAX_APPROVALS_PER_IP_PER_HOUR=envInteger("DEMO_MAX_APPROVALS_PER_IP_PER_HOUR",2);
export const PUBLIC_RATE_LIMIT_PER_MIN=envInteger("PUBLIC_RATE_LIMIT_PER_MIN",60);
export const PUBLIC_BALANCE_CACHE_SECONDS=envInteger("PUBLIC_BALANCE_CACHE_SECONDS",20);
