/// <reference types="jest" />
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

	it('declares a Base URL property with an HTTPS default', () => {
		const baseUrl = creds.properties.find((p) => p.name === 'baseUrl');
		expect(baseUrl).toBeDefined();
		expect(baseUrl?.type).toBe('string');
		expect(typeof baseUrl?.default).toBe('string');
		// Guard against shipping a default that sends the API token over plaintext
		// HTTP or to a localhost address. Self-host users can still override.
		expect(baseUrl?.default).toMatch(/^https:\/\//);
		expect(baseUrl?.default).not.toMatch(/localhost|127\.0\.0\.1/);
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
