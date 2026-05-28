import { IAuthenticateGeneric, ICredentialType, INodeProperties } from 'n8n-workflow';

export class AidenixApi implements ICredentialType {
	name = 'aidenixApi';

	displayName = 'Aidenix API';

	documentationUrl = 'https://aidenix.com/api';

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
}
