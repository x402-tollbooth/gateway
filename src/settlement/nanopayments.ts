import type {
	PaymentRequirementsPayload,
	SettlementInfo,
	SettlementStrategy,
	SettlementVerification,
} from "../types.js";
import { PaymentError } from "../x402/middleware.js";

/**
 * EIP-712 domain name/version used by Circle's GatewayWalletBatched contract.
 * Clients sign `TransferWithAuthorization` against this domain
 * instead of the standard per-token EIP-712 domain.
 *
 * The full extra object (including `verifyingContract`) is discovered at
 * startup via `/v1/x402/supported` and exposed by the settlement instance.
 */
export const NANOPAYMENT_EIP712 = {
	name: "GatewayWalletBatched",
	version: "1",
} as const;

/**
 * Circle Nanopayments Gateway base URLs.
 */
const GATEWAY_URL = {
	testnet: "https://gateway-api-testnet.circle.com",
	mainnet: "https://gateway-api.circle.com",
} as const;

/**
 * Map tollbooth network names to CAIP-2 chain identifiers.
 * Circle Gateway requires CAIP-2 format (e.g. "eip155:84532").
 */
const NETWORK_TO_CAIP2: Record<string, string> = {
	"base-sepolia": "eip155:84532",
	base: "eip155:8453",
	"ethereum-sepolia": "eip155:11155111",
	ethereum: "eip155:1",
	"arbitrum-sepolia": "eip155:421614",
	arbitrum: "eip155:42161",
	"optimism-sepolia": "eip155:11155420",
	optimism: "eip155:10",
	"polygon-amoy": "eip155:80002",
	polygon: "eip155:137",
	"avalanche-fuji": "eip155:43113",
	avalanche: "eip155:43114",
};

export type NanopaymentNetwork = "testnet" | "mainnet";

export interface NanopaymentConfig {
	network?: NanopaymentNetwork;
	url?: string;
}

interface NanopaymentVerification extends SettlementVerification {
	paymentPayload: unknown;
	requirement: PaymentRequirementsPayload;
	requirementIndex: number;
	gatewayUrl: string;
}

interface SupportedKind {
	x402Version: number;
	scheme: string;
	network: string;
	extra?: { name?: string; version?: string; verifyingContract?: string };
}

interface VerifyResponse {
	isValid: boolean;
	invalidReason?: string;
	payer?: string;
}

interface SettleResponse {
	success: boolean;
	payer?: string;
	transaction?: string;
	network?: string;
	errorReason?: string;
}

/**
 * Settlement strategy using Circle Nanopayments (x402 batched settlement).
 *
 * Circle's Gateway batches EIP-3009 `TransferWithAuthorization` signatures
 * into periodic on-chain settlements, enabling gas-free sub-cent USDC
 * transfers.
 *
 * The verify/settle API mirrors the standard x402 facilitator interface
 * so this strategy slots in as a drop-in replacement.
 */
export class NanopaymentSettlement implements SettlementStrategy {
	private readonly gatewayUrl: string;

	/**
	 * Full EIP-712 extra object for 402 responses, including verifyingContract
	 * discovered from `/v1/x402/supported`. Falls back to name+version only
	 * if the supported endpoint is unavailable.
	 */
	eip712Extra: { name: string; version: string; verifyingContract?: string } = {
		...NANOPAYMENT_EIP712,
	};

	constructor(config?: NanopaymentConfig) {
		if (config?.url) {
			this.gatewayUrl = config.url.replace(/\/+$/, "");
		} else {
			const net = config?.network ?? "testnet";
			this.gatewayUrl = GATEWAY_URL[net];
		}
	}

	/**
	 * Discover `verifyingContract` from Circle Gateway's `/v1/x402/supported`
	 * endpoint. Call once after construction; safe to skip (402 responses will
	 * omit verifyingContract and clients must discover it themselves).
	 */
	async init(): Promise<void> {
		try {
			const url = `${this.gatewayUrl}/v1/x402/supported`;
			const res = await fetch(url);
			if (!res.ok) return;
			const data = (await res.json()) as { kinds?: SupportedKind[] };
			const kind = data.kinds?.find(
				(k) =>
					k.extra?.name === NANOPAYMENT_EIP712.name &&
					k.extra?.version === NANOPAYMENT_EIP712.version &&
					k.extra?.verifyingContract,
			);
			if (kind?.extra?.verifyingContract) {
				this.eip712Extra = {
					...NANOPAYMENT_EIP712,
					verifyingContract: kind.extra.verifyingContract,
				};
			}
		} catch {
			// Non-fatal — verifyingContract will be omitted from 402 responses.
		}
	}

	async verify(
		payment: unknown,
		requirements: PaymentRequirementsPayload[],
	): Promise<SettlementVerification> {
		let lastError: PaymentError | null = null;

		for (let i = 0; i < requirements.length; i++) {
			const req = requirements[i];

			const gatewayReq = toGatewayRequirements(req);
			const gatewayPayload = toGatewayPayload(payment, req);

			let result: VerifyResponse;
			try {
				result = await this.callGateway<VerifyResponse>("/v1/x402/verify", {
					paymentPayload: gatewayPayload,
					paymentRequirements: gatewayReq,
				});
			} catch (err) {
				lastError = new PaymentError(
					err instanceof Error
						? err.message
						: `Nanopayment verification failed — unknown error (gateway: ${this.gatewayUrl})`,
					402,
				);
				continue;
			}

			if (!result.isValid) {
				lastError = new PaymentError(
					`Nanopayment verification failed: ${result.invalidReason ?? "unknown reason"}\n  → Gateway: ${this.gatewayUrl}`,
					402,
				);
				continue;
			}

			const verification: NanopaymentVerification = {
				payer: result.payer,
				paymentPayload: payment,
				requirement: req,
				requirementIndex: i,
				gatewayUrl: this.gatewayUrl,
			};
			return verification;
		}

		throw (
			lastError ??
			new PaymentError(
				"Nanopayment verification failed for all payment methods",
				402,
			)
		);
	}

	async settle(verification: SettlementVerification): Promise<SettlementInfo> {
		if (!isNanopaymentVerification(verification)) {
			throw new PaymentError(
				"settle() received a verification not produced by NanopaymentSettlement.verify()",
				500,
			);
		}

		const { paymentPayload, requirement } = verification;
		const gatewayReq = toGatewayRequirements(requirement);
		const gatewayPayload = toGatewayPayload(paymentPayload, requirement);

		let result: SettleResponse;
		try {
			result = await this.callGateway<SettleResponse>("/v1/x402/settle", {
				paymentPayload: gatewayPayload,
				paymentRequirements: gatewayReq,
			});
		} catch (err) {
			throw new PaymentError(
				err instanceof Error
					? err.message
					: `Nanopayment settlement failed — unknown error (gateway: ${this.gatewayUrl})`,
				502,
			);
		}

		if (!result.success) {
			throw new PaymentError(
				`Nanopayment settlement failed: ${result.errorReason ?? "unknown reason"}\n  → Gateway: ${this.gatewayUrl}`,
				502,
			);
		}

		return {
			payer: result.payer ?? verification.payer ?? "",
			amount: requirement.maxAmountRequired,
			transaction: result.transaction ?? "",
			network: result.network ?? requirement.network,
		};
	}

	private async callGateway<T>(path: string, body: unknown): Promise<T> {
		const url = `${this.gatewayUrl}${path}`;

		let response: Response;
		try {
			response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		} catch (err) {
			throw new Error(formatFetchError(path, this.gatewayUrl, err));
		}

		if (!response.ok) {
			throw new Error(
				formatHttpError(
					path,
					this.gatewayUrl,
					response.status,
					response.statusText,
				),
			);
		}

		return (await response.json()) as T;
	}
}

/**
 * Convert tollbooth payment requirements to Circle Gateway v2 format.
 * - Translates network name to CAIP-2 (e.g. "base-sepolia" → "eip155:84532")
 * - Renames `maxAmountRequired` → `amount`
 */
function toGatewayRequirements(
	req: PaymentRequirementsPayload,
): Record<string, unknown> {
	const network = NETWORK_TO_CAIP2[req.network] ?? req.network;
	return {
		scheme: req.scheme,
		network,
		amount: req.maxAmountRequired,
		payTo: req.payTo,
		maxTimeoutSeconds: req.maxTimeoutSeconds,
		asset: req.asset,
		extra: req.extra,
	};
}

/**
 * Enrich the client's payment payload with `resource` and `accepted` fields
 * that Circle Gateway's v2 API requires.
 */
function toGatewayPayload(
	payment: unknown,
	req: PaymentRequirementsPayload,
): unknown {
	const base =
		typeof payment === "object" && payment !== null ? payment : {};
	const network = NETWORK_TO_CAIP2[req.network] ?? req.network;
	return {
		...base,
		// Circle Gateway requires these top-level fields in paymentPayload
		resource: (base as Record<string, unknown>).resource ?? {
			url: req.resource,
			description: req.description,
			mimeType: "application/json",
		},
		accepted: (base as Record<string, unknown>).accepted ?? {
			scheme: req.scheme,
			network,
			amount: req.maxAmountRequired,
			payTo: req.payTo,
			maxTimeoutSeconds: req.maxTimeoutSeconds,
			asset: req.asset,
			extra: req.extra,
		},
	};
}

function isNanopaymentVerification(
	v: SettlementVerification,
): v is NanopaymentVerification {
	return "paymentPayload" in v && "requirement" in v && "gatewayUrl" in v;
}

function formatHttpError(
	operation: string,
	url: string,
	status: number,
	statusText: string,
): string {
	const suggestion =
		status >= 500
			? `Check that the Circle Gateway at ${url} is reachable`
			: `Circle Gateway rejected the request — verify your payment configuration`;
	return `Circle Gateway ${operation} failed (${status} ${statusText})\n  → ${suggestion}`;
}

function formatFetchError(
	operation: string,
	url: string,
	err: unknown,
): string {
	const message = err instanceof Error ? err.message : "unknown error";
	if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
		return `Circle Gateway ${operation} failed — could not connect to ${url}\n  → Check that the gateway URL is correct and the server is running`;
	}
	if (message.includes("ENOTFOUND") || message.includes("getaddrinfo")) {
		return `Circle Gateway ${operation} failed — DNS lookup failed for ${url}\n  → Check that the gateway URL is correct`;
	}
	return `Circle Gateway ${operation} failed — ${message}\n  → Check that the Circle Gateway at ${url} is reachable`;
}
