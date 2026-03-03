import type {
	PaymentRequirementsPayload,
	SettlementInfo,
	SettlementStrategy,
	SettlementVerification,
} from "../types.js";
import { PaymentError } from "../x402/middleware.js";

/**
 * EIP-712 domain used by Circle's GatewayWalletBatched contract.
 * Clients sign `TransferWithAuthorization` against this domain
 * instead of the standard per-token EIP-712 domain.
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

	constructor(config?: NanopaymentConfig) {
		if (config?.url) {
			this.gatewayUrl = config.url.replace(/\/+$/, "");
		} else {
			const net = config?.network ?? "testnet";
			this.gatewayUrl = GATEWAY_URL[net];
		}
	}

	async verify(
		payment: unknown,
		requirements: PaymentRequirementsPayload[],
	): Promise<SettlementVerification> {
		let lastError: PaymentError | null = null;

		for (let i = 0; i < requirements.length; i++) {
			const req = requirements[i];

			let result: VerifyResponse;
			try {
				result = await this.callGateway<VerifyResponse>("/verify", {
					paymentPayload: payment,
					paymentRequirements: req,
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

		let result: SettleResponse;
		try {
			result = await this.callGateway<SettleResponse>("/settle", {
				paymentPayload,
				paymentRequirements: requirement,
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
