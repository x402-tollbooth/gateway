/**
 * E2E nanopayment test — exercises the full x402 payment cycle using
 * Circle's Nanopayments (batched settlement) on Base Sepolia.
 *
 * Flow: GET /weather → 402 → sign GatewayWalletBatched EIP-712 → resend → 200
 *
 * Prerequisites:
 *   1. npm install viem  (or bun add viem)
 *   2. Fund a wallet with testnet USDC on Base Sepolia (https://faucet.circle.com)
 *   3. Deposit USDC into Circle Gateway (via GatewayClient or manually)
 *   4. Start dummy-api:  bun run examples/dummy-api.ts
 *   5. Start tollbooth:
 *        bun run --env-file=.env.test src/cli.ts start --config=examples/tollbooth.config.nanopayments.yaml
 *
 * Run:
 *   bun run --env-file=.env.test examples/e2e-nanopayment.ts
 */
import { randomBytes } from "node:crypto";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE = process.env.TOLLBOOTH_URL ?? "http://localhost:3000";

// ── Validate env ──────────────────────────────────────────────────────────────

const rawKey = process.env.TEST_PRIVATE_KEY;
if (!rawKey) {
	console.error("Error: TEST_PRIVATE_KEY is required.");
	console.error(
		"Usage: bun run --env-file=.env.test examples/e2e-nanopayment.ts",
	);
	process.exit(1);
}

const privateKey = (
	rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`
) as `0x${string}`;

const account = privateKeyToAccount(privateKey);

console.log(`\n  Payer wallet:   ${account.address}`);
console.log(`  Network:        Base Sepolia (chain ${baseSepolia.id})`);
console.log(`  Gateway:        ${BASE}\n`);

// ── Step 1: Initial request → 402 ────────────────────────────────────────────

console.log("-- Step 1: GET /weather (expect 402) --");

const res1 = await fetch(`${BASE}/weather`);

if (res1.status !== 402) {
	console.error(
		`Expected 402, got ${res1.status}. Is tollbooth running on ${BASE}?`,
	);
	const body = await res1.text();
	if (body) console.error("Body:", body);
	process.exit(1);
}

const paymentRequiredHeader = res1.headers.get("payment-required");
if (!paymentRequiredHeader) {
	console.error("Missing payment-required header in 402 response.");
	process.exit(1);
}

interface PaymentRequirement {
	scheme: string;
	network: string;
	maxAmountRequired: string;
	resource: string;
	description: string;
	payTo: string;
	maxTimeoutSeconds: number;
	asset: string;
	extra?: { name: string; version: string; verifyingContract?: string };
}

const requirements = JSON.parse(
	atob(paymentRequiredHeader),
) as PaymentRequirement[];
const req = requirements[0];

if (!req) {
	console.error("No payment requirements found in 402 response.");
	process.exit(1);
}

console.log("  Got 402 with payment requirements:");
console.log(`  scheme:             ${req.scheme}`);
console.log(`  network:            ${req.network}`);
console.log(`  asset:              ${req.asset}`);
console.log(
	`  maxAmountRequired:  ${req.maxAmountRequired} (${Number(req.maxAmountRequired) / 1_000_000} USDC)`,
);
console.log(`  payTo:              ${req.payTo}`);
console.log(`  extra.name:         ${req.extra?.name}`);
console.log(`  extra.version:      ${req.extra?.version}`);
console.log(`  extra.verifying:    ${req.extra?.verifyingContract}`);

if (req.extra?.name !== "GatewayWalletBatched") {
	console.error(
		`Expected GatewayWalletBatched domain, got: ${req.extra?.name}`,
	);
	console.error(
		"Is tollbooth configured with settlement.strategy: nanopayments?",
	);
	process.exit(1);
}

// ── Step 2: Sign the payment ──────────────────────────────────────────────────
//
// Nanopayments use EIP-3009 TransferWithAuthorization signed against the
// GatewayWalletBatched EIP-712 domain (instead of the per-token domain).

console.log(
	"\n-- Step 2: Sign EIP-3009 with GatewayWalletBatched domain --",
);

// The verifyingContract should be in the 402 response extra field.
// Fall back to the well-known testnet address if not present.
const verifyingContract =
	req.extra?.verifyingContract ??
	"0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

const walletClient = createWalletClient({
	account,
	chain: baseSepolia,
	transport: http(),
});

const validBefore = Math.floor(Date.now() / 1000) + req.maxTimeoutSeconds;
const nonce = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;

const signature = await walletClient.signTypedData({
	domain: {
		name: "GatewayWalletBatched",
		version: "1",
		chainId: baseSepolia.id,
		verifyingContract: verifyingContract as `0x${string}`,
	},
	types: {
		TransferWithAuthorization: [
			{ name: "from", type: "address" },
			{ name: "to", type: "address" },
			{ name: "value", type: "uint256" },
			{ name: "validAfter", type: "uint256" },
			{ name: "validBefore", type: "uint256" },
			{ name: "nonce", type: "bytes32" },
		],
	},
	primaryType: "TransferWithAuthorization",
	message: {
		from: account.address,
		to: req.payTo as `0x${string}`,
		value: BigInt(req.maxAmountRequired),
		validAfter: 0n,
		validBefore: BigInt(validBefore),
		nonce,
	},
});

const paymentPayload = {
	x402Version: 2,
	scheme: req.scheme,
	network: req.network,
	payload: {
		signature,
		authorization: {
			from: account.address,
			to: req.payTo,
			value: req.maxAmountRequired,
			validAfter: "0",
			validBefore: validBefore.toString(),
			nonce,
		},
	},
};

const paymentSignatureHeader = btoa(JSON.stringify(paymentPayload));

console.log("  Payment signed:");
console.log(`  from:              ${account.address}`);
console.log(`  to:                ${req.payTo}`);
console.log(
	`  value:             ${req.maxAmountRequired} (${Number(req.maxAmountRequired) / 1_000_000} USDC)`,
);
console.log(
	`  validBefore:       ${new Date(validBefore * 1000).toISOString()}`,
);
console.log(`  verifyingContract: ${verifyingContract}`);

// ── Step 3: Resend with payment-signature → 200 ───────────────────────────────

console.log(
	"\n-- Step 3: Resend GET /weather + payment-signature (expect 200) --",
);

const res2 = await fetch(`${BASE}/weather`, {
	headers: { "payment-signature": paymentSignatureHeader },
});

console.log(`Status: ${res2.status}`);

if (res2.status !== 200) {
	const body = await res2.text();
	console.error(`\nExpected 200, got ${res2.status}`);
	console.error("Body:", body);
	console.error("\nCommon causes:");
	console.error(
		"  - No Gateway balance (deposit USDC via Circle Gateway first)",
	);
	console.error("  - Insufficient USDC balance (fund at https://faucet.circle.com)");
	console.error("  - Wrong verifyingContract address");
	console.error("  - Circle Gateway testnet is unreachable");
	process.exit(1);
}

// ── Step 4: Verify payment-response header ────────────────────────────────────

console.log("\n-- Step 4: Verify payment-response header --");

const paymentResponseHeader = res2.headers.get("payment-response");
if (!paymentResponseHeader) {
	console.error("Missing payment-response header in 200 response.");
	process.exit(1);
}

interface PaymentResponse {
	transaction?: string;
	network?: string;
	payer?: string;
	amount?: string;
}

const paymentResponse = JSON.parse(
	atob(paymentResponseHeader),
) as PaymentResponse;

const body = (await res2.json()) as unknown;

console.log("\n  E2E nanopayment test passed!");
console.log(
	"--------------------------------------------------------------",
);
console.log(`  Settlement ID:  ${paymentResponse.transaction || "(pending)"}`);
console.log(`  Network:        ${paymentResponse.network}`);
console.log(`  Payer:          ${paymentResponse.payer}`);
console.log(`  Amount:         ${paymentResponse.amount} raw units`);
console.log(
	"--------------------------------------------------------------",
);
console.log(
	"\n  Note: Nanopayments are batched — the settlement ID is a Circle",
);
console.log(
	"  internal reference, not an on-chain tx hash. The actual on-chain",
);
console.log("  settlement happens when Circle batches multiple payments.");
console.log("\nAPI response:");
console.log(JSON.stringify(body, null, 2));
