import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { getConfig } from "./config.js";
import { getDatabase } from "./db.js";

function encryptSecret(secret) {
  const key = Buffer.from(getConfig().WALLET_ENC_KEY, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encKey = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { enc_key: encKey.toString("hex"), iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
}

export function decryptWallet(wallet) {
  const key = Buffer.from(getConfig().WALLET_ENC_KEY, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(wallet.iv, "hex"));
  decipher.setAuthTag(Buffer.from(wallet.tag, "hex"));
  const secret = Buffer.concat([
    decipher.update(Buffer.from(wallet.enc_key, "hex")),
    decipher.final(),
  ]).toString("utf8");
  return Ed25519Keypair.fromSecretKey(secret);
}

export function getWallet(ownerType, ownerId) {
  return getDatabase().prepare("SELECT * FROM wallets WHERE owner_type=? AND owner_id=?").get(ownerType, ownerId);
}

export function createWallet(ownerType, ownerId) {
  const db = getDatabase();
  const existing = getWallet(ownerType, ownerId);
  if (existing) return existing;
  const keypair = Ed25519Keypair.generate();
  const encrypted = encryptSecret(keypair.getSecretKey());
  const wallet = {
    owner_type: ownerType,
    owner_id: ownerId,
    address: keypair.toSuiAddress(),
    ...encrypted,
    created_at: new Date().toISOString(),
  };
  db.prepare("INSERT INTO wallets(owner_type,owner_id,address,enc_key,iv,tag,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(wallet.owner_type, wallet.owner_id, wallet.address, wallet.enc_key, wallet.iv, wallet.tag, wallet.created_at);
  return wallet;
}
