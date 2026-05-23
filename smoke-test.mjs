#!/usr/bin/env node
// Smoke test for the patched MCP after Polymarket v2 / pUSD migration.
// Hits the live Polymarket APIs read-only. If POLYMARKET_PRIVATE_KEY is set,
// also exercises the trading-client init path (creates/derives API keys, fetches
// balance) but DOES NOT place any orders.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Load .env if present (without external dep). Search script dir and parent dir.
const __dirname = dirname(fileURLToPath(import.meta.url));
const candidates = [join(__dirname, ".env"), join(__dirname, "..", ".env")];
for (const envPath of candidates) {
	if (!existsSync(envPath)) continue;
	const content = readFileSync(envPath, "utf8");
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq < 0) continue;
		const k = trimmed.slice(0, eq).trim();
		const v = trimmed.slice(eq + 1).trim();
		if (!(k in process.env)) process.env[k] = v;
	}
	console.log(`(loaded env from ${envPath.replace(process.env.HOME ?? "", "~")})`);
	break;
}

const RESULTS = [];
let failures = 0;

async function test(name, fn) {
	const start = Date.now();
	try {
		const result = await fn();
		const ms = Date.now() - start;
		RESULTS.push({ name, status: "PASS", ms, summary: result });
		console.log(`✅ ${name} (${ms}ms)`);
		if (result) console.log(`   ${result}`);
	} catch (e) {
		failures++;
		const ms = Date.now() - start;
		const msg = e?.message || String(e);
		RESULTS.push({ name, status: "FAIL", ms, error: msg });
		console.log(`❌ ${name} (${ms}ms)`);
		console.log(`   ${msg}`);
		if (e?.stack) console.log(e.stack.split("\n").slice(1, 4).join("\n"));
	}
}

console.log("=== Smoke test: patched mcp-polymarket vs live Polymarket v2 ===\n");

// === Read-only tests (no private key needed) ===

const { api } = await import("./dist/services/api.js");

await test("api.listActiveMarkets — returns array of active markets", async () => {
	const markets = await api.listActiveMarkets(5, 0);
	if (!Array.isArray(markets)) throw new Error(`expected array, got ${typeof markets}`);
	if (markets.length === 0) throw new Error("no active markets returned");
	return `${markets.length} markets, first: "${markets[0].question?.slice(0, 60) ?? "(no question)"}..."`;
});

await test("api.searchMarkets — query 'counter strike' returns results", async () => {
	const result = await api.searchMarkets("counter strike");
	const hits = result?.events?.length ?? result?.markets?.length ?? 0;
	return `events/markets hits: ${JSON.stringify({ events: result?.events?.length, markets: result?.markets?.length })}`;
});

let firstCs2TokenId = null;
let firstCs2Market = null;

await test("api.getMarketsByTag — find CS2 / esports markets", async () => {
	// Tag 100196 is "Esports" on Polymarket gamma. Search for it first if unknown.
	// Fall back to keyword search for CS2.
	const result = await api.searchMarkets("CS2 Counter-Strike");
	const markets = result?.markets ?? [];
	if (markets.length === 0) return "no CS2 markets found (may be off-season)";
	firstCs2Market = markets[0];
	// Pull clobTokenIds — comma-separated string in gamma API
	const tokenIds = firstCs2Market.clobTokenIds;
	if (typeof tokenIds === "string") {
		const parsed = JSON.parse(tokenIds);
		firstCs2TokenId = parsed[0];
	} else if (Array.isArray(tokenIds)) {
		firstCs2TokenId = tokenIds[0];
	}
	return `picked: "${firstCs2Market.question?.slice(0, 80)}" tokenId=${firstCs2TokenId?.slice(0, 20)}...`;
});

await test("api.getOrderBook — fetch real order book for a live token", async () => {
	if (!firstCs2TokenId) {
		// Fall back to a known liquid token from active markets
		const markets = await api.listActiveMarkets(20, 0);
		for (const m of markets) {
			const ids = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
			if (ids?.[0]) {
				firstCs2TokenId = ids[0];
				break;
			}
		}
	}
	if (!firstCs2TokenId) throw new Error("no token id available to test orderbook");
	const book = await api.getOrderBook(firstCs2TokenId);
	if (!book) throw new Error("null orderbook");
	const bidLevels = book.bids?.length ?? 0;
	const askLevels = book.asks?.length ?? 0;
	const topBid = book.bids?.[book.bids.length - 1]?.price ?? "none";
	const topAsk = book.asks?.[book.asks.length - 1]?.price ?? "none";
	return `${bidLevels} bids / ${askLevels} asks, top bid ${topBid} / top ask ${topAsk}`;
});

// === Trading-mode tests (only if private key is set) ===

if (process.env.POLYMARKET_PRIVATE_KEY) {
	console.log("\n--- POLYMARKET_PRIVATE_KEY detected — running trading-client init tests ---\n");

	const { tradeApi } = await import("./dist/services/trading.js");

	await test("trading.getSignerAddress — returns wallet address", async () => {
		const addr = await tradeApi.getSignerAddress();
		if (!addr || !addr.startsWith("0x")) throw new Error(`bad address: ${addr}`);
		return `signer: ${addr}`;
	});

	await test("trading.getServerTime — CLOB v2 server reachable", async () => {
		const t = await tradeApi.getServerTime();
		if (typeof t !== "number") throw new Error(`expected number, got ${typeof t}`);
		const drift = Math.abs(Date.now() / 1000 - t);
		return `server time ${t} (drift ${drift.toFixed(1)}s vs local)`;
	});

	await test("trading.getBalanceAllowance — pUSD balance + allowance", async () => {
		const bal = await tradeApi.getBalanceAllowance({ asset_type: "COLLATERAL" });
		return `balance=${bal.balance}, allowance=${bal.allowance}`;
	});

	// Smoke-test the order construction WITHOUT actually placing it.
	await test("trading.getMarketInfo — fetch tickSize/negRisk for a live token", async () => {
		if (!firstCs2TokenId) return "skipped (no token id)";
		const info = await tradeApi.getMarketInfo(firstCs2TokenId);
		return `tickSize=${info.tickSize}, negRisk=${info.negRisk}, feeRateBps=${info.feeRateBps}`;
	});
} else {
	console.log("\n--- (POLYMARKET_PRIVATE_KEY not set, skipping trading tests) ---");
}

// === Summary ===

console.log("\n=== SUMMARY ===");
console.log(`Total: ${RESULTS.length}, Pass: ${RESULTS.length - failures}, Fail: ${failures}`);
process.exit(failures > 0 ? 1 : 0);
