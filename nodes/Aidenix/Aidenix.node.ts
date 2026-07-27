import {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	sleep,
} from 'n8n-workflow';
import { createHash, randomUUID } from 'node:crypto';

const IDEMPOTENCY_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const RETRYABLE_STATUSES = new Set([409, 504]);
const REQUEST_TIMEOUT_MS = 120_000;
const LOOPBACK_HTTP_RE = /^http:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/;

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
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
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
						name: 'Account Context',
						value: 'accountContext',
						description: 'Plan, quota left, and which ICP profile scores are weighted against',
						action: 'Get account context',
					},
					{
						name: 'Batch Results',
						value: 'batchResults',
						description: 'Read the analyses of a batch page by page',
						action: 'Get batch results',
					},
					{
						name: 'Batch Status',
						value: 'batchStatus',
						description: 'How far along a batch is — done, pending, failed, ICP 60+',
						action: 'Get batch status',
					},
					{
						name: 'Build ICP Profile',
						value: 'buildIcpProfile',
						description:
							'Read a website and save it as an ICP profile. The new profile becomes the active one.',
						action: 'Build an ICP profile from a website',
					},
					{
						name: 'Business Fit',
						value: 'businessFit',
						description: 'Evaluate ICP fit for a contact and generate personalized outreach',
						action: 'Evaluate business fit for a contact',
					},
					{
						name: 'Company Signals',
						value: 'companySignals',
						description: 'The company moment behind the lead — momentum, signals, timing',
						action: 'Profile a company',
					},
					{
						name: 'Email Intel',
						value: 'emailIntel',
						description:
							'Check whether an address is worth contacting — mailbox alive, person still there',
						action: 'Assess an email address',
					},
					{
						name: 'Email Intel (Bulk)',
						value: 'emailIntelBulk',
						description: 'The same address check across a whole list, in one call',
						action: 'Assess a list of addresses',
					},
					{
						name: 'ICP Profiles',
						value: 'icpProfiles',
						description: 'The saved ICP profiles and which one is active',
						action: 'List ICP profiles',
					},
					{
						name: 'Person Signals',
						value: 'personSignals',
						description:
							'Who the person is, what they publish, where they are in their career',
						action: 'Profile a person',
					},
					{
						name: 'Record Opt-Out',
						value: 'optOut',
						description: 'Record that a contact asked to be left alone',
						action: 'Record an opt out',
					},
					{
						name: 'Score a List',
						value: 'scoreList',
						description: 'Submit a batch of contacts for scoring and get a batch ID back',
						action: 'Score a list of contacts',
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
				displayName: 'Email',
				name: 'email',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'jane@example.com',
				description: 'Address to assess before anything is written to it',
				displayOptions: {
					show: {
						operation: ['emailIntel'],
					},
				},
			},
			{
				displayName: 'Deliverability',
				name: 'deliverability',
				type: 'boolean',
				default: false,
				description:
					'Whether to add the SMTP layer — does the mailbox accept mail. Slow, and blind on catch-all domains.',
				displayOptions: {
					show: {
						operation: ['emailIntel'],
					},
				},
			},
			{
				displayName: 'Person',
				name: 'person',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'jane@example.com or linkedin.com/in/jane-doe-12345',
				description:
					'Email, LinkedIn URL or slug. Asked by email, the answer carries no name and no profile slug.',
				displayOptions: {
					show: {
						operation: ['personSignals'],
					},
				},
			},
			{
				displayName: 'Company',
				name: 'company',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'example.com',
				description: 'Domain (resolved exactly) or company name (resolved heuristically)',
				displayOptions: {
					show: {
						operation: ['companySignals'],
					},
				},
			},
			{
				displayName: 'Emails',
				name: 'emails',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'one@company.com, two@company.com',
				description:
					'Addresses to assess, separated by commas or newlines. Up to 1000 per call.',
				displayOptions: {
					show: {
						operation: ['emailIntelBulk'],
					},
				},
			},
			{
				displayName: 'Contacts',
				name: 'items',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'jane@example.com, linkedin.com/in/john-doe',
				description:
					'Contacts to score, separated by commas or newlines. Up to 10000 per batch.',
				displayOptions: {
					show: {
						operation: ['scoreList'],
					},
				},
			},
			{
				displayName: 'Batch Name',
				name: 'batchName',
				type: 'string',
				default: '',
				placeholder: 'Q3 outbound',
				description: 'Optional name so the batch is findable later',
				displayOptions: {
					show: {
						operation: ['scoreList'],
					},
				},
			},
			{
				displayName: 'Batch ID',
				name: 'jobId',
				type: 'string',
				default: '',
				required: true,
				placeholder: '={{ $json.job_id }}',
				description: 'The batch ID returned by "Score a List"',
				displayOptions: {
					show: {
						operation: ['batchStatus', 'batchResults'],
					},
				},
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				default: 50,
				typeOptions: {
					minValue: 1,
				},
				description: 'Max number of results to return',
				displayOptions: {
					show: {
						operation: ['batchResults'],
					},
				},
			},
			{
				displayName: 'Cursor',
				name: 'cursor',
				type: 'string',
				default: '',
				placeholder: '={{ $json.next_cursor }}',
				description: 'The next_cursor of the previous page. Leave empty for the first page.',
				displayOptions: {
					show: {
						operation: ['batchResults'],
					},
				},
			},
			{
				displayName: 'Website URL',
				name: 'websiteUrl',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'https://yourcompany.com',
				description:
					'The site to read. The profile built from it becomes the active one, so every later score is weighted by it.',
				displayOptions: {
					show: {
						operation: ['buildIcpProfile'],
					},
				},
			},
			{
				displayName: 'Contact',
				name: 'contact',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'jane@example.com',
				description: 'Email, phone number, or LinkedIn URL to add to the opt-out list',
				displayOptions: {
					show: {
						operation: ['optOut'],
					},
				},
			},
			{
				displayName: 'Relationships',
				name: 'relationships',
				type: 'boolean',
				default: false,
				description:
					'Whether to expand the attention teaser into the full map: organizations the team follows, accounts influencing the buyer, internal amplifiers by role',
				displayOptions: {
					show: {
						operation: ['companySignals'],
					},
				},
			},
			{
				displayName: 'Enrich',
				name: 'enrich',
				type: 'boolean',
				default: false,
				description:
					'Whether to add the enrichment layer. On an address it is the dossier (age, breach exposure, domain reputation, footprint, company). On a company it is the model read of the attention map, and it needs Relationships on. Both are slow.',
				displayOptions: {
					show: {
						operation: ['emailIntel', 'companySignals'],
					},
				},
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Idempotency Key Strategy',
						name: 'idempotencyStrategy',
						type: 'options',
						default: 'deterministic',
						description: 'How the Idempotency-Key header is generated for each item',
						displayOptions: {
							show: {
								'/operation': ['businessFit'],
							},
						},
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
								'/operation': ['businessFit'],
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
		const baseUrl = ((credentials.baseUrl as string) || 'https://api.aidenix.com').replace(
			/\/+$/,
			'',
		);
		const apiToken = credentials.apiToken as string;

		if (baseUrl.startsWith('http://') && !LOOPBACK_HTTP_RE.test(baseUrl)) {
			this.logger.warn(
				`[Aidenix] Base URL "${baseUrl}" is not HTTPS — API token will be transmitted in cleartext.`,
			);
		}

		const workflowId = String(this.getWorkflow().id ?? 'workflow');
		const executionId = String(this.getExecutionId() ?? 'execution');

		const results: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			const operation = this.getNodeParameter('operation', i) as string;

			if (operation !== 'businessFit') {
				// Всё, кроме business fit, идёт одним путём: ни idempotency-ключа, ни склейки job'ов.
				// GET безопасен на повтор по своей природе; POST'ы здесь либо читают (bulk), либо
				// сами по себе идемпотентны (opt-out дважды не создаёт вторую запись).
				const options = this.getNodeParameter('options', i, {}) as BusinessFitOptions;
				const text = (name: string) =>
					((this.getNodeParameter(name, i, '') as string) ?? '').trim();
				const flag = (name: string) => this.getNodeParameter(name, i, false) === true;
				const list = (name: string) =>
					text(name)
						.split(/[\s,;]+/)
						.map((x) => x.trim())
						.filter(Boolean);
				const required = (name: string, label: string) => {
					const v = text(name);
					if (!v) {
						throw new NodeOperationError(this.getNode(), `The "${label}" parameter is required.`, {
							itemIndex: i,
						});
					}
					return v;
				};

				let url: string;
				let method: 'GET' | 'POST' = 'GET';
				let body: IDataObject | undefined;
				if (operation === 'emailIntel') {
					const email = text('email');
					if (!email) {
						throw new NodeOperationError(this.getNode(), 'The "Email" parameter is required.', {
							itemIndex: i,
						});
					}
					url =
						`${baseUrl}/api/email/intel/${encodeURIComponent(email)}` +
						flagsToQuery({ deliverability: flag('deliverability'), enrich: flag('enrich') });
				} else if (operation === 'personSignals') {
					const person = text('person');
					if (!person) {
						throw new NodeOperationError(this.getNode(), 'The "Person" parameter is required.', {
							itemIndex: i,
						});
					}
					url = `${baseUrl}/api/person/signals/${encodeURIComponent(person)}`;
				} else if (operation === 'companySignals') {
					const company = text('company');
					if (!company) {
						throw new NodeOperationError(this.getNode(), 'The "Company" parameter is required.', {
							itemIndex: i,
						});
					}
					url =
						`${baseUrl}/api/company/signals/${encodeURIComponent(company)}` +
						flagsToQuery({ relationships: flag('relationships'), enrich: flag('enrich') });
				} else if (operation === 'emailIntelBulk') {
					const emails = list('emails');
					if (!emails.length) {
						throw new NodeOperationError(this.getNode(), 'The "Emails" parameter is required.', {
							itemIndex: i,
						});
					}
					method = 'POST';
					url = `${baseUrl}/api/email/intel/bulk`;
					body = { emails, deliverability: flag('deliverability'), enrich: flag('enrich') };
				} else if (operation === 'scoreList') {
					const contacts = list('items');
					if (!contacts.length) {
						throw new NodeOperationError(this.getNode(), 'The "Contacts" parameter is required.', {
							itemIndex: i,
						});
					}
					method = 'POST';
					url = `${baseUrl}/api/search/business-fit/batch/submit`;
					body = { items: contacts };
					const batchName = text('batchName');
					if (batchName) body.name = batchName;
				} else if (operation === 'batchStatus') {
					const jobId = required('jobId', 'Batch ID');
					url = `${baseUrl}/api/search/business-fit/batch/${encodeURIComponent(jobId)}`;
				} else if (operation === 'batchResults') {
					const jobId = required('jobId', 'Batch ID');
					const params = new URLSearchParams();
					const limit = this.getNodeParameter('limit', i, 0) as number;
					if (limit) params.set('limit', String(limit));
					const cursor = text('cursor');
					if (cursor) params.set('cursor', cursor);
					const qs = params.toString();
					url =
						`${baseUrl}/api/search/business-fit/batch/${encodeURIComponent(jobId)}/results` +
						(qs ? `?${qs}` : '');
				} else if (operation === 'accountContext') {
					url = `${baseUrl}/api/users/me/context`;
				} else if (operation === 'icpProfiles') {
					url = `${baseUrl}/api/users/me/icp-profiles`;
				} else if (operation === 'buildIcpProfile') {
					method = 'POST';
					url = `${baseUrl}/api/website-parser/parse`;
					body = { website_url: required('websiteUrl', 'Website URL') };
				} else if (operation === 'optOut') {
					const contact = required('contact', 'Contact');
					method = 'POST';
					url = `${baseUrl}/api/opt_out/add?contact=${encodeURIComponent(contact)}`;
				} else {
					throw new NodeOperationError(this.getNode(), `Unsupported operation: ${operation}`, {
						itemIndex: i,
					});
				}

				try {
					const response = await callWithRetry(
						() =>
							this.helpers.httpRequest({
								method,
								...(body ? { body } : {}),
								url,
								headers: {
									'X-API-Token': apiToken,
									'X-Integration-Source': 'n8n',
								},
								json: true,
								timeout: REQUEST_TIMEOUT_MS,
							}),
						options.maxRetries ?? 10,
						options.retryDelayMs ?? 5000,
					);
					results.push({ json: response as IDataObject, pairedItem: { item: i } });
				} catch (error) {
					if (this.continueOnFail()) {
						results.push({
							json: { error: (error as Error).message, url },
							pairedItem: { item: i },
						});
						continue;
					}
					throw new NodeApiError(this.getNode(), error as JsonObject, {
						message: 'Aidenix API request failed',
						description: (error as Error).message,
						itemIndex: i,
					});
				}
				continue;
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
				idempotencyKey = randomUUID();
			} else if (idempotencyStrategy === 'custom') {
				idempotencyKey = (options.idempotencyKey ?? '').trim();
				if (!idempotencyKey) {
					throw new NodeOperationError(
						this.getNode(),
						'Idempotency Key is required when "Idempotency Key Strategy" is "Custom".',
						{ itemIndex: i },
					);
				}
				if (idempotencyKey.length > 255) {
					throw new NodeOperationError(
						this.getNode(),
						`Idempotency Key is too long (max 255 chars, got ${idempotencyKey.length}).`,
						{ itemIndex: i },
					);
				}
				// eslint-disable-next-line no-control-regex -- intentional: validate idempotency key contains no control chars
				if (/[\r\n\x00-\x1F]/.test(idempotencyKey)) {
					throw new NodeOperationError(
						this.getNode(),
						'Idempotency Key must not contain control characters.',
						{ itemIndex: i },
					);
				}
			} else {
				idempotencyKey = uuidV5FromString(
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
				timeout: REQUEST_TIMEOUT_MS,
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
					description: (error as Error).message,
					itemIndex: i,
				});
			}
		}

		return [results];
	}
}

// Флаги передаём только когда они включены: выключенный флаг — это отсутствие параметра,
// а не `?enrich=false`, иначе URL в логах читается как «просили обогащение».
function flagsToQuery(flags: Record<string, boolean>): string {
	const on = Object.entries(flags)
		.filter(([, value]) => value)
		.map(([name]) => `${name}=true`);
	return on.length ? `?${on.join('&')}` : '';
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
			// eslint-disable-next-line @n8n/community-nodes/require-node-api-error -- internal retry helper; caller wraps as NodeApiError
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

function uuidV5FromString(name: string, namespace: string): string {
	const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
	const hash = createHash('sha1').update(nsBytes).update(name).digest();
	const bytes = Buffer.from(hash.subarray(0, 16));
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
