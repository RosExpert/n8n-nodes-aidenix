import {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
	NodeApiError,
	NodeOperationError,
} from 'n8n-workflow';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';

const IDEMPOTENCY_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const RETRYABLE_STATUSES = new Set([409, 504]);

type IdempotencyStrategy = 'deterministic' | 'random' | 'custom';

interface BusinessFitOptions {
	idempotencyStrategy?: IdempotencyStrategy;
	idempotencyKey?: string;
	maxRetries?: number;
	retryDelayMs?: number;
}

export class Aidenix implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Aidenix',
		name: 'aidenix',
		icon: 'file:aidenix.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] }}',
		description: 'Evaluate business fit and generate outreach with Aidenix AI',
		defaults: {
			name: 'Aidenix',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'aidenixApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Business Fit',
						value: 'businessFit',
						description: 'Evaluate ICP fit for a contact and generate personalized outreach',
						action: 'Evaluate business fit for a contact',
					},
				],
				default: 'businessFit',
			},
			{
				displayName: 'Query',
				name: 'query',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'jane-doe-12345 or jane@example.com',
				description: 'LinkedIn slug or email of the contact to evaluate',
				displayOptions: {
					show: {
						operation: ['businessFit'],
					},
				},
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: {
						operation: ['businessFit'],
					},
				},
				options: [
					{
						displayName: 'Idempotency Key Strategy',
						name: 'idempotencyStrategy',
						type: 'options',
						default: 'deterministic',
						description: 'How the Idempotency-Key header is generated for each item',
						options: [
							{
								name: 'Deterministic (Recommended)',
								value: 'deterministic',
								description:
									'UUID v5 derived from workflow + execution + item index + query. Safe to replay: the server returns the cached response on retry.',
							},
							{
								name: 'Random',
								value: 'random',
								description: 'New UUID v4 per item. Each run forces a fresh computation.',
							},
							{
								name: 'Custom',
								value: 'custom',
								description:
									'Use the value from the "Idempotency Key" field below. Useful when the key comes from an upstream node via an expression.',
							},
						],
					},
					{
						displayName: 'Idempotency Key',
						name: 'idempotencyKey',
						type: 'string',
						default: '',
						placeholder: '={{ $json.idempotency_key }}',
						description:
							'Custom Idempotency-Key value. Only used when "Idempotency Key Strategy" is set to "Custom". Must be unique per logical operation; reuse with the same body returns the cached response.',
						displayOptions: {
							show: {
								'/options.idempotencyStrategy': ['custom'],
							},
						},
					},
					{
						displayName: 'Max Retries (on 409 / 504)',
						name: 'maxRetries',
						type: 'number',
						default: 10,
						typeOptions: {
							minValue: 0,
							maxValue: 50,
						},
						description:
							'How many times to retry when the API returns 409 (still processing) or 504 (timeout)',
					},
					{
						displayName: 'Retry Delay (Ms)',
						name: 'retryDelayMs',
						type: 'number',
						default: 5000,
						typeOptions: {
							minValue: 500,
						},
						description: 'Delay between retries in milliseconds',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const credentials = await this.getCredentials('aidenixApi');
		const baseUrl = ((credentials.baseUrl as string) || 'http://localhost:8080').replace(
			/\/+$/,
			'',
		);
		const apiToken = credentials.apiToken as string;

		const workflowId = String(this.getWorkflow().id ?? 'workflow');
		const executionId = String(this.getExecutionId() ?? 'execution');

		const results: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			const operation = this.getNodeParameter('operation', i) as string;

			if (operation !== 'businessFit') {
				throw new NodeOperationError(this.getNode(), `Unsupported operation: ${operation}`, {
					itemIndex: i,
				});
			}

			const query = ((this.getNodeParameter('query', i) as string) ?? '').trim();
			if (!query) {
				throw new NodeOperationError(
					this.getNode(),
					'The "Query" parameter is required (LinkedIn slug or email).',
					{ itemIndex: i },
				);
			}

			const options = this.getNodeParameter('options', i, {}) as BusinessFitOptions;
			const idempotencyStrategy: IdempotencyStrategy =
				options.idempotencyStrategy ?? 'deterministic';
			const maxRetries = options.maxRetries ?? 10;
			const retryDelayMs = options.retryDelayMs ?? 5000;

			let idempotencyKey: string;
			if (idempotencyStrategy === 'random') {
				idempotencyKey = uuidv4();
			} else if (idempotencyStrategy === 'custom') {
				idempotencyKey = (options.idempotencyKey ?? '').trim();
				if (!idempotencyKey) {
					throw new NodeOperationError(
						this.getNode(),
						'Idempotency Key is required when "Idempotency Key Strategy" is "Custom".',
						{ itemIndex: i },
					);
				}
			} else {
				idempotencyKey = uuidv5(
					`${workflowId}:${executionId}:${i}:${query}`,
					IDEMPOTENCY_NAMESPACE,
				);
			}

			const requestOptions: IHttpRequestOptions = {
				method: 'POST',
				url: `${baseUrl}/api/search/business-fit/run`,
				headers: {
					'X-API-Token': apiToken,
					'Idempotency-Key': idempotencyKey,
					'Content-Type': 'application/json',
					'X-Integration-Source': 'n8n',
				},
				body: { query },
				json: true,
			};

			try {
				const response = await callWithRetry(
					() => this.helpers.httpRequest(requestOptions),
					maxRetries,
					retryDelayMs,
				);

				results.push({
					json: response as IDataObject,
					pairedItem: { item: i },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					results.push({
						json: {
							error: (error as Error).message,
							query,
							idempotencyKey,
						},
						pairedItem: { item: i },
					});
					continue;
				}
				throw new NodeApiError(this.getNode(), error as JsonObject, {
					message: 'Aidenix API request failed',
					itemIndex: i,
				});
			}
		}

		return [results];
	}
}

async function callWithRetry<T>(
	fn: () => Promise<T>,
	maxRetries: number,
	delayMs: number,
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await fn();
		} catch (error) {
			const status = extractStatusCode(error);
			if (status !== undefined && RETRYABLE_STATUSES.has(status) && attempt < maxRetries) {
				await sleep(delayMs);
				continue;
			}
			throw error;
		}
	}
}

function extractStatusCode(error: unknown): number | undefined {
	if (!error || typeof error !== 'object') return undefined;
	const e = error as Record<string, unknown>;

	const candidates: unknown[] = [
		e.httpCode,
		e.statusCode,
		(e.response as Record<string, unknown> | undefined)?.status,
		(e.response as Record<string, unknown> | undefined)?.statusCode,
		(e.cause as Record<string, unknown> | undefined)?.statusCode,
		(
			(e.cause as Record<string, unknown> | undefined)?.response as
				| Record<string, unknown>
				| undefined
		)?.status,
	];

	for (const value of candidates) {
		if (typeof value === 'number') return value;
		if (typeof value === 'string') {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
