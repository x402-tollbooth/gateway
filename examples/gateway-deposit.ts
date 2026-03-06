/**
 * Deposit USDC into Circle Gateway on Base Sepolia.
 *
 * Nanopayments require a Gateway balance — this script approves and deposits.
 *
 * Usage:
 *   bun run --env-file=.env.test examples/gateway-deposit.ts [amount]
 *
 * Default amount: 1 USDC (plenty for testing at $0.001 per request)
 */
import {
	createPublicClient,
	createWalletClient,
	http,
	parseUnits,
	formatUnits,
	type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as Address;

const ERC20_ABI = [
	{
		name: "balanceOf",
		type: "function",
		stateMutability: "view",
		inputs: [{ name: "account", type: "address" }],
		outputs: [{ name: "", type: "uint256" }],
	},
	{
		name: "allowance",
		type: "function",
		stateMutability: "view",
		inputs: [
			{ name: "owner", type: "address" },
			{ name: "spender", type: "address" },
		],
		outputs: [{ name: "", type: "uint256" }],
	},
	{
		name: "approve",
		type: "function",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "spender", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [{ name: "", type: "bool" }],
	},
] as const;

const GATEWAY_ABI = [
	{
		name: "deposit",
		type: "function",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "token", type: "address" },
			{ name: "value", type: "uint256" },
		],
		outputs: [],
	},
	{
		name: "totalBalance",
		type: "function",
		stateMutability: "view",
		inputs: [
			{ name: "token", type: "address" },
			{ name: "depositor", type: "address" },
		],
		outputs: [{ name: "", type: "uint256" }],
	},
] as const;

// ── Validate env ──────────────────────────────────────────────────────────────

const rawKey = process.env.TEST_PRIVATE_KEY;
if (!rawKey) {
	console.error("Error: TEST_PRIVATE_KEY is required.");
	process.exit(1);
}

const privateKey = (
	rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`
) as `0x${string}`;

const account = privateKeyToAccount(privateKey);
const amount = parseUnits(process.argv[2] ?? "1", 6); // default 1 USDC

const publicClient = createPublicClient({
	chain: baseSepolia,
	transport: http(),
});

const walletClient = createWalletClient({
	account,
	chain: baseSepolia,
	transport: http(),
});

console.log(`\n  Wallet:          ${account.address}`);
console.log(`  Network:         Base Sepolia`);
console.log(`  Amount:          ${formatUnits(amount, 6)} USDC`);
console.log(`  Gateway Wallet:  ${GATEWAY_WALLET}\n`);

// ── Check balances ────────────────────────────────────────────────────────────

const usdcBalance = await publicClient.readContract({
	address: USDC,
	abi: ERC20_ABI,
	functionName: "balanceOf",
	args: [account.address],
});

const gatewayBalance = await publicClient.readContract({
	address: GATEWAY_WALLET,
	abi: GATEWAY_ABI,
	functionName: "totalBalance",
	args: [USDC, account.address],
});

console.log(`  USDC balance:    ${formatUnits(usdcBalance, 6)} USDC`);
console.log(`  Gateway balance: ${formatUnits(gatewayBalance, 6)} USDC\n`);

if (usdcBalance < amount) {
	console.error(
		`Insufficient USDC. Need ${formatUnits(amount, 6)}, have ${formatUnits(usdcBalance, 6)}.`,
	);
	console.error("Fund your wallet at https://faucet.circle.com");
	process.exit(1);
}

// ── Approve ───────────────────────────────────────────────────────────────────

const allowance = await publicClient.readContract({
	address: USDC,
	abi: ERC20_ABI,
	functionName: "allowance",
	args: [account.address, GATEWAY_WALLET],
});

if (allowance < amount) {
	console.log("-- Approving USDC spend... --");
	const approveTx = await walletClient.writeContract({
		address: USDC,
		abi: ERC20_ABI,
		functionName: "approve",
		args: [GATEWAY_WALLET, amount],
	});
	console.log(`  Tx: ${approveTx}`);
	await publicClient.waitForTransactionReceipt({ hash: approveTx });
	console.log("  Confirmed.\n");
} else {
	console.log("  Allowance sufficient, skipping approve.\n");
}

// ── Deposit ───────────────────────────────────────────────────────────────────

console.log("-- Depositing into Gateway... --");
const depositTx = await walletClient.writeContract({
	address: GATEWAY_WALLET,
	abi: GATEWAY_ABI,
	functionName: "deposit",
	args: [USDC, amount],
});
console.log(`  Tx: ${depositTx}`);
await publicClient.waitForTransactionReceipt({ hash: depositTx });

const newGatewayBalance = await publicClient.readContract({
	address: GATEWAY_WALLET,
	abi: GATEWAY_ABI,
	functionName: "totalBalance",
	args: [USDC, account.address],
});

console.log(`\n  Deposit complete!`);
console.log(`  Gateway balance: ${formatUnits(newGatewayBalance, 6)} USDC`);
console.log(
	`\n  View on Basescan: https://sepolia.basescan.org/tx/${depositTx}\n`,
);
