import {
	IAuthenticateGeneric,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class AidenixApi implements ICredentialType {
	name = 'aidenixApi';

	displayName = 'Aidenix API';

	documentationUrl = 'https://docs.aidenix.com';

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
			description: 'Base URL of the Aidenix API. Change only if you are on a dedicated tenant.',
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
