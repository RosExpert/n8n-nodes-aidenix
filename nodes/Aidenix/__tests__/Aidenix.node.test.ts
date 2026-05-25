import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { Aidenix } from '../Aidenix.node';

interface MockContextOverrides {
	credentials?: { apiToken?: string; baseUrl?: string };
	items?: Array<Record<string, unknown>>;
	parameters?: Array<{ operation?: string; query?: string; options?: Record<string, unknown> }>;
	workflowId?: string;
	executionId?: string;
	continueOnFail?: boolean;
	httpRequest?: jest.Mock;
}

function createContext(overrides: MockContextOverrides = {}) {
	const credentials = {
		apiToken: 'test-token',
		baseUrl: 'http://localhost:8080',
		...overrides.credentials,
	};
	const items =
		overrides.items?.map((json) => ({ json })) ?? [{ json: {} }];
	const parameters =
		overrides.parameters ?? [{ operation: 'businessFit', query: 'jane@example.com', options: {} }];

	const httpRequest = overrides.httpRequest ?? jest.fn();
	const node = { name: 'Aidenix', type: 'aidenix', typeVersion: 1 };

	const ctx = {
		getInputData: () => items,
		getCredentials: jest.fn().mockResolvedValue(credentials),
		getWorkflow: () => ({ id: overrides.workflowId ?? 'wf-1' }),
		getExecutionId: () => overrides.executionId ?? 'exec-1',
		getNodeParameter: jest.fn((name: string, i: number, fallback?: unknown) => {
			const p = parameters[i] ?? {};
			if (name === 'operation') return p.operation ?? 'businessFit';
			if (name === 'query') return p.query ?? '';
			if (name === 'options') return p.options ?? fallback ?? {};
			return fallback;
		}),
		continueOnFail: () => overrides.continueOnFail ?? false,
		getNode: () => node,
		helpers: { httpRequest },
	};

	return { ctx, httpRequest };
}

async function run(ctx: ReturnType<typeof createContext>['ctx']) {
	const node = new Aidenix();
	return node.execute.call(ctx as never);
}

describe('Aidenix node — happy path', () => {
	it('returns the API response as the item json on 200', async () => {
		const apiResponse = {
			job_id: 'job-uuid',
			status: 'completed',
			query: 'jane@example.com',
			fit_score_pct: 82,
			email_subject: 'Quick question',
		};
		const { ctx, httpRequest } = createContext({
			httpRequest: jest.fn().mockResolvedValue(apiResponse),
		});

		const result = await run(ctx);

		expect(result).toHaveLength(1);
		expect(result[0]).toHaveLength(1);
		expect(result[0][0].json).toEqual(apiResponse);
		expect(httpRequest).toHaveBeenCalledTimes(1);
	});

	it('sends the correct method, URL, headers, and body', async () => {
		const { ctx, httpRequest } = createContext({
			httpRequest: jest.fn().mockResolvedValue({ ok: true }),
			parameters: [{ operation: 'businessFit', query: 'jane@example.com', options: {} }],
		});

		await run(ctx);

		expect(httpRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				method: 'POST',
				url: 'http://localhost:8080/api/search/business-fit/run',
				body: { query: 'jane@example.com' },
				json: true,
				headers: expect.objectContaining({
					'X-API-Token': 'test-token',
					'Content-Type': 'application/json',
					'X-Integration-Source': 'n8n',
					'Idempotency-Key': expect.stringMatching(
						/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
					),
				}),
			}),
		);
	});

	it('strips trailing slashes from baseUrl', async () => {
		const { ctx, httpRequest } = createContext({
			credentials: { apiToken: 't', baseUrl: 'http://localhost:8080///' },
			httpRequest: jest.fn().mockResolvedValue({}),
		});

		await run(ctx);

		expect(httpRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				url: 'http://localhost:8080/api/search/business-fit/run',
			}),
		);
	});

	it('processes multiple items in order', async () => {
		const httpRequest = jest
			.fn()
			.mockResolvedValueOnce({ idx: 0 })
			.mockResolvedValueOnce({ idx: 1 })
			.mockResolvedValueOnce({ idx: 2 });

		const { ctx } = createContext({
			items: [{}, {}, {}],
			parameters: [
				{ operation: 'businessFit', query: 'a', options: {} },
				{ operation: 'businessFit', query: 'b', options: {} },
				{ operation: 'businessFit', query: 'c', options: {} },
			],
			httpRequest,
		});

		const result = await run(ctx);

		expect(result[0].map((r) => r.json)).toEqual([{ idx: 0 }, { idx: 1 }, { idx: 2 }]);
		expect(httpRequest).toHaveBeenCalledTimes(3);
	});
});

describe('Aidenix node — retry behavior', () => {
	it('retries on 409 and succeeds on the next attempt', async () => {
		const httpRequest = jest
			.fn()
			.mockRejectedValueOnce({ httpCode: 409, message: 'in progress' })
			.mockResolvedValueOnce({ ok: true });

		const { ctx } = createContext({
			httpRequest,
			parameters: [
				{
					operation: 'businessFit',
					query: 'x',
					options: { maxRetries: 3, retryDelayMs: 0 },
				},
			],
		});

		const result = await run(ctx);

		expect(httpRequest).toHaveBeenCalledTimes(2);
		expect(result[0][0].json).toEqual({ ok: true });
	});

	it('retries on 504 and succeeds on the next attempt', async () => {
		const httpRequest = jest
			.fn()
			.mockRejectedValueOnce({ response: { status: 504 }, message: 'timeout' })
			.mockResolvedValueOnce({ ok: true });

		const { ctx } = createContext({
			httpRequest,
			parameters: [
				{ operation: 'businessFit', query: 'x', options: { maxRetries: 3, retryDelayMs: 0 } },
			],
		});

		const result = await run(ctx);

		expect(httpRequest).toHaveBeenCalledTimes(2);
		expect(result[0][0].json).toEqual({ ok: true });
	});

	it('reuses the same Idempotency-Key across retries', async () => {
		const httpRequest = jest
			.fn()
			.mockRejectedValueOnce({ httpCode: 409 })
			.mockRejectedValueOnce({ httpCode: 409 })
			.mockResolvedValueOnce({ ok: true });

		const { ctx } = createContext({
			httpRequest,
			parameters: [
				{ operation: 'businessFit', query: 'x', options: { maxRetries: 5, retryDelayMs: 0 } },
			],
		});

		await run(ctx);

		const keys = httpRequest.mock.calls.map((c) => c[0].headers['Idempotency-Key']);
		expect(keys).toHaveLength(3);
		expect(new Set(keys).size).toBe(1);
	});

	it('gives up after maxRetries and throws NodeApiError', async () => {
		const httpRequest = jest.fn().mockRejectedValue({ httpCode: 409, message: 'still busy' });

		const { ctx } = createContext({
			httpRequest,
			parameters: [
				{ operation: 'businessFit', query: 'x', options: { maxRetries: 2, retryDelayMs: 0 } },
			],
		});

		await expect(run(ctx)).rejects.toBeInstanceOf(NodeApiError);
		expect(httpRequest).toHaveBeenCalledTimes(3); // initial + 2 retries
	});

	it('does not retry on non-retryable status (e.g. 402 quota exhausted)', async () => {
		const httpRequest = jest.fn().mockRejectedValue({ httpCode: 402, message: 'quota' });

		const { ctx } = createContext({
			httpRequest,
			parameters: [
				{ operation: 'businessFit', query: 'x', options: { maxRetries: 5, retryDelayMs: 0 } },
			],
		});

		await expect(run(ctx)).rejects.toBeInstanceOf(NodeApiError);
		expect(httpRequest).toHaveBeenCalledTimes(1);
	});

	it('does not retry on 451 (contact opted out)', async () => {
		const httpRequest = jest.fn().mockRejectedValue({ httpCode: 451, message: 'opted out' });

		const { ctx } = createContext({
			httpRequest,
			parameters: [
				{ operation: 'businessFit', query: 'x', options: { maxRetries: 5, retryDelayMs: 0 } },
			],
		});

		await expect(run(ctx)).rejects.toBeInstanceOf(NodeApiError);
		expect(httpRequest).toHaveBeenCalledTimes(1);
	});
});

describe('Aidenix node — continueOnFail', () => {
	it('returns an error item instead of throwing when continueOnFail is true', async () => {
		const httpRequest = jest.fn().mockRejectedValue({
			httpCode: 402,
			message: 'quota exceeded',
		});

		const { ctx } = createContext({
			httpRequest,
			continueOnFail: true,
			parameters: [
				{ operation: 'businessFit', query: 'failing-query', options: { retryDelayMs: 0 } },
			],
		});

		const result = await run(ctx);

		expect(result[0]).toHaveLength(1);
		expect(result[0][0].json).toMatchObject({
			error: expect.any(String),
			query: 'failing-query',
			idempotencyKey: expect.any(String),
		});
	});

	it('continues to the next item after a failure with continueOnFail', async () => {
		const httpRequest = jest
			.fn()
			.mockRejectedValueOnce({ httpCode: 402, message: 'quota' })
			.mockResolvedValueOnce({ ok: true });

		const { ctx } = createContext({
			httpRequest,
			continueOnFail: true,
			items: [{}, {}],
			parameters: [
				{ operation: 'businessFit', query: 'first', options: { retryDelayMs: 0 } },
				{ operation: 'businessFit', query: 'second', options: { retryDelayMs: 0 } },
			],
		});

		const result = await run(ctx);

		expect(result[0]).toHaveLength(2);
		expect(result[0][0].json).toMatchObject({ error: expect.any(String), query: 'first' });
		expect(result[0][1].json).toEqual({ ok: true });
	});
});

describe('Aidenix node — idempotency key strategies', () => {
	it('produces the same deterministic key for same (workflow, execution, index, query)', async () => {
		const httpRequest1 = jest.fn().mockResolvedValue({});
		const httpRequest2 = jest.fn().mockResolvedValue({});

		const params = [
			{ operation: 'businessFit', query: 'same@example.com', options: {} },
		];

		const { ctx: ctxA } = createContext({
			workflowId: 'wf-X',
			executionId: 'exec-Y',
			parameters: params,
			httpRequest: httpRequest1,
		});
		const { ctx: ctxB } = createContext({
			workflowId: 'wf-X',
			executionId: 'exec-Y',
			parameters: params,
			httpRequest: httpRequest2,
		});

		await run(ctxA);
		await run(ctxB);

		expect(httpRequest1.mock.calls[0][0].headers['Idempotency-Key']).toBe(
			httpRequest2.mock.calls[0][0].headers['Idempotency-Key'],
		);
	});

	it('produces different keys for different queries within the same execution', async () => {
		const httpRequest = jest.fn().mockResolvedValue({});

		const { ctx } = createContext({
			items: [{}, {}],
			parameters: [
				{ operation: 'businessFit', query: 'a@example.com', options: {} },
				{ operation: 'businessFit', query: 'b@example.com', options: {} },
			],
			httpRequest,
		});

		await run(ctx);

		const k0 = httpRequest.mock.calls[0][0].headers['Idempotency-Key'];
		const k1 = httpRequest.mock.calls[1][0].headers['Idempotency-Key'];
		expect(k0).not.toBe(k1);
	});

	it('produces a fresh random key per item when strategy is "random"', async () => {
		const httpRequest = jest.fn().mockResolvedValue({});

		const { ctx } = createContext({
			items: [{}, {}],
			parameters: [
				{
					operation: 'businessFit',
					query: 'a',
					options: { idempotencyStrategy: 'random' },
				},
				{
					operation: 'businessFit',
					query: 'a',
					options: { idempotencyStrategy: 'random' },
				},
			],
			httpRequest,
		});

		await run(ctx);

		const k0 = httpRequest.mock.calls[0][0].headers['Idempotency-Key'];
		const k1 = httpRequest.mock.calls[1][0].headers['Idempotency-Key'];
		expect(k0).not.toBe(k1);
	});

	it('uses the user-supplied key when strategy is "custom"', async () => {
		const httpRequest = jest.fn().mockResolvedValue({});
		const customKey = 'my-explicit-uuid-1234';

		const { ctx } = createContext({
			parameters: [
				{
					operation: 'businessFit',
					query: 'q',
					options: { idempotencyStrategy: 'custom', idempotencyKey: customKey },
				},
			],
			httpRequest,
		});

		await run(ctx);

		expect(httpRequest.mock.calls[0][0].headers['Idempotency-Key']).toBe(customKey);
	});

	it('throws NodeOperationError if strategy is "custom" but key is empty', async () => {
		const { ctx } = createContext({
			parameters: [
				{
					operation: 'businessFit',
					query: 'q',
					options: { idempotencyStrategy: 'custom', idempotencyKey: '   ' },
				},
			],
		});

		await expect(run(ctx)).rejects.toBeInstanceOf(NodeOperationError);
	});
});

describe('Aidenix node — input validation', () => {
	it('throws NodeOperationError when query is empty', async () => {
		const { ctx } = createContext({
			parameters: [{ operation: 'businessFit', query: '   ', options: {} }],
		});

		await expect(run(ctx)).rejects.toBeInstanceOf(NodeOperationError);
	});

	it('throws NodeOperationError on unknown operation', async () => {
		const { ctx } = createContext({
			parameters: [{ operation: 'somethingElse', query: 'q', options: {} }],
		});

		await expect(run(ctx)).rejects.toBeInstanceOf(NodeOperationError);
	});
});
