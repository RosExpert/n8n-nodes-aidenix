import {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

export class AidenixApi implements ICredentialType {
	name = 'aidenixApi';

	displayName = 'Aidenix API';

	documentationUrl = 'https://aidenix.com/api';

	icon: Icon = 'file:aidenix.svg';

	properties: INodeProperties[] = [
		{
			displayName: 'API Token',
			name: 'apiToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'API token issued in the Aidenix dashboard.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.aidenix.com',
			placeholder: 'https://api.aidenix.com',
			description: 'Base URL of the Aidenix API. Override only for self-hosted or dedicated tenants.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'X-API-Token': '={{$credentials.apiToken}}',
			},
		},
	};

	// Powers the "Test" button in the credential modal. Hits a lightweight
	// validation endpoint that returns 200 on a valid token, 401 otherwise.
	// No quota is consumed and no jobs are dispatched — unlike running
	// /business-fit/run as a probe, which would burn quota on every click.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/api/check-token',
			method: 'GET',
		},
	};
}
