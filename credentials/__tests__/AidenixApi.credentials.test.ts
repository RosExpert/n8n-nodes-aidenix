import { AidenixApi } from '../AidenixApi.credentials';

describe('AidenixApi credentials', () => {
	const creds = new AidenixApi();

	it('has the expected internal name and display name', () => {
		expect(creds.name).toBe('aidenixApi');
		expect(creds.displayName).toBe('Aidenix API');
	});

	it('declares an API Token property as a required password field', () => {
		const apiToken = creds.properties.find((p) => p.name === 'apiToken');
		expect(apiToken).toBeDefined();
		expect(apiToken?.type).toBe('string');
		expect(apiToken?.required).toBe(true);
		expect(apiToken?.typeOptions).toMatchObject({ password: true });
	});

	it('declares a Base URL property with a default value', () => {
		const baseUrl = creds.properties.find((p) => p.name === 'baseUrl');
		expect(baseUrl).toBeDefined();
		expect(baseUrl?.type).toBe('string');
		expect(typeof baseUrl?.default).toBe('string');
		expect((baseUrl?.default as string).length).toBeGreaterThan(0);
	});

	it('authenticates by injecting the X-API-Token header', () => {
		expect(creds.authenticate).toMatchObject({
			type: 'generic',
			properties: {
				headers: {
					'X-API-Token': '={{$credentials.apiToken}}',
				},
			},
		});
	});

	it('exposes a documentation URL', () => {
		expect(creds.documentationUrl).toMatch(/^https?:\/\//);
	});
});
